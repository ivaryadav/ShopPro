-- 003_licensing_domain — RC1 Sprint 1 (Licensing Domain).
--
-- Scope: License, Subscription, Activation, Renewal, Expiry, Grace Period,
-- Device Limits — implementing local.js's real, already-shipped
-- subscription_plans/tenant_licenses/license_history tables (local.js:228-273)
-- exactly, on MariaDB. Deliberately excludes Authentication (trusted_devices
-- already exists, migrations/001), Operations, Administration
-- (admin_credentials/admin sessions), and Cloud Backup — none of those
-- tables are created here.
--
-- Two columns from local.js's schema are NOT carried forward, both
-- deliberately, not silently:
--   - subscription_plans/tenant_licenses's SQLite TEXT timestamp columns
--     become proper TIMESTAMP/DATE types here, matching this project's
--     established MariaDB convention (migrations 001/002) — a structural
--     type change, not a behavior change (SQLite's TEXT datetime and
--     MariaDB's TIMESTAMP represent the same values).
--   - tenants.license_key_hash/license_expiry/license_plan (the legacy,
--     pre-tenant_licenses columns local.js's `tenants` table still carries
--     for backward compatibility) are NOT added to server/src/'s `tenants`
--     table — that table is owned by migrations/001 (Identity & Tenant
--     Core, Phase 2), out of scope for this sprint to modify. This
--     sprint's `getLicenseStatus` therefore returns tenant_licenses' own
--     fields only, not local.js's outer legacy-compatibility fields (see
--     docs/architecture/Licensing.md for the full reasoning).

-- ── subscription_plans ───────────────────────────────────────────────────
-- Matches local.js:228-237 exactly. Seeded with the same 3 tiers
-- (local.js:312-314).
CREATE TABLE IF NOT EXISTS subscription_plans (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(50) NOT NULL UNIQUE,
  label        VARCHAR(100) NOT NULL,
  device_limit INT NOT NULL,
  trial_days   INT,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── tenant_licenses ───────────────────────────────────────────────────────
-- Matches local.js:239-261 exactly, including the 5-state CHECK enum,
-- the unique (nullable) license_key index, and the status index.
CREATE TABLE IF NOT EXISTS tenant_licenses (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id                BIGINT NOT NULL UNIQUE,
  status                   ENUM('PENDING_APPROVAL','ACTIVE','READ_ONLY','SUSPENDED','ARCHIVED') NOT NULL DEFAULT 'PENDING_APPROVAL',
  plan_code                VARCHAR(50) NOT NULL DEFAULT 'TRIAL',
  requested_plan_code      VARCHAR(50),
  billing_cycle            VARCHAR(20),
  device_limit             INT NOT NULL DEFAULT 2,
  license_key              VARCHAR(50),
  requested_devices_bucket VARCHAR(20),
  requested_modules        JSON NOT NULL,
  starts_at                TIMESTAMP NULL,
  expires_at               TIMESTAMP NULL,
  read_only_since          TIMESTAMP NULL,
  suspended_since          TIMESTAMP NULL,
  last_verified_at         TIMESTAMP NULL,
  offline_grace_days       INT NOT NULL DEFAULT 15,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenant_licenses_key (license_key),
  INDEX idx_tenant_licenses_status (status),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_code) REFERENCES subscription_plans(code)
);

-- ── license_history ───────────────────────────────────────────────────────
-- Matches local.js:263-273 exactly — the audit trail every licensing
-- action writes to (REGISTERED, EMAIL_VERIFIED, APPROVED, REJECTED,
-- PLAN_ASSIGNED, TRIAL_STARTED, KEY_GENERATED, KEY_REGENERATED, EXTENDED,
-- STATUS_CHANGED, SESSIONS_KILLED, NOTE_ADDED, CALL_LOGGED, BACKFILLED —
-- event_type is free TEXT in local.js, not an enum, so it stays VARCHAR
-- here too rather than inventing a closed set local.js itself doesn't have).
CREATE TABLE IF NOT EXISTS license_history (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT NOT NULL,
  event_type  VARCHAR(50) NOT NULL,
  from_status VARCHAR(20),
  to_status   VARCHAR(20),
  detail      VARCHAR(1000) NOT NULL DEFAULT '',
  actor       VARCHAR(20) NOT NULL DEFAULT 'system',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_license_history_tenant (tenant_id, created_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Seed the 3 plan tiers — matches local.js:312-314 exactly.
INSERT IGNORE INTO subscription_plans (code, label, device_limit, trial_days, sort_order) VALUES ('TRIAL', 'Trial', 2, 14, 0);
INSERT IGNORE INTO subscription_plans (code, label, device_limit, trial_days, sort_order) VALUES ('BASIC', 'Basic', 2, NULL, 1);
INSERT IGNORE INTO subscription_plans (code, label, device_limit, trial_days, sort_order) VALUES ('PREMIUM', 'Premium', 5, NULL, 2);
