-- 001_initial — migration framework proof-of-concept.
--
-- This is NOT real business schema (Phase 1 explicitly forbids creating
-- production schema or migrating business data). It exists solely to
-- prove migrationRunner.js works end-to-end: discover, apply, checksum,
-- record, and (via 001_initial.rollback.sql) revert.
--
-- Phase 2 (Auth & Tenant Core) adds the real first migrations
-- (tenants, users) and this placeholder table is dropped as part of that
-- phase's own migration, once real schema exists to replace it with.

CREATE TABLE IF NOT EXISTS _framework_example (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  label      VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
