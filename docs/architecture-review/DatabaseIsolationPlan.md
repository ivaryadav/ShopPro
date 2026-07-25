# Database Isolation Plan

Status: **Implemented and verified.**

## Problem

Every test this engagement has run so far executed against `server/shoperpro.db` — the real production file — with safety maintained entirely through manual discipline (unique test-tenant names, careful per-tenant cleanup in `finally` blocks). That discipline held throughout, verified repeatedly via checksums and row counts, but it's fragile by construction: it's exactly the same discipline that slipped and produced the 7 orphaned rows documented in `OrphanedDataAudit.md`. Structural isolation removes the entire class of risk rather than relying on care.

## Changes

### 1. `DB_PATH` is now configurable (`server/local.js`)
```js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'shoperpro.db');
```
- Unset (the normal `node local.js` production invocation): resolves to **exactly** the same path as before this change. Verified: restarted the production server with no env override, confirmed the startup banner shows the identical absolute path, confirmed all 6 tenants and 7 `tenant_data` rows are present and unchanged.
- Set: the server opens whatever file is specified instead, runs the exact same migrations against it (fresh file → fresh schema, verified: all 5 tables created correctly on an isolated temp file).

### 2. Loud operator warning on non-default paths
The startup banner now prints the actual `DB_PATH` in use, and if it differs from the default, prints a highly visible `⚠️ NON-DEFAULT DATABASE` warning instead of blending in — directly serves "production DB and test DB must never mix" by making it visually obvious which one is active, rather than requiring an operator to check an environment variable to find out.

### 3. Isolated test-server harness (`server/test/testServer.js`)
`startTestServer()`:
- Generates a unique temp file path (`os.tmpdir()`), a random port, a random `JWT_SECRET`, and a random `ADMIN_KEY` — no overlap with production values or with any other concurrently-running test.
- Spawns a real `node local.js` child process (via `child_process.spawn`, not shell backgrounding) with those as env vars.
- Polls `/health` until the child is actually ready (up to 10s), rather than a fixed sleep.
- Returns `{ baseUrl, adminKey, jwtSecret, dbPath, stop() }`. `stop()` kills the child process and deletes the temp DB file plus its `-wal`/`-shm` siblings.

This spawns a genuinely separate OS process with its own SQLite connection — not an in-process fake or mock — so tests exercise the real server binary, real migrations, real Express routing, exactly as production does, just against disposable data.

### 4. Existing test suites migrated
`server/test/wave0-concurrency.test.js` and `server/test/wave1-sessions.test.js` now call `startTestServer()` instead of pointing at `http://localhost:3000` with the real `ADMIN_KEY`. Effects:
- No more need for randomized-unique shop names to avoid colliding with real data or other test runs (deterministic key generation was a repeated source of friction in prior manual testing — see `Wave01-EdgeCaseReport.md` EC-9).
- No more per-tenant `DELETE` cleanup logic — `stop()` removes the entire temp file, which is both simpler and strictly safer (nothing to get subtly wrong).
- No more shared rate-limit exhaustion between test runs and real usage (EC-10) — each test run gets a completely fresh rate-limiter state too, since it's a fresh process.
- Both suites gained a genuine concurrent-write test (`Promise.all`, not sequential) that wasn't practical to add safely against the shared production database before.

## Verification performed

1. **Default path unchanged**: production server restarted with no `DB_PATH` set; confirmed identical absolute path in the startup banner; confirmed all 6 real tenants and 7 `tenant_data` rows present and unchanged before and after.
2. **Isolation works**: started an isolated instance with a custom `DB_PATH`; confirmed the file was created fresh (0 tenants, not 6); confirmed the production file was untouched throughout (still 6 tenants); confirmed `stop()` removes the temp file.
3. **Migrations run correctly on a custom path**: the isolated instance's fresh database had all 5 tables (`tenants`, `users`, `tenant_data`, `user_sessions`, `cloud_backups`) after boot — every migration in `local.js` ran against it exactly as it does against the default path.
4. **Backups work against a custom path**: `sqlite3 <custom-path> ".backup <copy>"` succeeded and the resulting copy passed `PRAGMA integrity_check`.
5. **Both migrated test suites pass**: `wave0-concurrency.test.js` 16/16 (15 original + 1 new true-concurrency case), `wave1-sessions.test.js` 27/27 (25 original + 2 new cross-tenant-isolation assertions) — all against fully isolated, disposable databases.
6. **Production untouched by any of the above**: confirmed after every step.

## Backward compatibility

Zero behavior change for the standard production invocation (`node local.js`, no env overrides) — verified directly, not assumed. Anyone currently running the server exactly as documented in `README.txt` is unaffected.
