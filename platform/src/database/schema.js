/**
 * platform/src/database/schema.js
 *
 * Z-SUPERADMIN's own schema — every table is prefixed platform_* or is a
 * platform-owned cross-product concept (organizations, organization_*).
 * None of these tables, or this file, ever references a specific product
 * by anything other than a row in platform_products — "no product-specific
 * business logic should exist inside Z-SUPERADMIN" applies to the schema
 * too, not just the code.
 *
 * Idempotent CREATE TABLE IF NOT EXISTS + additive ALTER TABLE, matching
 * the exact migration convention server/local.js already uses — the
 * proven, simplest-that-works pattern for a single SQLite file, applied
 * fresh here (no legacy to preserve in a brand-new schema).
 */
'use strict';

function runMigration(db, sql, label) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) {
      console.error(`[PLATFORM MIGRATION FAILED] ${label}:`, e.message);
    }
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_roles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_permissions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_role_permissions (
      role_id       INTEGER NOT NULL REFERENCES platform_roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES platform_permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS platform_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      algo          TEXT NOT NULL DEFAULT 'bcrypt',
      role_id       INTEGER NOT NULL REFERENCES platform_roles(id),
      is_active     INTEGER NOT NULL DEFAULT 1,
      last_login    TEXT,
      locked_until  TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_login_failures (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES platform_users(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      ip         TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_platform_login_failures_email ON platform_login_failures(email, created_at);

    -- Mirrors server/sessions.js's user_sessions shape (proven pattern),
    -- entirely separate table/token space from ShopERP's own sessions.
    CREATE TABLE IF NOT EXISTS platform_sessions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT NOT NULL UNIQUE,
      user_id        INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
      jwt_id         TEXT,
      login_time     TEXT DEFAULT (datetime('now')),
      last_activity  TEXT DEFAULT (datetime('now')),
      status         TEXT NOT NULL DEFAULT 'active',
      ip_address     TEXT,
      browser        TEXT,
      os             TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_platform_sessions_user ON platform_sessions(user_id);

    -- The Product Registry. Adding ZLAB/ZHospital/etc. later is ONE INSERT
    -- here — no code change, no architectural change (Non-Negotiable
    -- Principle #4). feature_flags/routes/permissions are descriptive JSON
    -- metadata the platform stores and displays; it never interprets or
    -- enforces them (Non-Negotiable Principle #2 — no product-specific
    -- business logic lives here).
    CREATE TABLE IF NOT EXISTS platform_products (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      logo_url      TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      version       TEXT NOT NULL DEFAULT '1.0.0',
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','planned')),
      license_model TEXT NOT NULL DEFAULT 'subscription',
      feature_flags TEXT NOT NULL DEFAULT '[]',
      routes        TEXT NOT NULL DEFAULT '[]',
      permissions   TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT DEFAULT (datetime('now'))
    );

    -- Every ZMAX customer becomes ONE organization here, regardless of how
    -- many products they use.
    CREATE TABLE IF NOT EXISTS organizations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name TEXT NOT NULL,
      owner_name   TEXT NOT NULL DEFAULT '',
      email        TEXT NOT NULL DEFAULT '',
      phone        TEXT NOT NULL DEFAULT '',
      address      TEXT NOT NULL DEFAULT '',
      gst_number   TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','ACTIVE','SUSPENDED','ARCHIVED')),
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_organizations_email ON organizations(email);

    -- Which products an organization has. One org, many products (ABC
    -- Healthcare + ShopERP + ZLAB + ZHospital is exactly 3 rows here).
    CREATE TABLE IF NOT EXISTS organization_products (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id      INTEGER NOT NULL REFERENCES platform_products(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      activated_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(organization_id, product_id)
    );

    -- The platform owns every license, for every org, for every product —
    -- one row per (organization, product) pair. Same proven 5-state model
    -- ShopERP's own tenant_licenses uses (TRIAL added as its own explicit
    -- state here rather than a plan_code, since the mission's License
    -- Center explicitly calls out Trial and Grace Period as first-class
    -- concepts to track).
    CREATE TABLE IF NOT EXISTS platform_licenses (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id         INTEGER NOT NULL REFERENCES platform_products(id) ON DELETE CASCADE,
      plan_code          TEXT NOT NULL DEFAULT 'TRIAL',
      status             TEXT NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL','ACTIVE','READ_ONLY','SUSPENDED','ARCHIVED')),
      starts_at          TEXT DEFAULT (datetime('now')),
      expires_at         TEXT,
      grace_period_days  INTEGER NOT NULL DEFAULT 15,
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now')),
      UNIQUE(organization_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_platform_licenses_status ON platform_licenses(status);
    CREATE INDEX IF NOT EXISTS idx_platform_licenses_expiry ON platform_licenses(expires_at);

    -- One unified, general-purpose audit log for every platform action —
    -- same "event_type/detail/actor, reused for everything" pattern
    -- proven in ShopERP's own license_history table.
    CREATE TABLE IF NOT EXISTS platform_audit_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_user_id INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
      organization_id  INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      product_id       INTEGER REFERENCES platform_products(id) ON DELETE SET NULL,
      action           TEXT NOT NULL,
      old_value        TEXT,
      new_value        TEXT,
      detail           TEXT NOT NULL DEFAULT '',
      ip_address       TEXT NOT NULL DEFAULT '',
      device           TEXT NOT NULL DEFAULT '',
      created_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_platform_audit_org ON platform_audit_logs(organization_id, created_at);

    CREATE TABLE IF NOT EXISTS platform_notifications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      product_id      INTEGER REFERENCES platform_products(id) ON DELETE SET NULL,
      type            TEXT NOT NULL,
      channel         TEXT NOT NULL DEFAULT 'email',
      recipient       TEXT NOT NULL DEFAULT '',
      subject         TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'sent',
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_platform_notifications_org ON platform_notifications(organization_id, created_at);

    CREATE TABLE IF NOT EXISTS platform_settings (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      platform_name TEXT NOT NULL DEFAULT 'Z-SUPERADMIN',
      support_email TEXT NOT NULL DEFAULT '',
      support_phone TEXT NOT NULL DEFAULT '',
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_feature_flags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      is_enabled  INTEGER NOT NULL DEFAULT 0,
      product_id  INTEGER REFERENCES platform_products(id) ON DELETE CASCADE,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- Generic, product-agnostic device tracking per org+product — populated
    -- by each product's own future integration/sync (not built in this
    -- foundation milestone), read here purely for support visibility.
    CREATE TABLE IF NOT EXISTS organization_devices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id      INTEGER NOT NULL REFERENCES platform_products(id) ON DELETE CASCADE,
      device_id       TEXT NOT NULL,
      device_name     TEXT NOT NULL DEFAULT '',
      browser         TEXT NOT NULL DEFAULT '',
      os              TEXT NOT NULL DEFAULT '',
      first_seen      TEXT DEFAULT (datetime('now')),
      last_seen       TEXT DEFAULT (datetime('now')),
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_org_devices_org ON organization_devices(organization_id);

    -- Generic, product-agnostic END-USER visibility (a ShopERP cashier, a
    -- ZHospital doctor, etc.) — NOT platform users. Read-only informational
    -- data for support, populated the same way as organization_devices.
    CREATE TABLE IF NOT EXISTS organization_users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id      INTEGER NOT NULL REFERENCES platform_products(id) ON DELETE CASCADE,
      name            TEXT NOT NULL DEFAULT '',
      email           TEXT NOT NULL DEFAULT '',
      mobile          TEXT NOT NULL DEFAULT '',
      role_label      TEXT NOT NULL DEFAULT '',
      is_active       INTEGER NOT NULL DEFAULT 1,
      last_login      TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_org_users_org ON organization_users(organization_id);
  `);

  runMigration(db, 'ALTER TABLE platform_users ADD COLUMN locked_until TEXT', 'platform_users.locked_until');

  seed(db);
}

function seed(db) {
  const roles = [
    ['OWNER', 'Platform Owner'], ['SUPER_ADMIN', 'Platform Super Admin'],
    ['ADMINISTRATOR', 'Platform Administrator'], ['SUPPORT', 'Platform Support'],
    ['BILLING', 'Platform Billing'], ['AUDITOR', 'Platform Auditor'], ['READ_ONLY', 'Platform Read Only'],
  ];
  const insertRole = db.prepare('INSERT OR IGNORE INTO platform_roles (code, label) VALUES (?, ?)');
  roles.forEach(([code, label]) => insertRole.run(code, label));

  const permissions = [
    ['manage_platform_users', 'Manage Platform Users'],
    ['manage_products', 'Manage Product Registry'],
    ['manage_organizations', 'Manage Organizations'],
    ['manage_licenses', 'Manage Licenses'],
    ['view_billing', 'View Billing'],
    ['manage_billing', 'Manage Billing'],
    ['view_audit_log', 'View Audit Log'],
    ['support_actions', 'Perform Support Actions'],
    ['view_only', 'View Dashboard & Data'],
  ];
  const insertPerm = db.prepare('INSERT OR IGNORE INTO platform_permissions (code, label) VALUES (?, ?)');
  permissions.forEach(([code, label]) => insertPerm.run(code, label));

  // Role -> permission codes. OWNER/SUPER_ADMIN get everything; every other
  // role is deliberately narrower — matches "these roles are completely
  // separate from tenant roles" and gives each a real, distinct purpose.
  const rolePerms = {
    OWNER: permissions.map((p) => p[0]),
    SUPER_ADMIN: permissions.filter((p) => p[0] !== 'manage_platform_users').map((p) => p[0]),
    ADMINISTRATOR: ['manage_organizations', 'manage_licenses', 'manage_products', 'view_audit_log', 'view_only'],
    SUPPORT: ['support_actions', 'view_only'],
    BILLING: ['view_billing', 'manage_billing', 'view_only'],
    AUDITOR: ['view_audit_log', 'view_only'],
    READ_ONLY: ['view_only'],
  };
  const getRoleId = db.prepare('SELECT id FROM platform_roles WHERE code = ?');
  const getPermId = db.prepare('SELECT id FROM platform_permissions WHERE code = ?');
  const linkRolePerm = db.prepare('INSERT OR IGNORE INTO platform_role_permissions (role_id, permission_id) VALUES (?, ?)');
  for (const [roleCode, permCodes] of Object.entries(rolePerms)) {
    const roleId = getRoleId.get(roleCode).id;
    for (const permCode of permCodes) {
      linkRolePerm.run(roleId, getPermId.get(permCode).id);
    }
  }

  // Product Registry seed — ShopERP is the first REAL product; ZLAB/
  // ZHospital are 'planned' placeholder rows proving the registry scales
  // to future products via configuration alone (Non-Negotiable Principle
  // #4) — no code for either exists anywhere in this platform or repo.
  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO platform_products (name, slug, description, version, status, license_model, feature_flags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertProduct.run('ShopERP', 'shoperp', 'Mobile repair shop POS, inventory, and billing.', '1.0.0', 'active', 'subscription', '["licensing","backup","multi-device"]');
  insertProduct.run('ZLAB', 'zlab', 'Diagnostic lab management (planned).', '0.0.0', 'planned', 'subscription', '[]');
  insertProduct.run('ZHospital', 'zhospital', 'Hospital management suite (planned).', '0.0.0', 'planned', 'subscription', '[]');
  insertProduct.run('ZClinic', 'zclinic', 'Clinic/OPD management (planned).', '0.0.0', 'planned', 'subscription', '[]');

  db.prepare('INSERT OR IGNORE INTO platform_settings (id, platform_name) VALUES (1, ?)').run('Z-SUPERADMIN');
}

module.exports = { migrate };
