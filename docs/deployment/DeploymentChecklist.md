# Deployment Checklist — Phase 6

This checklist targets `server/local.js` — the SQLite-backed server that is both the "Local WiFi" deployment and the backend for the SaaS registration/licensing system. It complements, rather than replaces, `server/DEPLOY.md` (which documents Option A/local-LAN and Option B/Postgres-cloud in narrative form); this is the actionable go/no-go list for a production rollout, including the new SaaS registration flow which requires the server to be internet-reachable (unlike the original pure-LAN design).

## ☐ Server setup

- [ ] Provision a host (VPS, on-prem PC, or cloud VM) with persistent storage for the SQLite file — not ephemeral/container-only storage that resets on redeploy.
- [ ] Open only the ports actually needed: the reverse proxy's HTTPS port (443) to the internet; the app's own port (default `3000`) only to `localhost` / the reverse proxy, never directly to the internet.
- [ ] Confirm the host clock is correct and NTP-synced — the license sweep, session expiry, and email-verification token expiry all depend on accurate timestamps.

## ☐ Node.js installation

- [ ] Install Node.js 20.x (matches `.github/workflows/ci.yml`'s tested version):
  ```bash
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -   # or the .deb equivalent for Debian/Ubuntu
  yum install -y nodejs   # or apt-get install -y nodejs
  node -v   # should print v20.x.x
  ```
- [ ] Install a process manager for restart-on-crash and restart-on-reboot — PM2 is already configured for this project (`server/ecosystem.config.js`):
  ```bash
  npm install -g pm2
  ```

## ☐ Database initialization

- [ ] Nothing to run manually — `server/local.js` creates and migrates its own SQLite schema automatically at boot (see `MigrationSafetyReport.md`). Just ensure `DB_PATH` points at a writable, durable directory before the first boot.
- [ ] After the first boot, confirm `GET /health` reports `migrationFailures: 0`.
- [ ] If this is an upgrade of an existing deployment (not a fresh install), confirm the backfill ran: `SELECT COUNT(*) FROM tenants t LEFT JOIN tenant_licenses tl ON tl.tenant_id=t.id WHERE tl.tenant_id IS NULL;` should return `0` (see `MigrationSafetyReport.md`'s verification query).

## ☐ Environment variables

Full detail in `EnvironmentSetup.md`. Minimum for a production boot:
- [ ] `JWT_SECRET` — real random value, not the placeholder.
- [ ] `ADMIN_KEY` — real sha256 hash of a strong admin password, not the built-in default (`GET /health` will report `adminKeyIsDefault: true` if you forget this — treat that as blocking).
- [ ] `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` — real credentials (the server refuses to boot without all five).
- [ ] `DB_PATH` — pointed at durable, backed-up storage.
- [ ] `ALLOWED_ORIGINS` — set to your real domain(s) if the server will be reachable from the public internet (empty/unset = no CORS restriction, fine for a private LAN deployment only).
- [ ] `server/.env` itself is never committed — confirm with `git status` that it shows as ignored, not untracked-and-about-to-be-added.

## ☐ SMTP setup

- [ ] Choose a real provider (any standard SMTP relay — Gmail SMTP with an app password, SendGrid, Amazon SES, your own mail server, etc.).
- [ ] Fill in `SMTP_*` in `server/.env`.
- [ ] Boot the server and confirm no `[MAILER] SMTP verify failed` line appears in the startup log.
- [ ] Send one real test registration through the wizard and confirm the verification email actually arrives (this specific step was **not** exercised during the licensing feature's own automated testing — see `docs/architecture-review/VerificationReport.md` — do it here before relying on it in production).

## ☐ HTTPS

- [ ] Obtain a certificate (Let's Encrypt via your reverse proxy/host panel is the simplest path — `server/DEPLOY.md` Step 9 has a worked DirectAdmin example).
- [ ] Confirm the app itself is never exposed on plain HTTP to the public internet — HTTPS termination happens at the reverse proxy, not in `local.js` (which doesn't implement TLS itself).
- [ ] Confirm cookies/tokens are only ever sent over the HTTPS origin in production (the app already uses `Authorization: Bearer` headers, not cookies, so there's no cookie-`Secure`-flag concern here — but mixed-content browser warnings would still indicate a misconfigured proxy).

## ☐ Reverse proxy

- [ ] Point Nginx (or your proxy of choice) at `http://127.0.0.1:<PORT>` (the app's `PORT` env var).
- [ ] Forward `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` headers — the app calls `app.set('trust proxy', 1)` already, so it expects to be behind exactly one proxy hop.
- [ ] A minimal Nginx example is in `server/DEPLOY.md` Step 8 — adapt the domain name and port.

## ☐ Backups

- [ ] Back up the entire SQLite file set: `shoperpro.db`, `shoperpro.db-wal`, `shoperpro.db-shm` together, not just the main file (WAL-mode SQLite can have uncommitted data in the sidecar files).
- [ ] Use `server/scripts/backup-verify.js` (already exists, already tested in the prior architecture-review engagement) rather than a raw file copy while the server is running, to avoid a torn/inconsistent snapshot.
- [ ] Schedule this on a real interval (cron/systemd timer) — no automated backup schedule exists today; this was explicitly flagged as a gap in the prior `OperationalReadinessPlan.md` and remains true.
- [ ] Store backups off-host (a backup on the same disk as the live database doesn't protect against disk failure).

## ☐ Restore verification

- [ ] Periodically — not just once at initial setup — restore a backup file to a *different* path (`DB_PATH` pointed elsewhere) and boot the server against it to confirm the backup is actually usable, not just "a file that exists."
- [ ] Confirm `GET /health` reports `db: "ok"` and `migrationFailures: 0` against the restored copy.
- [ ] Confirm at least one real login succeeds against the restored copy before considering the backup verified.

## Sign-off

Every item above should be checked before the first real customer registers. See `ProductionDeploymentReport.md` (Phase 8) for the final automated-verification gate that runs immediately before tagging a release.
