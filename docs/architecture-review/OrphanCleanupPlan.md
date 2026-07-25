# Orphan Cleanup Plan

**Status: PROPOSED ONLY. Not executed. No production data has been modified to produce this document.**

Supersedes `RecommendedRemediation.md` with the exact, transactional, idempotent SQL requested, plus the explicit active-tenant-impact verification.

## 1. Exact cleanup SQL

```sql
BEGIN TRANSACTION;

-- Remove tenant_data rows with no matching tenant.
-- WHERE NOT EXISTS, not a hardcoded ID list: idempotent by construction —
-- a second run finds nothing left to delete and affects 0 rows, matching
-- the pattern already approved and used for the tenant_data backfill.
DELETE FROM tenant_data
WHERE NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = tenant_data.tenant_id
);

-- Remove user_sessions rows with no matching tenant. Same pattern.
DELETE FROM user_sessions
WHERE NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = user_sessions.tenant_id
);

COMMIT;
```

## 2. Transactional — confirmed

Both statements are wrapped in one `BEGIN TRANSACTION` / `COMMIT`. If either statement fails for any reason, nothing commits — matching the same execution pattern already used and verified for the `tenant_data` backfill (`BackfillExecutionReport.md`).

## 3. Idempotent — confirmed by construction, not just claimed

`WHERE NOT EXISTS (...)` means: after the first run, every row this SQL could ever target is gone, so a second (or hundredth) run's `WHERE NOT EXISTS` clause matches zero rows. `DELETE` on zero matching rows is a no-op — no error, no side effect, `0` rows affected. This is a stronger idempotency guarantee than a hardcoded `WHERE tenant_id IN (6)` list, because it also self-heals if this exact class of orphan recurs before the cleanup is run (rather than only cleaning the specific IDs known at plan-writing time).

## 4. Rollback SQL

See `OrphanCleanupRollback.md` — exact `INSERT` statements that reconstruct every row targeted above, byte-for-byte, using the full row content already captured during the Task 1 audit (not reconstructed after the fact from partial information).

## 5. Risk estimate

**Low.** Reasoning:
- Both `DELETE`s are scoped by `WHERE NOT EXISTS (SELECT 1 FROM tenants ...)` — structurally incapable of matching any row whose `tenant_id` corresponds to a real, current tenant. There is no code path in this SQL that could touch tenant `1, 2, 3, 4, 5,` or `9`.
- Confirmed immediately before writing this plan (re-ran the `NOT EXISTS` audit queries fresh): still exactly 1 orphaned `tenant_data` row and 6 orphaned `user_sessions` rows, same IDs as the original audit — nothing has changed in the interim that would alter this plan's targets.
- No application code reads or writes these specific rows (`RootCauseAnalysis.md` §7) — deleting them changes no observable behavior for any real user, request, or session.
- The one thing that *could* increase risk — deleting something that turns out to matter — is ruled out below.

## 6. Verification: can this cleanup affect any active tenant?

**No — verified directly, not assumed.**
```sql
-- Run before cleanup, to prove the two DELETEs above cannot touch a real tenant:
SELECT tenant_id FROM tenant_data WHERE tenant_id NOT IN (SELECT id FROM tenants);
-- → 6  (only)

SELECT tenant_id FROM user_sessions WHERE tenant_id NOT IN (SELECT id FROM tenants);
-- → 13, 14, 15, 22, 25, 28  (only)

SELECT id, shop_name FROM tenants;
-- → 1 Dada Mobile, 2 Dada Mobiles, 3 Dada Mobiless, 4 Vision Communication,
--   5 Vision Communications, 9 Vision Communications
```
Zero overlap between the two orphan-ID sets and the real-tenant-ID set. Every real tenant currently has **zero** rows in either orphan list, so the cleanup's `WHERE NOT EXISTS` clauses cannot match any of their rows regardless of execution order or timing.

**One second-order check**: could any of the 6 orphaned sessions' tokens still be actively used by someone right now? No — `RootCauseAnalysis.md` §7 and `OrphanedDataAudit.md` already established these are all this review's own test artifacts from 2026-07-18, access tokens (15-min) long expired, refresh tokens never persisted anywhere outside this review's own ephemeral test scripts. Nothing legitimate is relying on these rows continuing to exist.

## If approved

Execution would follow the exact same rigor as the `tenant_data` backfill: fresh `.backup` immediately before, execute inside the transaction above, verify row counts before/after, verify every *other* row's checksum is unaffected, verify idempotency by running it a second time, produce an execution + verification report. **Not done here — awaiting your separate go-ahead**, per this task's explicit stop condition.
