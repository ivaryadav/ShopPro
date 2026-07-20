# Migration Impact Report — `DB_PATH` Configurability Change

## What changed, precisely

Two lines in `server/local.js`:
```diff
- const DB_PATH    = path.join(__dirname, 'shoperpro.db');
+ const DB_PATH    = process.env.DB_PATH || path.join(__dirname, 'shoperpro.db');
```
Plus a startup-banner change (cosmetic — now prints the real path in use, with a warning if it's not the default) and a new addition to `server/sessions.js`'s already-existing migration flow: no schema change was needed for this task, `sessions.migrate(db)` and the existing `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` calls in `local.js` are all path-agnostic already (they operate on whatever `db` connection was opened, regardless of which file it points to).

## Migration behavior impact: none, for the schema itself

No migration SQL changed. Every existing `ALTER TABLE ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` statement runs identically regardless of which file `DB_PATH` resolves to — they're written against `db` (the open connection), never against a hardcoded path. Verified directly: a fresh isolated database, given a custom `DB_PATH`, ended up with the exact same 5-table schema as production (`tenants`, `users`, `tenant_data`, `user_sessions`, `cloud_backups`), auto-created by the same migration code path production uses.

## Risk of the `DB_PATH` change itself

**Low.** It's an environment-variable-with-identical-default pattern, the same one already used for `PORT`, `JWT_SECRET`, and `ADMIN_KEY` in this same file — not a new pattern introduced for this task, a consistent extension of one already in use and already trusted for exactly this kind of "configurable, but safe if left unset" setting.

## What could go wrong, and why it doesn't

| Scenario | Why it's not a problem |
|---|---|
| Someone runs `node local.js` with `DB_PATH` accidentally set to something unintended | The startup banner now loudly flags this (`⚠️ NON-DEFAULT DATABASE`) rather than silently opening a different file — an operator would notice immediately rather than discovering it later via missing data. |
| A test run's `DB_PATH` somehow collides with production's path | Not possible by construction: `testServer.js` generates its path via `crypto.randomBytes` under `os.tmpdir()`, never under `server/`, and never touches the `shoperpro.db` filename. |
| Backups or migrations behave differently against a non-default path | Verified they don't — `.backup` and every `ALTER`/`CREATE` statement operate identically regardless of path, confirmed by direct testing (`DatabaseIsolationPlan.md` §Verification). |
| Existing deployments (that already have a `server/.env` without `DB_PATH`) break | They don't — `DB_PATH` was never a recognized/read environment variable before this change, so no existing `.env` file could already be setting it in a way that this change alters. The only relevant `.env` entries today (`ADMIN_KEY`, `JWT_SECRET`) are unaffected. |

## Rollback

Revert the two-line diff in `server/local.js`. No data migration needed in either direction — this change never touched the schema, only which file the schema is applied to.
