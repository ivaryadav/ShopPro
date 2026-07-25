-- 001_identity_tenant_core — Phase 2 (Identity & Tenant Core).
--
-- Scope, per docs/architecture/CanonicalDomainModel.md and the Phase 2
-- mission: Tenant, Role, Permission, User, Session, TrustedDevice ONLY.
-- Deliberately excludes tenant_licenses/license_history/subscription_plans/
-- admin_credentials/cloud_backups (Licensing & Administration domains,
-- out of scope for this phase) and every Operations-domain table
-- (inventory/sales/repairs/etc. — currently desktop-only, not modeled
-- server-side at all, see CanonicalDomainModel.md).
--
-- Behavioral source of truth: server/local.js (SQLite) + server/sessions.js.
-- Every deviation from that behavior is called out in a comment below and
-- in docs/database/MigrationNotes.md — none are silent.

-- ── tenants ───────────────────────────────────────────────────────────────
-- Carries only the legacy status/suspend_reason columns from local.js's
-- `tenants` table — NOT license_key_hash/license_expiry/license_plan,
-- which are Licensing-domain fields that happen to live on that table
-- today but are out of scope here (MigrationNotes.md).
CREATE TABLE IF NOT EXISTS tenants (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  shop_name      VARCHAR(255) NOT NULL,
  status         ENUM('active','paused','terminated') NOT NULL DEFAULT 'active',
  suspend_reason VARCHAR(500) NOT NULL DEFAULT '',
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── roles ─────────────────────────────────────────────────────────────────
-- Normalizes local.js's users.role TEXT column into a real reference table.
-- Seeded with EXACTLY the hosted server's own 2-value enum ('owner','staff')
-- — NOT the desktop app's 5 roles (manager/technician/superadmin are
-- desktop-only, out of scope per ADR-0003).
CREATE TABLE IF NOT EXISTS roles (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  code  VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL
);

-- ── permissions ───────────────────────────────────────────────────────────
-- DomainModel.md confirmed no Permission entity exists anywhere in the
-- current code — every authorization check is a hardcoded
-- `role !== 'owner'` string comparison at the point of use. This table (and
-- role_permissions below) is new, real structure requested by this phase's
-- layered-architecture mission — see docs/adr/0006-table-driven-authorization.md
-- for why building it is *not* the same thing as changing who is allowed to
-- do what: it's seeded to reproduce today's exact 3 hardcoded gates,
-- verified byte-for-byte equivalent by this phase's authorization tests.
-- (GET /api/data/users, despite listing users, has NO role gate in
-- local.js at all — any authenticated, active tenant user may call it.
-- Confirmed by grepping every `role !== 'owner'` in local.js: exactly 4
-- hits, one of which — /api/auth/renew-license — is Licensing-domain,
-- out of scope, leaving exactly 3 in-scope gates.)
CREATE TABLE IF NOT EXISTS permissions (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  code  VARCHAR(100) NOT NULL UNIQUE,
  label VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INT NOT NULL,
  permission_id INT NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- ── users ─────────────────────────────────────────────────────────────────
-- Matches local.js's `users` table field-for-field, with `role` normalized
-- to `role_id` (see roles table above — a structural, non-behavioral change:
-- the same 2 role values are the only ones ever assignable, now via FK
-- instead of a free TEXT column).
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  username      VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255),
  mobile        VARCHAR(20),
  email         VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role_id       INT NOT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_login    TIMESTAMP NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_tenant_username (tenant_id, username),
  UNIQUE KEY uq_users_mobile (mobile),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- ── user_sessions ─────────────────────────────────────────────────────────
-- Matches server/sessions.js's schema field-for-field. ONE deliberate
-- deviation: local.js's SQLite version declares no FOREIGN KEY on
-- tenant_id/user_id at all (confirmed in EntityRelationship.md — enforced
-- only in application logic). This migration adds real FKs — a low-risk
-- hardening, not a behavior change: a session row is never created for a
-- nonexistent tenant/user in current logic, so the constraint only ever
-- rejects states that were already impossible to reach. See
-- docs/database/MigrationNotes.md.
CREATE TABLE IF NOT EXISTS user_sessions (
  id                      BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id              VARCHAR(64) NOT NULL UNIQUE,
  tenant_id               BIGINT NOT NULL,
  user_id                 BIGINT NOT NULL,
  jwt_id                  VARCHAR(32),
  device_id               VARCHAR(255),
  login_time              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  current_page            VARCHAR(255),
  status                  ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  refresh_token_hash      VARCHAR(64),
  prev_refresh_token_hash VARCHAR(64),
  refresh_rotated_at      TIMESTAMP NULL,
  ip_address              VARCHAR(64),
  browser                 VARCHAR(50),
  os                      VARCHAR(50),
  created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sessions_user (tenant_id, user_id),
  INDEX idx_sessions_refresh (refresh_token_hash),
  INDEX idx_sessions_prev_refresh (prev_refresh_token_hash),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── trusted_devices ───────────────────────────────────────────────────────
-- Matches local.js's trusted_devices table field-for-field exactly.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT NOT NULL,
  user_id        BIGINT NOT NULL,
  device_id      VARCHAR(255) NOT NULL,
  device_name    VARCHAR(255),
  browser        VARCHAR(50),
  os             VARCHAR(50),
  first_login_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trusted_devices (tenant_id, user_id, device_id),
  INDEX idx_trusted_devices_tenant (tenant_id),
  INDEX idx_trusted_devices_user (user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Seed data — reproduces today's exact role/permission behavior ────────
INSERT IGNORE INTO roles (code, label) VALUES ('owner', 'Owner');
INSERT IGNORE INTO roles (code, label) VALUES ('staff', 'Staff');

-- These 3 codes are the ONLY 3 real, in-scope `role !== 'owner'` gates
-- found in local.js (view sessions, revoke session, add staff). GET
-- /api/data/users (list users) has NO role gate in local.js at all — any
-- authenticated, active tenant user may call it, so no permission is
-- seeded for it (that would invent a restriction that doesn't exist
-- today). No permission is invented beyond what already exists as a
-- hardcoded check today.
INSERT IGNORE INTO permissions (code, label) VALUES ('sessions:view', 'View active sessions');
INSERT IGNORE INTO permissions (code, label) VALUES ('sessions:revoke', 'Revoke a session');
INSERT IGNORE INTO permissions (code, label) VALUES ('staff:add', 'Add a staff user');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = 'owner';
-- 'staff' intentionally gets zero rows here — matching current behavior,
-- where staff cannot do any of these 3 things.
