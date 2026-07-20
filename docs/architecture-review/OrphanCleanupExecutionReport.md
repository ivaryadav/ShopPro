# Orphan Cleanup — Execution Report

**Status: EXECUTED.** Approved via this task's explicit "Execute previously prepared cleanup" instruction (risk assessed as Low in `OrphanCleanupPlan.md`, re-confirmed fresh immediately before execution below).

## 0. Fresh re-verification before execution

Re-ran the orphan audit from scratch (not trusted from the prior day's `OrphanCleanupPlan.md` numbers) immediately before touching anything:

```
tenants: 1 Dada Mobile, 2 Dada Mobiles, 3 Dada Mobiless, 4 Vision Communication, 5 Vision Communications, 9 Vision Communications
orphan tenant_data: 6
orphan user_sessions: 13, 14, 15, 22, 25, 28
row counts: tenant_data=7, user_sessions=6, tenants=6
```
Identical to the audited state — nothing changed in the interim, plan's targets still accurate.

## 1. Backup

```
sqlite3 shoperpro.db ".backup backups/shoperpro_pre_orphan_cleanup_20260720_070009.db"
```
`PRAGMA integrity_check` on the backup file: `ok`.

## 2. Content captured before deletion (for the rollback, and for this record)

```
tenant_data: 6|{}|2026-07-15 10:06:13|1|      (tenant_id, data, updated_at, version, updated_by)
user_sessions (session_id, tenant_id, user_id):
  7bfa905e63e4bcc0d12f6b36f9a86531200bea879d7075ab|13|9
  832cddd0405b19e8b43bbf5a0ccb91952656afbdc4291a42|14|10
  76ba82dbbe7e86d52aa3609d6efa9cb84d6a59ec28f011db|15|11
  8e6bffb38ddc0f7b6784e9d57b29b2a1e2d754cf933d2ec1|22|18
  9fb762c1b0542cf0c13c94b9b2afae5f86b262cc99a1188d|25|21
  75d04ece88ec6cbfd721c81a15a3edf795b296190e53865d|28|24
```
Matches `OrphanCleanupRollback.md`'s previously-captured content exactly.

Also captured, before execution: a SHA-256 checksum of every real-tenant `tenant_data` row (`tenant_id||version||updated_at||data`, for tenants 1,2,3,4,5,9) — `73484af875cbfc5b8c775bf8913f961d78545dc79d0b2406f9ff5c272cd53652` — to prove after execution that nothing outside the orphan set was touched, not just that row *counts* look right.

## 3. Execution

Ran exactly the SQL from `OrphanCleanupPlan.md` §1, unmodified:
```sql
BEGIN TRANSACTION;
DELETE FROM tenant_data WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = tenant_data.tenant_id);
DELETE FROM user_sessions WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = user_sessions.tenant_id);
COMMIT;
```
Exit code 0, transaction committed successfully.

## 4. Verification

- **Row counts after**: `tenant_data=6` (7→6, exactly 1 removed), `user_sessions=0` (6→0, exactly 6 removed — all 6 pre-existing rows were orphans; there were zero legitimate sessions in this database at execution time), `tenants=6` (unchanged), `users=2` (unchanged).
- **Re-ran the orphan audit**: both queries now return zero rows.
- **Real-tenant checksum after**: `73484af875cbfc5b8c775bf8913f961d78545dc79d0b2406f9ff5c272cd53652` — **identical** to the pre-execution checksum. Every real tenant's `tenant_data` row is byte-for-byte unaffected.
- **`PRAGMA integrity_check`**: `ok`.
- **`PRAGMA foreign_key_check`**: no violations.
- **Rollback verified functional**: see `OrphanCleanupVerificationReport.md`.

## A methodology note worth recording

The first attempt at the rollback-verification step (below) produced a spurious `UNIQUE constraint failed` error from applying the rollback `INSERT`s to a disposable copy made via plain `cp shoperpro.db /tmp/...`. Root cause: this database runs in WAL mode, and the just-committed `DELETE` transaction was sitting in `shoperpro.db-wal` (28,872 bytes, confirmed via `ls`), not yet checkpointed into the main `.db` file — a raw `cp` of only the main file produced a **stale** copy that still had the orphaned rows, so the rollback `INSERT` collided with rows that, on production, no longer existed. This was a test-methodology artifact, not a problem with the actual cleanup: every verification query in this report used `sqlite3 shoperpro.db "..."`, and WAL-mode readers always see committed data transparently merged in regardless of checkpoint state — those results were accurate throughout. Fixed by running `PRAGMA wal_checkpoint(FULL)` (standard, non-destructive — confirmed all 7 WAL frames checkpointed, re-verified row counts/checksum/integrity unchanged afterward) and switching the disposable-copy method to `.backup` (WAL-aware, the same method used for the real pre-execution backup) instead of raw `cp` for any future test needing a point-in-time snapshot.

## Files changed

- `server/shoperpro.db` — production database. 1 `tenant_data` row and 6 `user_sessions` rows deleted (all confirmed orphaned, zero overlap with any real tenant).
- `server/backups/shoperpro_pre_orphan_cleanup_20260720_070009.db` (+`-shm`) — new pre-execution backup, integrity-verified.

No application code was changed to perform this execution.
