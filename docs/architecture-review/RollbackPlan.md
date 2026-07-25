# Wave 0 + Wave 1 — Rollback Plan

## Files changed, this implementation

| File | Wave | Change type |
|---|---|---|
| `server/local.js` | 0 + 1 | Modified — schema migrations, `/api/data` handlers, new auth endpoints, `requireAuth`, cleanup interval |
| `server/sessions.js` | 1 | New file |
| `server/license.js` | — | Untouched by this work |
| `server/.env` | 1 | Modified — `JWT_SECRET` now set (was commented out) |
| `server/test/wave0-concurrency.test.js` | 0 | New file |
| `server/test/wave1-sessions.test.js` | 1 | New file |
| `app/ShopERP_Pro_v8.html` | 0 + 1 | Modified — `_api` object, `saveDB()`, `showPage()`, `startApp()`, `wbSwitchAccount()`, bootApp's catch handler, 5× login/register success handlers, 2 new functions (`_handleSyncConflict`, `_initSessionHeartbeat`) |
| `main.js`, `preload.js` | — | **Untouched** (confirmed via file mtime) |
| `docs/architecture-review/*.md` | 0 + 1 | New files (documentation only, zero runtime effect) |

## Rollback: code

Revert `server/local.js` and `app/ShopERP_Pro_v8.html` to their pre-Wave-0 commit; delete `server/sessions.js` and both new test files. This alone is sufficient to fully restore prior behavior — see the schema note below for why the database needs no corresponding action.

## Rollback: database

**Both waves' schema changes are safe to leave in place even after a full code rollback.** They are additive-only:
- `tenant_data.version` / `tenant_data.updated_by` — extra columns an old query simply never selects. SQLite doesn't care that they exist.
- `user_sessions` — an entirely new, empty-until-used table. An old server build never queries it.

If a fully clean database state is specifically wanted (not required for correctness):
```sql
ALTER TABLE tenant_data DROP COLUMN version;
ALTER TABLE tenant_data DROP COLUMN updated_by;
DROP TABLE user_sessions;
```
No `data` column (the actual business data) was ever touched by either wave, in either direction — there is no scenario in this rollback where a shop's actual sales/customers/inventory data is at risk.

## Rollback: `.env`

`JWT_SECRET` can be left set even after a code rollback — a pre-Wave-1 server build ignores it entirely (it always generated its own random secret regardless of what was in the environment). Removing it is optional, not required, and *not recommended* either way, since a fixed secret is strictly better than the old random-per-boot behavior even under old code.

## Partial rollback (Wave 1 only, keep Wave 0)

Because Wave 0 and Wave 1 touch different, non-overlapping parts of `/api/data` vs `/api/auth/*`, Wave 1 can be reverted independently:
1. Revert `requireAuth` to its pre-Wave-1 form (signature+expiry check only, no `sessions.checkSession` call).
2. Revert `login`/`register` to call the old `makeToken()` instead of `sessions.createSession()`.
3. Remove the new `/api/auth/refresh|logout|heartbeat|sessions*` routes.
4. Client: revert `_api`'s refresh-token additions; `_api.post()` is already unaffected since it was deliberately kept unchanged.
5. Wave 0's conflict-detection on `/api/data` is entirely independent of any of the above and needs no changes.

This asymmetry (Wave 1 revertible without touching Wave 0) is a direct consequence of building them as two clearly-separated modules (`server/license.js`-style split: `server/sessions.js` owns everything session-related) rather than one intertwined change.

## What rollback does NOT need to worry about

- **No user data loss in either direction.** Every schema change is additive; nothing that already existed was altered or dropped.
- **No forced re-registration.** Tenants, users, and license state are untouched by both waves — only `tenant_data`'s write-path guard and the *existence* of a session-tracking table changed.
- **Desktop/Electron users are unaffected by rollback in either direction** — they never called any of the changed or new endpoints to begin with.

## Verification after a rollback

Run `server/test/wave0-concurrency.test.js` / `wave1-sessions.test.js` against the rolled-back server — they should **fail** (the endpoints/behavior they test no longer exist), which is the expected and correct signal that the rollback actually took effect. If reverting only Wave 1, `wave0-concurrency.test.js` should still fully pass.
