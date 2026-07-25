# Database Audit — Independent Verification

SQLite via `better-sqlite3`, single file (`DB_PATH`, default `server/shoperpro.db`), 10 tables in `server/local.js` plus `user_sessions` in `server/sessions.js`. Reviewed directly from the actual `CREATE TABLE` statements, not from `DatabaseDesign.md`'s prior description of them.

## Indexes

Confirmed present via direct grep of every `CREATE INDEX`/`CREATE UNIQUE INDEX` statement:
- `idx_users_mobile` (unique, partial `WHERE mobile IS NOT NULL`) — correct, prevents duplicate-mobile registration at the DB layer, not just app-layer.
- `idx_tenants_license` (unique, partial) — same pattern for legacy license-key hashes.
- `idx_tenant_licenses_key` (unique, partial), `idx_tenant_licenses_status` — supports the admin dashboard's filter-by-status queries and prevents duplicate license keys.
- `idx_license_history_tenant` (composite `tenant_id, created_at`) — correct shape for the audit-history query pattern (`WHERE tenant_id = ? ORDER BY created_at`).
- `idx_trusted_devices_tenant`, `idx_trusted_devices_user`.
- `idx_sessions_session_id`, `idx_sessions_user` (composite `tenant_id, user_id`), `idx_sessions_refresh`, `idx_sessions_prev_refresh` (`sessions.js:72-75`).

**No missing index was found for any query pattern actually used in the code** — every `WHERE`/`ORDER BY` column combination used in a hot path (login lookups, session checks, license-status checks, history listing) has a matching index. `tenant_data` itself needs no secondary index — `tenant_id` is its primary key (`local.js:135`), so the single most common query (`WHERE tenant_id = ?`) is already the fastest possible lookup.

## Constraints

- Foreign keys are declared throughout (`REFERENCES tenants(id) ON DELETE CASCADE`, etc.) **and are actually enforced** — verified `local.js:109`: `db.pragma('foreign_keys = ON')` is set immediately after opening the connection. (A first-pass grep for the literal string `PRAGMA` returned nothing and could have been mistaken for "FKs are declarative-only, not enforced" — that would have been wrong; `better-sqlite3`'s `.pragma()` method is the actual mechanism used, confirmed by reading `local.js:107-109` directly.)
- `db.pragma('journal_mode = WAL')` (`local.js:108`) is also set — correct choice for a single-writer/multi-reader workload like this one, and it is what makes the app's fairly aggressive concurrent-read pattern (every `/api/data` GET) safe against writer contention.
- `CHECK` constraints are used appropriately: `tenant_licenses.status CHECK (status IN ('PENDING_APPROVAL','ACTIVE','READ_ONLY','SUSPENDED','ARCHIVED'))` (`local.js:231`) and `admin_credentials.id CHECK (id = 1)` (`local.js:287`, enforcing the intentional single-row-table pattern at the DB layer, not just by convention).
- `UNIQUE` constraints correctly placed: `tenant_licenses.tenant_id UNIQUE` (one license row per tenant), `trusted_devices(tenant_id, user_id, device_id) UNIQUE` (prevents duplicate device rows), `user_sessions.session_id UNIQUE`.

## Transactions — real gap, previously unexamined

**No call to `db.transaction(...)` exists anywhere in `server/local.js` or `server/sessions.js`** (confirmed by grep, zero matches for `db.transaction`, `BEGIN`, `COMMIT`). Several request handlers perform multiple sequential, independent `INSERT`/`UPDATE` statements that are logically one operation but are not wrapped atomically:

- `POST /api/auth/signup` (`local.js:821-833`): 4 sequential statements — insert `tenants`, insert `users`, insert `tenant_data`, insert `tenant_licenses`, then a 5th (`addLicenseHistory`).
- `POST /api/auth/register` (`local.js:757-763`): 3 sequential statements — insert `tenants`, insert `users`, insert `tenant_data`.
- Registration approval and other multi-step admin flows follow the same un-wrapped-sequential pattern.

**Concrete consequence, not hypothetical**: because `better-sqlite3` statements are synchronous, the realistic failure window is narrow (a JS exception, an out-of-disk-space write, or a hard process kill between two of these `.run()` calls) — but if it happens, the result is a **partially-created tenant**: e.g., a `tenants` row with no matching `tenant_licenses` row. Given `requireLicenseRead`/`requireLicenseWrite` explicitly **fail open** when no `tenant_licenses` row exists (`local.js:449,463` — see `IndependentSecurityReview.md` §16), such a partially-created tenant would have **no subscription enforcement whatsoever** until an operator noticed and manually fixed it, or the server restarted (triggering the backfill sweep). This directly compounds the same fail-open design already flagged as reachable through an entirely different path in `APIAudit.md` Finding API-1.

**Recommendation**: wrap each of these multi-insert sequences in a single `db.transaction(() => { ... })()` call — `better-sqlite3` supports this natively and it is a small, mechanical, low-risk change (no schema change, no API contract change) that would close this gap completely.

## Migration safety

The `runMigration()` helper (`local.js`, pattern repeated in `sessions.js:37-45`) wraps every `ALTER TABLE`/`CREATE TABLE` in a try/catch that treats `"already exists"`/`"duplicate column name"` as benign and anything else as a real, logged failure (`migrationState.failures`, surfaced via `GET /health`). This is a sound, idempotent, additive-only migration strategy — independently re-confirmed passing via `test/migration-idempotency.test.js` (13/13) and `test/migration-safety.test.js` (19/19), including the specific "genuine error is loudly logged, not silently swallowed" assertion re-run during this audit's fresh-clone test pass (`VerificationAudit.md`).

**Rollback**: there is no explicit "down migration" mechanism (expected and appropriate for an additive-only schema — nothing is ever dropped or destructively altered, so there is nothing to roll back at the schema level). Code rollback (reverting to a previous git commit/release while keeping the newer, migrated database) was specifically claimed as tested in `docs/deployment/MigrationSafetyReport.md`. This audit did not independently re-run that specific rollback scenario (it requires checking out an older commit and running it against an already-migrated DB, which was outside this review's time budget) — **flagged as an unverified-by-this-audit claim**, not confirmed false, simply not independently re-tested. Recommend this specific scenario be re-verified before every future release that adds new columns, not just this one.

## Performance

No N+1 query patterns were found in the reviewed request handlers — every list endpoint (`/api/admin/tenant-licenses`, `/api/admin/registrations`, etc.) uses a single `.all()` call, not a per-row query loop. `tenant_data` storage (one JSON blob per tenant) means the entire dataset per shop is read/written as one unit — this is a deliberate, simple design that will not scale to very large per-shop datasets (the JSON blob itself has no internal indexing), but is consistent with this product's target scale (50-500 small shops, one owner-operated business each) and was already an accepted, pre-existing architectural choice, not something introduced or worsened by this hardening pass.

## Concurrency

`PUT /api/data`'s optimistic-concurrency implementation (`local.js:1600-1644`) is genuinely well-built: a compare-and-swap `UPDATE ... WHERE tenant_id = ? AND version = ?`, checking `result.changes === 0` to detect a lost race, plus a special-cased first-insert race (caught via the `tenant_data` primary-key `UNIQUE` violation) that correctly reports a conflict rather than silently overwriting a concurrent first save from another device. Independently re-ran `test/concurrency-stress.test.js` (40/40 passed) and `test/wave0-concurrency.test.js` (16/16 passed), which exercise exactly this path under simulated concurrent writers.

## Verdict for this phase

Schema design, indexing, and the actual read/write concurrency model (`tenant_data`'s CAS logic) are all solid and independently verified. The one real, previously-unexamined gap is the **absence of transactional wrapping around multi-statement writes**, which is a genuine, if narrow-probability, data-integrity risk that also compounds an already-identified authorization gap (API-1). Medium severity, mechanically simple to fix.
