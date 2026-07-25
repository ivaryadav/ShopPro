-- 004_administration_domain — RC1 Sprint 2 (Administration Domain).
--
-- Scope: Admin Dashboard, Tenant Management, Registration Approval,
-- Subscription Administration, License Management, User Administration,
-- Device Management — all as CONTROLLERS/ROUTES/SERVICES calling into
-- already-existing tables (tenants, users, trusted_devices from
-- migrations/001, and subscription_plans/tenant_licenses/license_history
-- from migrations/003).
-- The ONE new table this migration adds is `admin_credentials` — matches
-- local.js:298-303 exactly (single-row web-admin credential, replacing the
-- ADMIN_KEY env var as the source of truth once seeded).
--
-- Deliberately excludes any change to migrations/001 or migrations/003 —
-- "Do NOT touch: Authentication" and "Licensing (except integration)" are
-- honored at the file level: no ALTER TABLE against tenants/users/
-- trusted_devices/tenant_licenses/subscription_plans/license_history
-- appears anywhere in this file.

CREATE TABLE IF NOT EXISTS admin_credentials (
  id            INT PRIMARY KEY,
  password_hash VARCHAR(255) NOT NULL,
  algo          VARCHAR(20) NOT NULL DEFAULT 'sha256',
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_admin_credentials_single_row CHECK (id = 1)
);
