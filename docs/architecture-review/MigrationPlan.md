# Wave 0 + Wave 1 — Migration Plan

How to actually deploy this, in order, and what happens to data and users already in flight when it goes out.

## Pre-deploy checklist

1. **Confirm `server/.env` has `JWT_SECRET` set.** The server now refuses to boot without it (verified: tested with `.env` temporarily removed, confirmed exit code 1 with a clear message, `.env` restored). A value has already been generated and added for this environment; for any other deployment of this codebase, generate one with the command the startup error itself prints.
2. No other environment variables are new. `ADMIN_KEY`, `PORT` are unchanged.
3. No manual data migration script is needed anywhere in this plan — every schema change is an `ALTER TABLE ADD COLUMN` (Wave 0) or a `CREATE TABLE IF NOT EXISTS` (Wave 1), both idempotent and both already run automatically on server boot, matching the pattern the codebase has used for every prior schema change (`status`, `suspend_reason`, `license_key_hash`, etc.).

## Deploy sequence

1. Stop the running server.
2. Deploy the new `app/ShopERP_Pro_v8.html`, `server/local.js`, `server/sessions.js`, `server/.env` (with `JWT_SECRET` set).
3. Start the server. On boot it will:
   - Run the Wave 0 `tenant_data` column migration (existing rows get `version = 1` automatically via the column default).
   - Run the Wave 1 `user_sessions` table creation (empty table, nothing to backfill — there were no sessions to migrate *from*, since none existed before this wave).
   - Fail immediately with a clear message if `JWT_SECRET` is missing — this is the one step that can block a deploy, and it's intentional.
4. No downtime beyond the restart itself (a few seconds, `better-sqlite3` opens instantly).

## What happens to users already logged in at deploy time

This is the part that matters most for "don't break hosted mode."

- **Every already-issued JWT was signed with a secret that is thrown away on this exact restart** (the pre-Wave-1 code generated a fresh random `JWT_SECRET` every boot if none was configured — which was true in this environment before this deploy). So in *this specific environment*, every existing session is already dead the moment the server restarts, Wave 1 or not — that's pre-existing behavior, not something this deploy introduces.
- **For any deployment where `JWT_SECRET` was already fixed** (an operator followed the `.env.example` guidance that already existed): old 7-day tokens signed with that same secret remain cryptographically valid after this deploy. `requireAuth`'s dual-mode check (`sessions.checkSession`) accepts them exactly as before — no `sid` claim means no session lookup, just the original signature+expiry check. These users are **not** forced to re-login. They naturally transition to session-backed tokens the next time they log in again (their current token expires, or they explicitly log out/in), at which point `sid` is included and full session tracking applies. No flag day, no forced mass logout.
- **A browser tab already open when this deploys**, mid-session, making its next `saveDB()` server-sync call: it will use whatever `window._svrDataVersion` it already had (Wave 0) — if that's `undefined` because the tab loaded before the version-tracking code existed, the very next save gets a clean `409`, the user sees the "reload to get the latest" prompt once, and is fully caught up after accepting it. No data is lost in this transition — that was the entire point of building it as fail-safe-to-409 rather than fail-open.

## Rollout order rationale (why Wave 0 before Wave 1)

Wave 0 touches only `PUT /api/data`'s write path — a narrow, well-isolated change. Wave 1 touches the authentication path every single request depends on. Deploying Wave 0 alone first (which is exactly what happened during this implementation — it was tested and verified end-to-end before Wave 1's first line was written) means that if something had gone wrong, the blast radius and rollback would have been trivial and wouldn't have touched login at all. Both are now bundled into the same deploy per the approved plan, but the code and the tests remain independently revertible — see `RollbackPlan.md`.

## Post-deploy verification (what to actually check after this goes live for real)

1. Server log shows the normal startup banner, not the `[FATAL]` JWT_SECRET message.
2. `node server/test/wave0-concurrency.test.js` and `node server/test/wave1-sessions.test.js` both pass against the live server (both do, as of this writing — see each test's own output for the full assertion list).
3. Spot-check: log in as a real shop from a browser, confirm the app loads and a sale/save works normally (manual — not yet automated, since it drives the full HTML client rather than just the API).
4. Watch the server log for `[Sessions] cleanup:` lines over the following days — confirms the cleanup interval is running (it also runs once immediately on boot, so the first line should appear right away if there's anything to report, most likely nothing on a fresh table).
