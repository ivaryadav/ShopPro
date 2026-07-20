# Recommended Remediation — Orphaned Data

**Proposed only. Nothing in this document has been executed.** Per the explicit stop condition on Task 1 ("STOP if any production data modification would be required"), cleanup is a separate action awaiting your approval — same dry-run-then-approve pattern already used for the `tenant_data` backfill.

## Proposed migration (not run)

```sql
-- Remove the 1 orphaned tenant_data row and 6 orphaned user_sessions rows
-- identified in OrphanedDataAudit.md. Targets exact IDs found during that
-- read-only audit — not a broad heuristic — so this cannot touch any of the
-- 6 real tenants or any future legitimate session.

DELETE FROM tenant_data
WHERE tenant_id = 6;

DELETE FROM user_sessions
WHERE tenant_id IN (13, 14, 15, 22, 25, 28);
```

Both statements are simple, targeted `DELETE`s against rows already proven (via `WHERE NOT EXISTS` against `tenants`) to reference nothing that exists. Following this engagement's established database rules, executing this — if approved — would go through the same rigor as the backfill: backup first, run inside a transaction, verify row counts before/after, verify every *other* row's checksum is unaffected, produce an execution + verification report.

## Why this is safe to approve

- Every targeted row was independently confirmed orphaned by a `NOT EXISTS` join against the live `tenants` table at audit time (`OrphanedDataAudit.md`), not inferred or assumed.
- Zero real tenants (1, 2, 3, 4, 5, 9) or their data are touched — none of their IDs appear in either `DELETE`'s target list.
- Nothing currently depends on these rows (`RootCauseAnalysis.md` §7) — deleting them changes no observable behavior for any real user.

## Process fix, to prevent recurrence (recommended regardless of whether the cleanup above is approved)

The underlying gap isn't the orphaned rows themselves — it's that manual `sqlite3` CLI cleanup doesn't enforce foreign keys by default. Two options, not mutually exclusive:

1. **Discipline fix (immediate, zero cost)**: any future manual cleanup via the `sqlite3` CLI should open with `PRAGMA foreign_keys = ON;` before any `DELETE`. One line, makes `ON DELETE CASCADE` behave as designed.
2. **Structural fix (addressed by Task 2 of this same work order)**: test tenants should never be created in `shoperpro.db` at all. Once tests run against isolated, disposable temp databases (`DatabaseIsolationPlan.md`), there's no manual cleanup step to get wrong — the entire temp file is deleted after each test run. This is the more durable fix and is being implemented as part of this same task regardless of the cleanup decision above.

## What happens if this is not approved

Nothing breaks. Per `RootCauseAnalysis.md` §7, the risk of leaving these 7 rows in place is low and inert — this is a hygiene recommendation, not an urgent fix. Safe to defer indefinitely, or to bundle into a future maintenance window, if preferred over acting on it now.
