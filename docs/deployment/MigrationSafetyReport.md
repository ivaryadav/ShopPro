# Migration Safety Report — Phase 4

Status: **PASS.**

Note: `docs/architecture-review/MigrationSafetyReport.md` already exists from a prior engagement (the Wave 0/1 session-architecture migration runner hardening) — this is a distinct, later report scoped to this production-deployment phase, deliberately placed in `docs/deployment/` rather than overwriting that history. See also `docs/architecture-review/DatabaseDesign.md` and `LicensingMigrationPlan.md` for the full schema/deploy design this report verifies against.

## Automatic migrations

`server/local.js` runs every schema change inline at boot — `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN`, wrapped in a `runMigration()` helper that classifies "already applied" errors (benign, silent) separately from genuine failures (logged loudly via `[MIGRATION FAILED]`, recorded in `migrationState.failures`, surfaced at `GET /health`, but **never** crashes the process — an unrelated historical column failing doesn't take down a server that would otherwise boot fine for every tenant not touching that column). No manual migration step or CLI command is ever required.

Verified fresh, right now: `server/test/migration-idempotency.test.js` — 3 consecutive boots against the same DB file:
```
✓ boot 1: all 5 pre-existing tables + all 4 new licensing tables exist
✓ boot 1: the 3 subscription plans (TRIAL/BASIC/PREMIUM) are seeded
✓ boot 2 (same file): no errors, marker row survives, subscription_plans not duplicated
✓ boot 3 (same file): no errors, marker row still present, table count stable
13 passed, 0 failed
```

## Migration rollback — verified by actually doing it, not just by design argument

This system uses **additive-only** migrations by design — no `DROP TABLE`, no `ALTER TABLE ... DROP COLUMN`, anywhere. That makes the relevant rollback question not "how do we undo a schema change" (there's nothing to undo) but "if we roll back the *code* to a previous release, does it still work against a database the newer code has already migrated forward?" This was verified directly, not just asserted:

1. Booted the **current** (post-licensing) `server/local.js` against a fresh temp SQLite file, ran a full self-service signup + admin approval through it (creating the 4 new tables, seeding plans, writing a real `tenant_licenses` row for a new tenant).
2. Extracted `local.js`/`sessions.js`/`license.js`/`logger.js` **exactly as committed at `HEAD` (`a242803`, before the licensing feature)** via `git show`, and booted *that* old code — unmodified — against the **same, already-migrated** database file.
3. Result: the old code booted with **zero migration failures**, and successfully logged in and served `/api/data` for the tenant that only exists because of the new code's signup/approval flow — using nothing but its own old `requireAuth`/`requireActive`/session logic, completely unaware the 4 new tables even exist.

This is the actual guarantee that matters for this deployment: **a code rollback is always safe**, at any point, regardless of how many boots of the newer code have run against the database in the meantime. There is no "point of no return" migration in this release.

## Existing tenant compatibility

`server/test/license-backfill-regression.test.js` (26 assertions, run fresh for this report) simulates exactly this: a database containing tenants created entirely by pre-licensing code (`active`/`paused`/`terminated` status, legacy `license_key_hash`/`license_expiry`/`license_plan` columns only, no `tenant_licenses` row) is booted with the new code, which automatically backfills every one of them — then every legacy endpoint (`register`-issued login, `verify-license`, `admin/tenant/status` pause/restore, `admin/web-users`) is confirmed to keep working, byte-for-byte, against those same tenants:
```
✓ legacy status 'active'/'paused'/'terminated' correctly map to ACTIVE/SUSPENDED/ARCHIVED
✓ the legacy tenants.status/license_key_hash columns are untouched — never rewritten
✓ a third boot does not duplicate the backfilled tenant_licenses rows
✓ the legacy owner logs in with mobile+PIN exactly as before
✓ the legacy tenant's actual pre-existing data (inventory) is intact and unchanged
✓ verify-license, admin/web-users, admin/tenant/status all still work, unmodified
✓ a brand-new signup works normally alongside the pre-existing legacy tenants
26 passed, 0 failed
```

## Existing licenses preserved

Every pre-existing tenant's legacy license fields (`license_key_hash`, `license_expiry`, `license_plan`, `status`) are **read but never overwritten** by any new code path — confirmed by the backfill test's explicit assertion that these columns are byte-identical before and after the backfill runs. The backfill only ever *adds* a corresponding `tenant_licenses` row derived from those values (mapping documented in full in `DatabaseDesign.md`); it does not migrate, delete, or reformat the legacy data itself. A tenant's actual application data (`tenant_data.data` — inventory, sales, repairs, customers) is in a completely separate table that no part of this feature touches at all, in either direction.

## Verdict

Automatic migrations are idempotent and failure-isolated. Code rollback is safe at any point, verified by literally doing it. Existing tenants and their licenses survive the upgrade untouched. Proceeding to Phase 5.
