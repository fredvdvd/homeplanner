# Day Planner (self-hosted)

Kanban board + day timeline. Node 24, SQLite (built in), no npm dependencies.
Single shared password; tasks are stored in a SQLite file on a Docker volume.

## Run

    cp .env.example .env      # fill in Google credentials, PUBLIC_URL, ALLOWED_EMAILS, SESSION_SECRET
    docker compose up -d --build

## Google setup

1. Google Cloud Console: create a project, enable the **Google Calendar API**.
2. OAuth consent screen: add scopes `calendar.events` and `calendar.calendarlist.readonly`.
   Publish the app (status "In production") or refresh tokens expire after 7 days.
3. Credentials: create an **OAuth client ID**, type *Web application*, authorized redirect URI
   `https://planner.fieldforge.dev/auth/google/callback`.
4. Put client id/secret in `.env`, list allowed emails in `ALLOWED_EMAILS`.

## Putting it on the internet

Google requires HTTPS for the redirect URI. Use a reverse proxy. Caddy example:

    planner.fieldforge.dev {
        reverse_proxy 127.0.0.1:3100
    }

## Auth and calendar

- Sign in with Google; only `ALLOWED_EMAILS` get in. Everyone shares one task board.
- Session: HttpOnly, SameSite=Lax cookie signed with HMAC (30 days; `SESSION_DAYS`).
- Each user's Google refresh token is stored AES-GCM encrypted. Set a fixed `SESSION_SECRET`;
  changing it logs everyone out and requires re-connecting Google.
- A task with a date and start time is created/updated as an event in its owner's chosen calendar
  (Calendar button). Moving, un-scheduling, finishing or deleting the task updates or removes the event.
- Events from the calendars you tick appear read-only (dashed) on the Day timeline.
- Tasks created before this feature have no owner and are not synced.

## Data and backups

SQLite file: `/data/planner.db` in the `planner-data` volume.

    docker run --rm -v planner_planner-data:/data -v $(pwd):/backup alpine \
      cp /data/planner.db /backup/planner-backup.db

(Stop the container first for a perfectly consistent copy, or use the `-wal`/`-shm` files too.)

## API

All routes except `/auth/*` and `/healthz` need the session cookie; writes must be `application/json`.

- `GET  /auth/google`, `GET /auth/google/callback`
- `POST /api/logout`
- `GET  /api/me`, `POST /api/me/settings` `{ tz?, calTarget?, calShow? }`
- `GET  /api/calendars`, `GET /api/events?date=YYYY-MM-DD`
- `GET  /api/tasks` -> `{ version, tasks }`
- `PUT  /api/tasks` `{ version, tasks }` -> `{ version }`, or 409 with the current state if `version` is stale
- `GET  /healthz`

Devices and users stay in sync: each client polls every 30 s and on tab focus; a stale write gets a 409
and the client reloads the latest tasks.
