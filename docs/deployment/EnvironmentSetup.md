# Environment Setup — Phase 3

Status: **Complete.** Template created at `server/.env.local.example`, covering `server/local.js` — the actual production entry point. (The pre-existing `server/.env.example` documents a separate, mostly-vestigial Postgres/cloud mode, `server/index.js` — its header comment was corrected to point here instead of claiming `local.js` needs nothing, which was true before the licensing feature added a mandatory `JWT_SECRET`/`SMTP_*` requirement and is no longer accurate.)

## Naming note — read this before setting anything

This deployment's requested checklist uses the names `SERVER_PORT` and `DATABASE_PATH`. **The code actually reads `PORT` and `DB_PATH`.** The table below and `server/.env.local.example` use the real names — setting `SERVER_PORT=...` in your `.env` would silently do nothing (the server would just fall back to its default `PORT`). This is flagged explicitly, not silently corrected without mention, so a deployment doesn't quietly misconfigure itself.

## Variables

| Variable (real name) | Requested name | Required? | Default if unset | What it does |
|---|---|---|---|---|
| `PORT` | `SERVER_PORT` | No | `3000` | TCP port `server/local.js` listens on. |
| `JWT_SECRET` | `JWT_SECRET` | **Yes — boot fails without it** | *(none)* | Signs access + refresh tokens. Changing it invalidates every active session everywhere. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `SMTP_HOST` | `SMTP_HOST` | **Yes — boot fails without it** | *(none)* | Mail relay hostname, used only to send the registration email-verification link. |
| `SMTP_PORT` | `SMTP_PORT` | **Yes** | *(none)* | Mail relay port (587 for STARTTLS, 465 for implicit TLS). |
| `SMTP_USER` | `SMTP_USER` | **Yes** | *(none)* | SMTP auth username. |
| `SMTP_PASS` | `SMTP_PASS` | **Yes** | *(none)* | SMTP auth password / app-specific key. |
| `SMTP_FROM` | `SMTP_FROM` | **Yes** | *(none)* | The `From:` header on verification emails, e.g. `ShopERP Pro <no-reply@example.com>`. |
| `ADMIN_KEY` | *(not in the requested list, included since it's security-critical)* | No, but **strongly recommended** | A well-known default hash | sha256 of the Super Admin password. Gates every `/api/admin/*` endpoint. `GET /health` reports `startup.adminKeyIsDefault: true` if left unset — treat that as a deploy-blocking warning for anything internet-facing. Generate: `echo -n 'YourPassword' | shasum -a 256`. |
| `DB_PATH` | `DATABASE_PATH` | No | `server/shoperpro.db` | SQLite database file location. Point this at durable, backed-up storage in production — this file **is** all tenant data. |
| `ALLOWED_ORIGINS` | *(not in the requested list, included since it's a real CORS control)* | No | unset = no restriction | Comma-separated allowed CORS origins. Tighten this for any deployment reachable from the public internet. |
| `LICENSE_SWEEP_INTERVAL_MS` | *(not in the requested list)* | No | `900000` (15 min) | How often the license status-transition sweep (expiry/suspend/archive) runs. Exists mainly so tests can shrink it — leave it alone in production. |
| `EMAIL_ENABLED` | `EMAIL_ENABLED` | No — **not read by any code today** | n/a | Requested for this deployment's checklist, but nothing currently toggles behavior on it — SMTP is unconditionally mandatory at boot regardless of its value. Documented as a **reserved placeholder** in `server/.env.local.example`, not wired up (doing so would be a business-logic change, out of scope for this phase). |

## Setup steps

1. `cp server/.env.local.example server/.env`
2. Generate and fill in a real `JWT_SECRET` (command above).
3. Generate and fill in a real `ADMIN_KEY` (command above) — do not ship with the default.
4. Fill in real SMTP credentials. Until you do, the server will **refuse to start** — this is intentional (same fail-loud posture as `JWT_SECRET`), not a bug to work around.
5. Set `DB_PATH` to a durable location if the default (next to `local.js`) isn't appropriate for your deployment (e.g. a mounted volume with its own backup schedule).
6. Leave `PORT`, `ALLOWED_ORIGINS`, and `LICENSE_SWEEP_INTERVAL_MS` at their defaults unless you have a specific reason not to.
7. Verify: `node local.js` should print the startup banner and stay running, with no `[FATAL]` lines. `curl http://localhost:<PORT>/health` should return `{"status":"ok", ...}`.

## What must never happen

- `server/.env` must never be committed (it's gitignored — verified in `GitReadinessReport.md`).
- Only `server/.env.example` and `server/.env.local.example` (placeholder values only) belong in version control.
- Real SMTP credentials, `JWT_SECRET`, and `ADMIN_KEY` exist only in the deployment's actual `server/.env` file (or your platform's secret-management system, if you're not using a flat file) — never in code, never in a commit, never in a log line.
