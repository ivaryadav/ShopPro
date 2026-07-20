# Root Cause Analysis — Orphaned `tenant_data` Row (`tenant_id = 6`)

**Read-only investigation. No data was modified to produce this report.**

## 1. When was it created?

`updated_at = 2026-07-15 10:06:13`. This is the `INSERT`-time default (`datetime('now')`), not a later update — the row's `version` is `1`, and no legitimate `PUT /api/data` was ever run against it after that point (which would have incremented it).

## 2. Which code path created it?

`POST /api/auth/register`, in `server/local.js`, via its `INSERT INTO tenant_data (tenant_id, data) VALUES (?, '{}')` at the end of registration. This is the normal, correct registration path — the row was created legitimately as part of registering a test tenant during this engagement's own earlier work (a shop named "Test Web Shop", used to verify the web/hosted licensing flow before Wave 0/1 existed). Confirmed by the timestamp predating the `version`/`updated_by` columns' existence — those columns were added later, by `ALTER TABLE ... ADD COLUMN ... DEFAULT 1`, which retroactively backfilled a default onto every pre-existing row including this one. That's why an orphan created before Wave 0 still shows `version = 1` — not because anything wrote it at that value, but because the column didn't exist yet when the row was created and got the schema default when it was added.

## 3. Whether current code can still reproduce it

**Not through the application.** Two independent facts rule it out:

- `grep -n "DELETE FROM tenants" server/local.js` returns **nothing** — the application has no code path, anywhere, that deletes a `tenants` row. Tenants can be paused or terminated (a status flag), never hard-deleted, through any API.
- Even if it did, `server/local.js` runs `db.pragma('foreign_keys = ON')` at startup (confirmed present, line 62). `tenant_data.tenant_id` has `REFERENCES tenants(id) ON DELETE CASCADE` in the schema. With foreign keys enforced, deleting a tenant through the running server **would** correctly cascade-delete its `tenant_data` row automatically.

**Reproducible only through manual, direct database access that bypasses the server.** The `sqlite3` CLI tool — used throughout this engagement for verification and test cleanup — does **not** enable foreign key enforcement by default in a plain session (`PRAGMA foreign_keys;` returns `0` unless explicitly set). The exact sequence that created this orphan:

```
sqlite3 shoperpro.db "DELETE FROM users WHERE tenant_id=6; DELETE FROM tenants WHERE id=6;"
```
— run directly against the CLI, with foreign keys off by default for that session, so the `tenants` row (and its `users` row) were removed, but `ON DELETE CASCADE` never fired for `tenant_data`, leaving it behind. This is traceable to this engagement's own manual test-tenant cleanup, not to any application defect or a real customer/operator action.

## 4. Whether additional orphaned rows exist

**Yes — found during this same audit, not previously known.** See `OrphanedDataAudit.md` for the full inventory: 6 additional orphaned `user_sessions` rows, same root cause (manual CLI cleanup of later test tenants during Wave 1 development and this review, also missing `foreign_keys=ON`).

## 5. Whether orphaned sessions, backups, licenses, or audit logs exist

- **Sessions**: yes, 6 rows — detailed in `OrphanedDataAudit.md`.
- **Backups** (`cloud_backups`): table has 0 rows total — nothing to be orphaned.
- **Licenses**: license state lives on the `tenants` row itself (`license_key_hash`, `license_expiry`, `license_plan`) — there's no separate license table that could hold an orphan independent of a tenant row.
- **Audit logs**: no `audit_log` / `security_audit_log` table exists yet (`SELECT name FROM sqlite_master` / `.tables` confirms only `cloud_backups, tenant_data, tenants, user_sessions, users`) — this is planned future work (Phase 3E in the original architecture review), not yet built, so there's nothing to check for orphans in.

## 6. Whether cleanup should be manual or automated

**Manual, reviewed, one-time cleanup — not an automated recurring job.** Reasoning:
- The volume is small (7 orphaned rows total) and the root cause is fully understood and non-recurring through the application itself.
- An automated "detect and delete orphans" job is itself a risk multiplier: if its detection logic ever has a bug (e.g., a race between a tenant being created and its `tenant_data` row landing, or a join condition subtly wrong), it could delete something real. For a system whose stated top priority is "data loss is unacceptable," an automated deletion job is exactly the kind of thing that should not be introduced casually.
- The actual fix for *recurrence* isn't automation — it's process: never run a manual `DELETE` against `shoperpro.db` via the `sqlite3` CLI without first running `PRAGMA foreign_keys = ON;` in that same session, or (better) always clean up test data through the application's own connection/logic where foreign keys are already enforced. See `RecommendedRemediation.md`.

## 7. Risk if left unresolved

**Low, and inert, not zero.**
- Not a functional risk: no code path reads or writes `tenant_data` by joining through a nonexistent `tenants` row in a way that could misbehave — every query that matters is scoped by an authenticated `req.user.tenantId` sourced from a verified JWT, and no valid JWT can ever carry a `tenantId` that doesn't correspond to a real tenant (tokens are only ever issued at login/register/refresh, always against a real, just-verified tenant row).
- Not a confidentiality risk: the orphaned `tenant_data` row's content is `{}` — empty.
- The orphaned **sessions** carry slightly more residual risk than the `tenant_data` orphan, since a session row conceptually represents "this token should still work" — but practically inert here too: the access tokens involved are 15-minute JWTs, long expired; the refresh tokens were never persisted anywhere outside this review's own ephemeral shell variables (with one caveat: a small number of raw token values were printed in this session's own tool-output logs during testing, which are visible in this conversation's transcript — not accessible to any third party, but worth closing out regardless rather than leaving a "should be fine" as the final word). Deleting the orphaned rows removes this even as a theoretical concern, at zero cost, since nothing legitimate depends on them.
- The main real risk is **accumulation over time** if the same manual-cleanup gap recurs repeatedly without correction — a slow leak of dead rows, not a functional or security bug on its own. Task 2 (isolated, disposable test databases) eliminates the root cause of this recurrence entirely going forward, since a temp DB file just gets deleted wholesale after each test run rather than requiring precise manual cleanup at all.
