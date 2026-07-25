# Production Readiness Checklists (Phase 6)

Five checklists the Phase 6 mission requires. These describe what a future, separately-approved cutover phase must do — **no production deployment has been performed under this phase.**

## 1. Production Checklist

| Item | Status |
|---|---|
| Identity & Tenant Core implemented, tested (mocked + real DB) | ✅ Done (Phase 2, Phase 6) |
| Operations Domain implemented, tested (mocked + real DB) | ✅ Done (Phase 4, Phase 6) |
| Migrations verified against real MariaDB (up/down/rollback) | ✅ Done this phase |
| Rate limiting applied to every Operations route | ✅ Done this phase |
| JSON→Relational data migration tool built and tested | ✅ Done this phase (dry-run, real run, rollback, integrity check all verified against real MariaDB) |
| Performance baseline captured | ✅ Done this phase (single-run, local instance — see Performance Results) |
| Licensing domain ported to `server/src/` | ❌ Not started |
| Administration domain ported to `server/src/` | ❌ Not started |
| Cloud Backup ported to `server/src/` | ❌ Not started |
| Frontend cut over to per-entity endpoints | ❌ Not started (explicitly out of scope — "do not modify frontend") |
| Load testing under realistic concurrent traffic (not a single disposable local instance) | ❌ Not done |
| Production-grade MariaDB instance provisioned (managed service, backups, replication as needed) | ❌ Not done — this phase used a disposable local instance |
| Error-envelope client compatibility shim/update (ADR-0007) | ❌ Not done |
| Real tenant data migrated via the new tool | ❌ Not done — tool is built and tested against synthetic data only, per this phase's "no production deployment" constraint |

**Verdict: NOT production-ready.** Architecture, code, and tooling are sound and now verified against a real (if disposable) MariaDB instance — the remaining gaps are entirely about scale (Licensing/Administration/Cloud Backup, load testing, production infrastructure) and the actual cutover step itself (migrating real tenants, switching the frontend), none of which this phase performed by design.

## 2. Deployment Checklist

For whichever future phase performs the actual cutover:

1. Provision a production MariaDB instance (managed service recommended — RDS/Cloud SQL/etc. — not a Homebrew-local instance as used for this phase's validation).
2. Set `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` and every other required env var (see `server/.env.example`) for the target environment.
3. Run `npm run migrate:up` against the production instance — verify `npm run migrate:status` shows both migrations applied.
4. For each existing tenant: extract `tenant_data.data` from `local.js`'s SQLite database into a JSON file, then run `npm run migrate:tenant-data:dry-run -- <tenantId> <path>` and review the reconciliation report BEFORE running `migrate:tenant-data:migrate` for real.
5. Verify the real-run reconciliation report's integrity check passes for every tenant before considering that tenant migrated.
6. Do NOT point the frontend at the new `server/src/` endpoints until every tenant is migrated and verified — `local.js` remains the production server until an explicit, separate cutover decision.
7. Keep `local.js` running and untouched throughout — this migration is additive-only against a new, parallel database.

## 3. Rollback Checklist

1. **Schema rollback**: `npm run migrate:down` reverts the most recently applied migration; run it twice to revert both 001 and 002 (verified working against real MariaDB this phase, `mariadbValidation.integration.test.js`/`database.test.js`).
2. **Per-tenant data rollback**: `npm run migrate:tenant-data:rollback -- <tenantId>` removes every Operations-domain row for that tenant only (verified this phase) — safe to run per-tenant without affecting others, and never touches the `tenants` row itself or `local.js`'s SQLite data.
3. **Full abort**: if a cutover is aborted entirely, simply keep the frontend pointed at `local.js` (it was never repointed) — no rollback action is needed on the production side, since `local.js` was never modified or stopped by this migration path.
4. **Verification after any rollback**: re-run `npm run migrate:status` (schema) or the tenant-data reconciliation report (data) to confirm a clean state before retrying.

## 4. Monitoring Checklist

| Item | Status / recommendation |
|---|---|
| Structured logging | ✅ Exists (`server/src/logging/`) — ensure production log level is INFO or WARN, not DEBUG |
| `GET /health` endpoint | ✅ Exists, reports real DB connectivity (`checkDatabaseHealth`) |
| Connection pool metrics (active/idle/limit) | ⚠️ Available from the `mariadb` driver's pool object but not currently exposed via an endpoint — recommend adding before production load |
| Audit logging | ❌ Neither `local.js` nor `server/src/` has general-purpose audit logging (Phase 5 finding, still open) — `stock_movements` covers Inventory only |
| Alerting on migration failures | Recommend wiring `migrateTenantData.js`'s non-zero exit code (on integrity failure) into whatever CI/ops tooling runs the actual cutover |
| Rate-limit 429 rate | Recommend monitoring for unexpectedly high 429 rates post-cutover as an early signal of a runaway client bug |

## 5. Backup Checklist

1. **Before any real tenant-data migration**: take a full backup of `local.js`'s `shoperpro.db` (SQLite file) — this migration tool never modifies it, but a backup is standard practice before any data operation touching production.
2. **MariaDB backups**: whatever managed service is chosen for production must have automated backups configured before real tenant data is migrated into it — not evaluated in this phase (a disposable local instance was used for validation, deliberately not representative of production backup posture).
3. **Reconciliation reports**: retain every `migrateTenantData.js migrate --report=...` output file — each is a point-in-time, per-tenant audit record of exactly what was migrated and whether it reconciled, valuable for any future dispute or debugging.
