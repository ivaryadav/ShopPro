-- 005_cloud_backup_domain — RC1 Sprint 3 (Cloud Backup Domain).
--
-- Scope: the `cloud_backups` table exactly as local.js defines it
-- (local.js:186-195) — a single-row-per-license-key blob store the
-- OFFLINE DESKTOP product pushes/pulls its data to/from, via
-- POST/GET/DELETE /api/cloud/backup(/restore). This is genuinely
-- server-side, hosted-backend data (it lives in local.js's own database,
-- accessed over HTTP) — ADR-0003 excludes the desktop app's OWN
-- client-side data model (localStorage) from the MariaDB migration, not
-- server-side tables the desktop happens to call into. Per ADR-0002's
-- "one database" principle, this table belongs in MariaDB same as
-- everything else in local.js's schema.
--
-- Deliberately NOT tenant-scoped — matches local.js exactly: this table
-- has no tenant_id column at all. Isolation is by `key_hash` (the
-- desktop's license-key hash, unique per install), not by tenant_id —
-- a structurally different isolation model than every other domain
-- migrated so far, preserved as-is, not retrofitted with a tenant_id
-- local.js never had.

CREATE TABLE IF NOT EXISTS cloud_backups (
  key_hash     VARCHAR(255) PRIMARY KEY,
  shop_name    VARCHAR(255),
  data         LONGTEXT NOT NULL,
  backed_up_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
