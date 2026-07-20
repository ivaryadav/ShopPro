# Backfill Migration — Rollback Instructions

Two ways to roll back, depending on what's actually needed.

## Option A — Targeted rollback (removes only what this migration created)

```bash
sqlite3 server/shoperpro.db < server/migrations/2026-07-19-backfill-missing-tenant-data-ROLLBACK.sql
```
This runs:
```sql
DELETE FROM tenant_data WHERE tenant_id IN (1, 2, 3, 4);
```
- Removes exactly the 4 rows this migration created, by their specific `tenant_id`s captured at dry-run/execution time — not a heuristic (e.g. not "version=1 AND data='{}'", which could accidentally catch a genuinely new tenant registered normally after this migration ran).
- **Does not touch tenants 5, 6, or 9** — the `IN (1,2,3,4)` list is exhaustive and explicit.
- **If tenants #1–4 have since saved real data through the app** (i.e., their row's version is now > 1), this rollback still deletes it — "rollback" means undoing the backfill, including anything saved into the row since. If that's not what's wanted at rollback time, use Option B instead.
- Safe to run even if some of tenants #1–4 have already been deleted for unrelated reasons (the `DELETE` simply matches fewer or zero rows).

## Option B — Full restore from the pre-migration backup

```bash
# Stop the server first — replacing the live DB file while it's open will corrupt it
pkill -f "node local.js"

cp server/shoperpro.db server/shoperpro.db.pre-rollback-safety-copy   # optional but recommended
cp server/backups/shoperpro_pre_backfill_20260719_023642.db server/shoperpro.db
rm -f server/shoperpro.db-wal server/shoperpro.db-shm                 # stale WAL/SHM files from the old file, if present

node server/local.js   # restart
```
- Restores the database to its **exact** state at the moment of the Phase 1 backup — not just the 4 backfilled rows, but literally everything, byte for byte.
- Use this if anything else changed in the database between the backup and the rollback that also needs undoing (this migration's own execution didn't cause anything else to change — verified via checksum — but this option exists for completeness/defense-in-depth).
- Requires the server to be stopped during the file swap (SQLite files should not be replaced out from under an open connection).

## Which to use

**Option A is almost certainly the right choice** — it's precise, doesn't require downtime, and doesn't discard any other legitimate activity that may have happened since the backup (new registrations, other tenants' saves, session activity). Option B is the heavier hammer, kept available in case the targeted rollback isn't sufficient for some reason not currently anticipated.

## Verifying a rollback took effect

```bash
sqlite3 server/shoperpro.db "SELECT tenant_id FROM tenant_data ORDER BY tenant_id;"
# Option A: expect 5, 6, 9 (tenant_id 6 is the pre-existing unrelated orphan — see BackfillExecutionReport.md)
# Option B: expect exactly what the backup had — 5, 6, 9
```

## Files referenced

| File | Purpose |
|---|---|
| `server/backups/shoperpro_pre_backfill_20260719_023642.db` | Full pre-migration database snapshot |
| `server/migrations/2026-07-19-backfill-missing-tenant-data.sql` | The forward migration (for reference / re-running after an Option B restore, if desired) |
| `server/migrations/2026-07-19-backfill-missing-tenant-data-ROLLBACK.sql` | The targeted rollback (Option A) |
