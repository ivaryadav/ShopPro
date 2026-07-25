# Wave 0 + Wave 1 — Regression Report

Independent re-verification pass, done after implementation, against the 7 points requested. Two real bugs were found and fixed during this pass — documented in full below, not smoothed over.

## 1. Electron mode still works

**Verified by code-path analysis and a real (partial) launch attempt, not a live click-through** — this environment sets `ELECTRON_RUN_AS_NODE=1`, which forces the Electron binary to run as plain Node instead of launching its GUI/Chromium runtime. Confirmed via `env | grep -i electron` and by actually attempting the launch (it failed with `Cannot read properties of undefined (reading 'whenReady')`, the exact signature of that env var's effect). This is a sandbox restriction of the review environment, not something to work around.

What was verified instead:
- `main.js` and `preload.js` — unchanged (file mtimes confirm neither was touched this session).
- Every new Wave 0/1 client entry point (`saveDB()`'s server-sync block, `_initSessionHeartbeat()`) is gated on **both** `SHOPERPRO_API_URL` *and* `_api.token()`.
- A real subtlety found during this pass: `SHOPERPRO_API_URL` is **not** cleanly falsy inside Electron, because of the pre-existing `preload.js` gap (documented in `ArchitectureReview.md`'s Deployment Modes section, predates this work) — `window.electronAPI` is never exposed, so the app's own detection logic falls through and sets `SHOPERPRO_API_URL` to `window.location.origin` (`"file://"` for a `file://`-loaded page), which is truthy.
- What actually keeps the new code inert in Electron is the **second** half of the guard: `_api.token()`. Grepped every call site of `_api.setToken()` (6 total) — all are inside the web login/register/refresh flows (`webLogin`, `pssLogin`, `pssRegister`, `pssLicenseLogin`, `_tryRefresh`). None are in the desktop PIN-login path (`loginPinSubmit` → `startApp`). So `_api.token()` never gets set in genuine Electron usage, and both new entry points return immediately without ever reaching `fetch()`.

**Conclusion**: functionally unaffected, verified as thoroughly as this environment allows. The underlying `preload.js` gap is pre-existing, unrelated to this work, and already flagged as a separate open item — not fixed here per the "additive only" instruction, since fixing it is a change to Electron's own IPC surface, not a session/concurrency concern.

## 2. Hosted mode still works

Verified live against the running server for the entire feature surface: registration, login, license-key lookup sign-in, data load/save, session refresh, logout, heartbeat, admin session list/revoke, license renewal (from earlier work, re-confirmed unaffected). 40 automated assertions pass (`server/test/wave0-concurrency.test.js` ×15, `server/test/wave1-sessions.test.js` ×25).

## 3. Existing users remain functional

- **Legacy (pre-Wave-1) tokens**: a token signed in the old shape (no `sid` claim) was minted with the real `JWT_SECRET` and confirmed to still authenticate successfully — these users are not force-logged-out by this deploy.
- **Existing tenants with real data**: `Dada Mobile`, `Vision Communication`, and their variants (tenants #1–5, #9) were inspected directly in SQLite before, during, and after this work. Untouched throughout — same 6 rows before and after.
- **A genuine functionality gap was found and fixed** (see §4) affecting exactly this category of user.

## 4. No migration issues

- Schema migrations (`ALTER TABLE ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`) are idempotent — verified by restarting the server twice in immediate succession with no errors either time.
- **Bug found**: tenants `#1`–`#4` (`Dada Mobile`, `Dada Mobiles`, `Dada Mobiless`, `Vision Communication`) have **no `tenant_data` row at all** — they predate whatever code path was supposed to guarantee one exists. The original `PUT /api/data` used `INSERT ... ON CONFLICT DO UPDATE`, which self-healed this silently. Wave 0's rewrite replaced it with `UPDATE ... WHERE version = ?` only, with no insert fallback — meaning any of these four accounts attempting to save data would have received a `409` **forever**, with no way to recover, the moment this shipped.
  - **Fixed**: `PUT /api/data` now checks whether a row exists first; if not, it creates one (only when the client's `expectedVersion` is `0`, matching what `GET` reports for that state), race-safe against a concurrent first-save via `tenant_data`'s primary-key constraint.
  - **Verified**: reproduced the exact broken state on a disposable test tenant (registered fresh, then deleted its `tenant_data` row to match), confirmed the old code path would 409 forever, confirmed the fix resolves it and subsequent normal saves work. Added as a permanent regression test (`wave0-concurrency.test.js`, "row-less tenant" case) so this can never silently reappear.
  - **Tenants #1–4 are not manually repaired** — the fix is self-healing: the moment any of them successfully saves through the web app, their row is created automatically. No backfill script was run against production data; flagging this choice explicitly rather than unilaterally deciding to touch real accounts' data — happy to run a one-line backfill (`INSERT INTO tenant_data (tenant_id, data) SELECT id, '{}' FROM tenants WHERE id NOT IN (SELECT tenant_id FROM tenant_data)`) if preferred instead.

## 5. No data loss scenarios

- Every rejected write (stale version, missing version, row-less-but-wrong-version) was confirmed, by reading the database directly after each attempt, to have left the previously-saved data completely intact.
- SQLite/`better-sqlite3` executes synchronously; there is no window for a partial write — every `UPDATE`/`INSERT` in the changed code either fully commits or fully fails.

## 6. No API breaking changes

- `register`/`login` response shapes: every existing field is still present, unchanged in meaning; `refreshToken` is a pure addition. Confirmed no client call site was reading a field that got renamed or removed.
- `GET /api/data`: `data`/`updatedAt` unchanged; `version` is a pure addition.
- **A real risk was found and reverted before it shipped**: the first draft of the `_api` client refactor routed `_api.post()` through the same 401-interception logic as `get`/`put`. Every existing `post()` caller (login, register, renew-license, verify-license) reads `res.error` from a normal response body for legitimate 401s ("wrong PIN"), not session-expiry signals — that draft would have broken login's own error message and triggered an incorrect "session expired" redirect on a simple wrong-PIN entry. Caught during this implementation's own testing (documented in `SessionArchitecture.md`), reverted, `post()` left with its original contract.

## 7. Multi-device conflict scenarios are protected

- Sequential stale-write protection: verified (Wave 0 suite).
- **True concurrent** protection: fired two simultaneous `PUT`/refresh requests via `Promise.all` (not just sequential stale-version calls) — SQLite's synchronous execution serializes them correctly; the loser gets a clean `409`/`401` rather than silent corruption.
- **A second real bug was found and fixed during this specific check**: two browser tabs of the *same device* share `localStorage`, where the refresh token now lives. Firing two simultaneous refresh requests with the same token reproduced the problem directly: one tab got a valid new session, the other got a hard `401` and would have been spuriously logged out — a worse and more common failure than the multi-device case Wave 0 was built to prevent, since two tabs of one browser is a very ordinary shop workflow (billing in one tab, reports in another).
  - **Fixed**: added a 20-second grace window — a refresh token reused within that window of its own rotation is accepted (issuing a fresh access token, no new refresh token, since the real one already went to the tab that won the race) instead of rejected.
  - **Verified theft detection wasn't weakened**: the exact same reused token, replayed *outside* the grace window, is still rejected (`401`) — confirmed directly against `sessions.js` and via the live server with a backdated `refresh_rotated_at`.
  - Added as permanent regression tests in both the grace-hit and post-grace-rejection directions.

## Test suite results (final)

```
server/test/wave0-concurrency.test.js  — 15 passed, 0 failed
server/test/wave1-sessions.test.js     — 25 passed, 0 failed
```
Both run against the live server (`server/shoperpro.db`), each creates exactly one uniquely-named disposable tenant and removes only that tenant in a `finally` block. Production tenants confirmed identical (same 6 rows, same IDs) before this review pass and after.
