# Backfill Migration — Phase 1: Dry Run Report

**No production data has been modified. This is a read-only report.**

## Backup

Taken before any other action, via SQLite's `.backup` command (WAL-aware — correct even against a live, running server, no downtime required):

- File: `server/backups/shoperpro_pre_backfill_20260719_023642.db`
- Verified: row counts in the backup match the live database exactly across all 4 tables (`tenants`: 6, `tenant_data`: 3, `users`: 2, `user_sessions`: 5).
- A SHA-256 checksum of every existing `tenant_data` row's full content (`tenant_id, version, updated_at, updated_by, data`) was also captured separately, to mathematically verify after execution that none of the 3 pre-existing rows were altered — not just structurally argued from the SQL, but empirically checked.

## Migration files generated

- `server/migrations/2026-07-19-backfill-missing-tenant-data.sql` — the forward migration.
- `server/migrations/2026-07-19-backfill-missing-tenant-data-ROLLBACK.sql` — the rollback, targeting the exact tenant IDs identified below (not a heuristic).

```sql
INSERT INTO tenant_data (tenant_id, data, version, updated_at, updated_by)
SELECT t.id, '{}', 1, datetime('now'), NULL
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_data d WHERE d.tenant_id = t.id
);
```

**Why this satisfies every requirement:**
- **Non-destructive** — pure `INSERT`, no `UPDATE`/`DELETE`/`ON CONFLICT` clause exists anywhere in the statement; it is structurally incapable of touching a row that already exists.
- **Idempotent / safe to run multiple times** — the `WHERE NOT EXISTS` guard means a second run's `SELECT` matches zero tenants (all now have rows), so it inserts nothing. This will be proven empirically in Phase 2/3, not just asserted.
- **Only creates missing rows** — the `WHERE NOT EXISTS` clause is the entire selection logic; there is no other path to a row being inserted.
- **New rows match what a real registration produces** — `data: '{}'`, `version: 1` — identical shape to `server/local.js`'s own `INSERT INTO tenant_data (tenant_id, data) VALUES (?, '{}')` at registration time, just applied retroactively for tenants that predate whatever created that gap.

## Dry-run simulation — exactly what would happen

Ran the migration's own `SELECT` clause standalone (read-only, confirmed zero writes before and after via `tenant_data` row count staying at 3):

| Tenant ID | Shop Name | `tenant_data` exists? | Action Required |
|---|---|---|---|
| 1 | Dada Mobile | **NO** | **CREATE ROW** |
| 2 | Dada Mobiles | **NO** | **CREATE ROW** |
| 3 | Dada Mobiless | **NO** | **CREATE ROW** |
| 4 | Vision Communication | **NO** | **CREATE ROW** |
| 5 | Vision Communications | YES | None |
| 9 | Vision Communications | YES | None |

Simulated insert values for the 4 affected rows (from the actual `SELECT`, not hand-written):

| tenant_id | data | version | updated_by |
|---|---|---|---|
| 1 | `{}` | 1 | NULL |
| 2 | `{}` | 1 | NULL |
| 3 | `{}` | 1 | NULL |
| 4 | `{}` | 1 | NULL |

## What is explicitly NOT touched

Tenants #5 and #9 (both "Vision Communications" — a pre-existing duplicate pair, unrelated to this migration) already have `tenant_data` rows and are excluded by the `WHERE NOT EXISTS` clause. Their rows, and tenant #9's real captured data (`Ravi`, 1258 bytes as of 2026-07-17), are untouched by this migration by construction.

## Awaiting approval to proceed to Phase 2 (execution).
