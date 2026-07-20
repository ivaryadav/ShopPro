# Backfill Migration — Phase 2: Execution Report

## Pre-execution reconfirmation

- Backup file `server/backups/shoperpro_pre_backfill_20260719_023642.db` — re-verified present, `PRAGMA integrity_check` returned `ok`, row counts identical to the live database at the moment of execution (`tenants`: 6, `tenant_data`: 3). Nothing changed between the Phase 1 dry run and Phase 2 execution.
- `sqlite3` version: 3.51.0 (supports `RETURNING`, used to record exactly what was inserted rather than inferring it).

## Execution

Ran inside an explicit transaction:
```sql
BEGIN TRANSACTION;
INSERT INTO tenant_data (tenant_id, data, version, updated_at, updated_by)
SELECT t.id, '{}', 1, datetime('now'), NULL
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM tenant_data d WHERE d.tenant_id = t.id)
RETURNING tenant_id;
COMMIT;
```
- Exit code: `0`
- **Rows inserted (captured via `RETURNING`, not inferred): tenant_id `1, 2, 3, 4`** — exactly and only the four identified in the Phase 1 dry run.
- `tenant_data` row count: **3 → 7** (delta +4, matching the dry run's prediction exactly).

## Idempotency check

Ran the identical script a second time, immediately after:
- Exit code: `0`
- Output: **empty** — zero rows matched `WHERE NOT EXISTS` (all tenants now have a row), so zero rows were inserted.
- `tenant_data` row count after second run: **still 7.**

## Non-destructiveness check

SHA-256 checksum of the 3 pre-existing rows (`tenant_id, version, updated_at, updated_by, data` for tenant_id 5, 6, 9), computed before execution and again after:

```
Before: 3cacc26fc6332f9f073d10911487e1b2a8f79fb117334f74d05f0d7a780b5365
After:  3cacc26fc6332f9f073d10911487e1b2a8f79fb117334f74d05f0d7a780b5365
```
**Identical.** Not a single byte of any pre-existing row changed.

## Convention preservation

New rows match exactly what `server/local.js`'s own registration endpoint produces for a brand-new tenant (`INSERT INTO tenant_data (tenant_id, data) VALUES (?, '{}')`, relying on the same column defaults for `version` and the same `datetime('now')` convention for `updated_at`) — this migration is the identical shape, applied retroactively, not a bespoke format.

## Result table

| tenant_id | shop_name | Before | After | Action taken |
|---|---|---|---|---|
| 1 | Dada Mobile | no row | version 1, `{}` | **Created** |
| 2 | Dada Mobiles | no row | version 1, `{}` | **Created** |
| 3 | Dada Mobiless | no row | version 1, `{}` | **Created** |
| 4 | Vision Communication | no row | version 1, `{}` | **Created** |
| 5 | Vision Communications | version 1, real data (1168 bytes) | unchanged | None |
| 9 | Vision Communications | version 1, real data (1258 bytes) | unchanged | None |

## Note: pre-existing orphaned row (not created or touched by this migration)

`tenant_data` also contains a row for `tenant_id = 6`, which does not correspond to any current row in `tenants` (visible in the raw `SELECT tenant_id FROM tenant_data` output, but absent from any query that joins to `tenants`). This predates this migration — it's debris from an earlier, unrelated test-tenant cleanup during this engagement's own testing, where the `tenants` row was deleted but its `tenant_data` row was not. This migration's `WHERE NOT EXISTS` logic is keyed off `tenants`, so it never considered or touched this row. Flagging for transparency; not remediated here since it's out of scope for "create missing rows" (this row isn't missing — it's orphaned, a different kind of cleanup) and touching it wasn't authorized as part of this task.
