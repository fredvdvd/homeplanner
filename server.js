'use strict';
/*
 * Day Planner server: zero npm dependencies.
 * Needs Node 22.13+ (built-in node:sqlite).
 *
 * Env:
 *   APP_PASSWORD    required. The single password for the app.
 *   PORT            default 3000
 *   DATA_DIR        default ./data (SQLite file lives here)
 *   SESSION_SECRET  optional. Random one is generated and stored in the DB if unset.
 *   COOKIE_SECURE   "true" to always mark the session cookie Secure (use behind HTTPS)
 *   TRUST_PROXY     "true" to trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy
 *   SESSION_DAYS    default 30
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PASSWORD = process.env.APP_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'planner_session';

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('APP_PASSWORD must be set to at least 8 characters.');
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
  INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');
`);

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

function replaceTasks(tasks) {
  const ins = db.prepare('INSERT INTO tasks (id, pos, title, notes, col, prio, date, start, dur) VALUES (?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM tasks');
    const seen = new Set();
    let pos = 0;
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      ins.run(t.id, pos++, t.title, t.notes, t.col, t.prio, t.date, t.start, t.dur);
    }
    const v = version() + 1;
    setMeta.run('version', String(v));
    db.exec('COMMIT');
    return v;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ---------- auth ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest();
function passwordOk(input) {
  return typeof input === 'string' && crypto.timingSafeEqual(sha(input), sha(PASSWORD));
}
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

function makeToken() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return exp + '.' + sign(exp);
}
function tokenOk(token) {
  if (typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = sign(exp);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const authed = (req) => tokenOk(cookies(req)[COOKIE]);

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function isHttps(req) {
  return COOKIE_SECURE || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
}

// Login throttle: 8 failed attempts per 15 minutes per IP.
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

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/login.css': ['login.css', 'text/css; charset=utf-8'],
};
function serveFile(res, file, type) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': type });
  });
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && STATIC[p]) return serveFile(res, ...STATIC[p]);

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return authed(req) ? serveFile(res, 'index.html', 'text/html; charset=utf-8')
                         : serveFile(res, 'login.html', 'text/html; charset=utf-8');
    }

    // Mutations must be JSON: a cross-site form post cannot send this content type.
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(res, 415, { error: 'Content-Type must be application/json' });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (throttled(ip)) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const body = await readBody(req, 4096);
      if (!passwordOk(body.password)) {
        noteFail(ip);
        return json(res, 401, { error: 'Wrong password' });
      }
      fails.delete(ip);
      const cookie = `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`;
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`,
      });
    }

    if (p === '/api/tasks') {
      if (!authed(req)) return json(res, 401, { error: 'Not signed in' });

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
        return json(res, 200, { version: replaceTasks(clean) });
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
