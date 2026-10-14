# Day Planner (self-hosted)

Kanban board + day timeline. Node 24, SQLite (built in), no npm dependencies.
Single shared password; tasks are stored in a SQLite file on a Docker volume.

## Run

    cp .env.example .env      # set APP_PASSWORD
    docker compose up -d --build

Open http://localhost:3000 (or whatever BIND_ADDR/PORT you set).

## Putting it on the internet

The password and session cookie must travel over HTTPS. Use a reverse proxy.
Caddy example (automatic certificates):

    planner.example.com {
        reverse_proxy 127.0.0.1:3000
    }

Then in `.env`: `TRUST_PROXY=true` and `COOKIE_SECURE=true`.

## Auth details

- Login sets an HttpOnly, SameSite=Strict cookie signed with HMAC (30 days; SESSION_DAYS to change).
- 8 wrong passwords per IP per 15 minutes, then HTTP 429.
- Changing APP_PASSWORD does not log out existing sessions. To force that, set SESSION_SECRET
  to a new value (or delete the `session_secret` row in the `meta` table).

## Data and backups

SQLite file: `/data/planner.db` in the `planner-data` volume.

    docker run --rm -v planner_planner-data:/data -v $(pwd):/backup alpine \
      cp /data/planner.db /backup/planner-backup.db

(Stop the container first for a perfectly consistent copy, or use the `-wal`/`-shm` files too.)

## API

All routes except login need the session cookie; writes must be `application/json`.

- `POST /api/login` `{ "password": "..." }`
- `POST /api/logout`
- `GET  /api/tasks` -> `{ version, tasks }`
- `PUT  /api/tasks` `{ version, tasks }` -> `{ version }`, or 409 with the current state if `version` is stale
- `GET  /healthz`

Several devices stay in sync: each client polls every 30 s and on tab focus; a stale write gets a 409
and the client reloads the latest tasks.
