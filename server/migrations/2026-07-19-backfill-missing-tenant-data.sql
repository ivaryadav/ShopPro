-- ═══════════════════════════════════════════════════════════════════════
-- Backfill: create tenant_data rows for tenants that have none
-- ═══════════════════════════════════════════════════════════════════════
-- Fixes: EC-1 / Wave01-RegressionReport.md §4 — tenants predating some
-- registration path never got an initial tenant_data row, and Wave 0's
-- optimistic-concurrency rewrite of PUT /api/data (which replaced the old
-- INSERT..ON CONFLICT DO UPDATE with an UPDATE-only statement) has no
-- insert fallback, so those tenants could never save data.
--
-- Safety properties:
--   - Idempotent: WHERE NOT EXISTS means a second run inserts zero rows.
--   - Non-destructive: pure INSERT, no UPDATE/DELETE/ON CONFLICT clause of
--     any kind — structurally incapable of touching a row that already
--     exists, regardless of that row's contents.
--   - New rows are created with empty data ('{}'), version 1, matching
--     exactly what a brand-new tenant gets at registration time
--     (server/local.js: INSERT INTO tenant_data (tenant_id, data) VALUES
--     (?, '{}') — this migration is the same shape, applied retroactively).
--
-- Run with:  sqlite3 shoperpro.db < migrations/2026-07-19-backfill-missing-tenant-data.sql
-- Rollback:  see 2026-07-19-backfill-missing-tenant-data-ROLLBACK.sql
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO tenant_data (tenant_id, data, version, updated_at, updated_by)
SELECT
  t.id,
  '{}',
  1,
  datetime('now'),
  NULL
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_data d WHERE d.tenant_id = t.id
);
