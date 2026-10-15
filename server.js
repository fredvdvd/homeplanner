'use strict';
/*
 * Day Planner server: zero npm dependencies.
 * Needs Node 22.13+ (built-in node:sqlite).
 *
 * Users sign in with Google. Everyone on ALLOWED_EMAILS shares one task board.
 * Each user's own Google Calendar is kept in sync with their tasks.
 *
 * Env:
 *   GOOGLE_CLIENT_ID      required. OAuth web client id.
 *   GOOGLE_CLIENT_SECRET  required.
 *   PUBLIC_URL            required. e.g. https://planner.example.com (no trailing slash).
 *                         Redirect URI to register: PUBLIC_URL/auth/google/callback
 *   ALLOWED_EMAILS        required. Comma-separated Google emails that may sign in.
 *   PORT                  default 3000
 *   DATA_DIR              default ./data (SQLite file lives here)
 *   SESSION_SECRET        recommended. Signs sessions and encrypts Google refresh tokens.
 *                         A random one is generated and stored in the DB if unset.
 *   COOKIE_SECURE         "true" to always mark the session cookie Secure (use behind HTTPS)
 *   TRUST_PROXY           "true" to trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy
 *   SESSION_DAYS          default 30
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'planner_session';
const OAUTH_COOKIE = 'planner_oauth';

const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ALLOWED = new Set((process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const REDIRECT_URI = PUBLIC_URL + '/auth/google/callback';
const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ');

if (!GOOGLE_ID || !GOOGLE_SECRET || !/^https?:\/\//.test(PUBLIC_URL) || !ALLOWED.size) {
  console.error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL and ALLOWED_EMAILS must all be set.');
  process.exit(1);
}

/* ---------- database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'planner.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS tasks (
    id    TEXT PRIMARY KEY,
    pos   INTEGER NOT NULL,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    col   TEXT NOT NULL,
    prio  INTEGER NOT NULL DEFAULT 0,
    date  TEXT,
    start INTEGER,
    dur   INTEGER NOT NULL DEFAULT 60
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    refresh_enc TEXT,
    tz          TEXT NOT NULL DEFAULT 'UTC',
    cal_target  TEXT NOT NULL DEFAULT 'primary',
    cal_show    TEXT NOT NULL DEFAULT '["primary"]'
  );
  INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');
`);
{
  const have = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));
  if (!have.has('owner_id')) db.exec('ALTER TABLE tasks ADD COLUMN owner_id INTEGER');
  if (!have.has('event_id')) db.exec('ALTER TABLE tasks ADD COLUMN event_id TEXT');
  if (!have.has('event_cal')) db.exec('ALTER TABLE tasks ADD COLUMN event_cal TEXT');
}

const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let row = getMeta.get('session_secret');
  if (!row) {
    setMeta.run('session_secret', crypto.randomBytes(32).toString('hex'));
    row = getMeta.get('session_secret');
  }
  return row.value;
}
const SECRET = secret();
const TOKEN_KEY = crypto.createHash('sha256').update('refresh-token-key:' + SECRET).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const version = () => parseInt(getMeta.get('version').value, 10);
const readTasks = () => db.prepare('SELECT id, title, notes, col, prio, date, start, dur FROM tasks ORDER BY pos').all();

const COLS = new Set(['backlog', 'next', 'doing', 'done']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TASKS = 5000;

function cleanTask(t) {
  if (!t || typeof t !== 'object') return null;
  const id = typeof t.id === 'string' ? t.id.slice(0, 64) : '';
  const title = typeof t.title === 'string' ? t.title.trim().slice(0, 200) : '';
  if (!id || !title) return null;
  const col = COLS.has(t.col) ? t.col : 'backlog';
  const prio = [0, 1, 2].includes(t.prio) ? t.prio : 0;
  const date = typeof t.date === 'string' && DATE_RE.test(t.date) ? t.date : null;
  let start = Number.isInteger(t.start) && t.start >= 0 && t.start < 1440 ? t.start : null;
  if (!date) start = null;
  const dur = Number.isInteger(t.dur) && t.dur >= 5 && t.dur <= 1440 ? t.dur : 60;
  const notes = typeof t.notes === 'string' ? t.notes.slice(0, 5000) : '';
  return { id, title, notes, col, prio, date, start, dur };
}

const FIELDS = ['title', 'notes', 'col', 'prio', 'date', 'start', 'dur'];

function applyTasks(tasks, userId) {
  const existing = new Map(db.prepare('SELECT * FROM tasks').all().map((r) => [r.id, r]));
  const upsert = db.prepare(`
    INSERT INTO tasks (id, pos, title, notes, col, prio, date, start, dur, owner_id) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET pos = excluded.pos, title = excluded.title, notes = excluded.notes,
      col = excluded.col, prio = excluded.prio, date = excluded.date, start = excluded.start, dur = excluded.dur`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const seen = new Set();
    const touched = [];
    let pos = 0;
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const old = existing.get(t.id);
      if (!old || FIELDS.some((f) => old[f] !== t[f])) touched.push(t.id);
      upsert.run(t.id, pos++, t.title, t.notes, t.col, t.prio, t.date, t.start, t.dur, userId);
    }
    const removed = [];
    const del = db.prepare('DELETE FROM tasks WHERE id = ?');
    for (const [id, old] of existing) {
      if (!seen.has(id)) { removed.push(old); del.run(id); }
    }
    const v = version() + 1;
    setMeta.run('version', String(v));
    db.exec('COMMIT');
    return { version: v, touched, removed };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ---------- sessions ---------- */
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function makeToken(userId) {
  const body = userId + '.' + (Date.now() + SESSION_DAYS * 864e5);
  return body + '.' + sign(body);
}
function tokenUserId(token) {
  if (typeof token !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.([0-9a-f]+)$/.exec(token);
  if (!m || Number(m[2]) < Date.now()) return null;
  return safeEq(m[3], sign(m[1] + '.' + m[2])) ? Number(m[1]) : null;
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
function currentUser(req) {
  const id = tokenUserId(cookies(req)[COOKIE]);
  return id ? getUser.get(id) || null : null;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function isHttps(req) {
  return COOKIE_SECURE || PUBLIC_URL.startsWith('https://') || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}
// Lax, not Strict: the session cookie is set while returning from Google (a cross-site
// navigation), and Strict cookies are not sent on the redirect that follows.
const cookieStr = (req, name, value, maxAge, p = '/') =>
  `${name}=${value}; Path=${p}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

const fails = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 8;
function throttled(ip) {
  const now = Date.now();
  const rec = (fails.get(ip) || []).filter((t) => now - t < WINDOW);
  fails.set(ip, rec);
  return rec.length >= MAX_FAILS;
}
function noteFail(ip) {
  const rec = fails.get(ip) || [];
  rec.push(Date.now());
  fails.set(ip, rec);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of fails) {
    const keep = rec.filter((t) => now - t < WINDOW);
    keep.length ? fails.set(ip, keep) : fails.delete(ip);
  }
}, 10 * 60 * 1000).unref();

/* ---------- google ---------- */
const accessTokens = new Map(); // userId -> { token, exp }
const calError = new Map();     // userId -> last sync error message

async function googleToken(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

async function accessToken(user) {
  const cached = accessTokens.get(user.id);
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  if (!user.refresh_enc) throw new Error('Google Calendar not connected');
  const { ok, data } = await googleToken({ grant_type: 'refresh_token', refresh_token: decrypt(user.refresh_enc) });
  if (!ok) {
    if (data.error === 'invalid_grant') {
      db.prepare('UPDATE users SET refresh_enc = NULL WHERE id = ?').run(user.id);
      user.refresh_enc = null;
      accessTokens.delete(user.id);
      throw new Error('Google access was revoked. Sign in again to reconnect.');
    }
    throw new Error('Google token refresh failed: ' + (data.error || 'unknown'));
  }
  accessTokens.set(user.id, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

async function calApi(user, method, apiPath, body) {
  const token = await accessToken(user);
  const r = await fetch('https://www.googleapis.com/calendar/v3' + apiPath, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { status: r.status, data };
}

const pad = (n) => (n < 10 ? '0' : '') + n;
const hmStr = (min) => pad(Math.floor(min / 60)) + ':' + pad(min % 60);

function eventBody(row, tz) {
  const [y, m, d] = row.date.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d) + (row.start + row.dur) * 60000).toISOString().slice(0, 19);
  return {
    summary: row.title,
    description: row.notes,
    start: { dateTime: `${row.date}T${hmStr(row.start)}:00`, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
    extendedProperties: { private: { plannerTaskId: row.id } },
  };
}

const evPath = (cal, id) => `/calendars/${encodeURIComponent(cal)}/events` + (id ? '/' + encodeURIComponent(id) : '');

async function deleteEvent(user, cal, eventId) {
  const r = await calApi(user, 'DELETE', evPath(cal, eventId));
  if (r.status >= 400 && r.status !== 404 && r.status !== 410) throw new Error('Calendar delete failed (' + r.status + ')');
}

async function syncTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row || !row.owner_id) return;
  const user = getUser.get(row.owner_id);
  if (!user || !user.refresh_enc) return;
  const want = row.date && row.start != null && row.col !== 'done';
  const setEvent = db.prepare('UPDATE tasks SET event_id = ?, event_cal = ? WHERE id = ?');

  if (!want) {
    if (row.event_id) {
      await deleteEvent(user, row.event_cal || user.cal_target, row.event_id);
      setEvent.run(null, null, id);
    }
    return;
  }
  const body = eventBody(row, user.tz);
  if (row.event_id) {
    const cal = row.event_cal || user.cal_target;
    const r = await calApi(user, 'PATCH', evPath(cal, row.event_id), body);
    if (r.status < 300) return;
    if (r.status !== 404 && r.status !== 410) throw new Error('Calendar update failed (' + r.status + ')');
  }
  const r = await calApi(user, 'POST', evPath(user.cal_target), body);
  if (r.status >= 300 || !r.data || !r.data.id) throw new Error('Calendar create failed (' + r.status + ')');
  setEvent.run(r.data.id, user.cal_target, id);
}

// One sync at a time, in order; a failure is logged and shown to the user, never blocks saving.
let syncChain = Promise.resolve();
function enqueueSync({ touched, removed }) {
  const step = async (fn, userId) => {
    try { await fn(); calError.delete(userId); }
    catch (e) { console.error('calendar sync:', e.message); calError.set(userId, e.message); }
  };
  for (const id of touched) {
    const owner = db.prepare('SELECT owner_id FROM tasks WHERE id = ?').get(id);
    syncChain = syncChain.then(() => step(() => syncTask(id), owner && owner.owner_id));
  }
  for (const row of removed) {
    if (!row.event_id || !row.owner_id) continue;
    syncChain = syncChain.then(() => step(async () => {
      const user = getUser.get(row.owner_id);
      if (user && user.refresh_enc) await deleteEvent(user, row.event_cal || user.cal_target, row.event_id);
    }, row.owner_id));
  }
}

/* ---------- calendar reads ---------- */
const formatters = new Map();
function localMinutes(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 60000;
}
const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return typeof tz === 'string'; } catch { return false; } };

async function eventsForDay(user, date) {
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = Date.UTC(y, m - 1, d) / 60000;
  const dayEnd = dayStart + 1440;
  const qs = new URLSearchParams({
    singleEvents: 'true', orderBy: 'startTime', maxResults: '100',
    timeMin: new Date(Date.UTC(y, m - 1, d - 1)).toISOString(),
    timeMax: new Date(Date.UTC(y, m - 1, d + 2)).toISOString(),
    fields: 'items(id,summary,status,start,end,transparency,extendedProperties)',
  });
  let cals;
  try { cals = JSON.parse(user.cal_show); } catch { cals = []; }
  if (!Array.isArray(cals) || !cals.length) cals = [user.cal_target];

  let failed = 0;
  const lists = await Promise.all(cals.slice(0, 20).map(async (cal) => {
    try {
      const r = await calApi(user, 'GET', evPath(cal) + '?' + qs);
      if (r.status !== 200 || !r.data) { failed++; return []; }
      return r.data.items || [];
    } catch { failed++; return []; }
  }));

  const out = [];
  for (const ev of lists.flat()) {
    if (ev.status === 'cancelled') continue;
    if (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.plannerTaskId) continue;
    const title = ev.summary || '(no title)';
    if (ev.start && ev.start.date) {
      const s = Date.parse(ev.start.date + 'T00:00:00Z') / 60000, e = Date.parse((ev.end && ev.end.date || ev.start.date) + 'T00:00:00Z') / 60000;
      if (s < dayEnd && e > dayStart) out.push({ id: ev.id, title, allDay: true });
    } else if (ev.start && ev.start.dateTime && ev.end && ev.end.dateTime) {
      const s = localMinutes(Date.parse(ev.start.dateTime), user.tz), e = localMinutes(Date.parse(ev.end.dateTime), user.tz);
      if (s < dayEnd && e > dayStart) out.push({ id: ev.id, title, allDay: false, start: Math.max(s - dayStart, 0), end: Math.min(e - dayStart, 1440) });
    }
  }
  return { events: out, failed };
}

/* ---------- http helpers ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const redirect = (res, to, headers = {}) => send(res, 302, '', { Location: to, ...headers });
const message = (res, status, text) => send(res, status, `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Day Planner</title><body style="font-family:system-ui;max-width:420px;margin:18vh auto;padding:0 20px"><p>${text}</p><p><a href="/">Back</a></p>`, { 'Content-Type': 'text/html; charset=utf-8' });

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/login.css': ['login.css', 'text/css; charset=utf-8'],
};
function serveFile(res, file, type) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': type });
  });
}

/* ---------- routes ---------- */
async function handleGoogleCallback(req, res, url) {
  const ip = clientIp(req);
  const clear = cookieStr(req, OAUTH_COOKIE, '', 0, '/auth');
  if (throttled(ip)) return message(res, 429, 'Too many attempts. Try again in 15 minutes.');
  const fail = (status, text) => { noteFail(ip); return send(res, status, `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Day Planner</title><body style="font-family:system-ui;max-width:420px;margin:18vh auto;padding:0 20px"><p>${text}</p><p><a href="/">Back</a></p>`, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': clear }); };

  const state = url.searchParams.get('state') || '';
  const want = cookies(req)[OAUTH_COOKIE] || '';
  if (!state || !want || !safeEq(state, want)) return fail(400, 'Sign-in expired or invalid. Please try again.');
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) return fail(400, 'Google sign-in was cancelled.');

  const tok = await googleToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  if (!tok.ok || !tok.data.access_token) return fail(400, 'Google sign-in failed.');
  const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok.data.access_token } });
  const info = ui.ok ? await ui.json().catch(() => null) : null;
  const email = info && typeof info.email === 'string' ? info.email.toLowerCase() : '';
  if (!email || info.email_verified !== true) return fail(400, 'Google did not return a verified email.');
  if (!ALLOWED.has(email)) return fail(403, 'This Google account is not allowed to use this planner.');

  const calendarGranted = String(tok.data.scope || '').split(' ').includes('https://www.googleapis.com/auth/calendar.events');
  const refresh = calendarGranted && tok.data.refresh_token ? encrypt(tok.data.refresh_token) : null;
  db.prepare(`INSERT INTO users (email, name, refresh_enc) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET name = excluded.name,
      refresh_enc = CASE WHEN ? THEN excluded.refresh_enc ELSE refresh_enc END`)
    .run(email, String(info.name || '').slice(0, 100), refresh, calendarGranted ? 1 : 0);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  accessTokens.delete(user.id);
  fails.delete(ip);
  const headers = [cookieStr(req, COOKIE, makeToken(user.id), SESSION_DAYS * 86400), clear];
  return redirect(res, '/', { 'Set-Cookie': headers });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && STATIC[p]) return serveFile(res, ...STATIC[p]);

    if (req.method === 'GET' && p === '/auth/google') {
      const state = crypto.randomBytes(16).toString('hex');
      const q = new URLSearchParams({
        client_id: GOOGLE_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES,
        access_type: 'offline', prompt: 'consent', state,
      });
      return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + q, {
        'Set-Cookie': cookieStr(req, OAUTH_COOKIE, state, 600, '/auth'),
      });
    }
    if (req.method === 'GET' && p === '/auth/google/callback') return handleGoogleCallback(req, res, url);

    const user = currentUser(req);

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return user ? serveFile(res, 'index.html', 'text/html; charset=utf-8')
                  : serveFile(res, 'login.html', 'text/html; charset=utf-8');
    }

    // Mutations must be JSON: a cross-site form post cannot send this content type.
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(res, 415, { error: 'Content-Type must be application/json' });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieStr(req, COOKIE, '', 0) });
    }

    if (!user) return json(res, 401, { error: 'Not signed in' });

    if (p === '/api/me' && req.method === 'GET') {
      let show;
      try { show = JSON.parse(user.cal_show); } catch { show = []; }
      return json(res, 200, {
        email: user.email, name: user.name, tz: user.tz,
        calendar: { connected: !!user.refresh_enc, target: user.cal_target, show, error: calError.get(user.id) || null },
      });
    }

    if (p === '/api/me/settings' && req.method === 'POST') {
      const body = await readBody(req, 8192);
      if (body.tz !== undefined) {
        if (!validTz(body.tz)) return json(res, 400, { error: 'Invalid time zone' });
        db.prepare('UPDATE users SET tz = ? WHERE id = ?').run(body.tz, user.id);
      }
      if (body.calTarget !== undefined) {
        if (typeof body.calTarget !== 'string' || !body.calTarget || body.calTarget.length > 256) return json(res, 400, { error: 'Invalid calendar' });
        db.prepare('UPDATE users SET cal_target = ? WHERE id = ?').run(body.calTarget, user.id);
      }
      if (body.calShow !== undefined) {
        if (!Array.isArray(body.calShow) || body.calShow.length > 20 || body.calShow.some((c) => typeof c !== 'string' || !c || c.length > 256)) return json(res, 400, { error: 'Invalid calendar list' });
        db.prepare('UPDATE users SET cal_show = ? WHERE id = ?').run(JSON.stringify(body.calShow), user.id);
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/calendars' && req.method === 'GET') {
      if (!user.refresh_enc) return json(res, 200, { calendars: [] });
      const r = await calApi(user, 'GET', '/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,primary,accessRole)');
      if (r.status !== 200 || !r.data) return json(res, 502, { error: 'Could not load calendars from Google' });
      return json(res, 200, { calendars: (r.data.items || []).map((c) => ({ id: c.id, name: c.summary, primary: !!c.primary, writable: c.accessRole === 'owner' || c.accessRole === 'writer' })) });
    }

    if (p === '/api/events' && req.method === 'GET') {
      const date = url.searchParams.get('date') || '';
      if (!DATE_RE.test(date)) return json(res, 400, { error: 'date required (YYYY-MM-DD)' });
      if (!user.refresh_enc) return json(res, 200, { events: [], failed: 0 });
      return json(res, 200, await eventsForDay(user, date));
    }

    if (p === '/api/tasks') {
      if (req.method === 'GET') {
        return json(res, 200, { version: version(), tasks: readTasks() });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!Array.isArray(body.tasks) || body.tasks.length > MAX_TASKS) return json(res, 400, { error: 'tasks must be an array (max 5000)' });
        const current = version();
        if (body.version !== current) {
          return json(res, 409, { error: 'Out of date', version: current, tasks: readTasks() });
        }
        const clean = body.tasks.map(cleanTask).filter(Boolean);
        const result = applyTasks(clean, user.id);
        enqueueSync(result);
        return json(res, 200, { version: result.version });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    send(res, 404, 'Not found');
  } catch (e) {
    if (e && e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Day Planner listening on :${PORT} (data: ${DATA_DIR})`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
}
