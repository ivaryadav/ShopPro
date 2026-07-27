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

    -- Phase 5A: Organization 360 Workspace — Internal Notes. organization_id
    -- is TEXT (not a FK) because it must hold either a local integer
    -- organizations.id (as a string) or an adapter's synthetic "shoperp:7"
    -- form — this table is entirely Z-SUPERADMIN's own operator context,
    -- never ShopERP (or any product's) data, so no adapter sync is needed.
    CREATE TABLE IF NOT EXISTS organization_notes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      author_email    TEXT NOT NULL,
      note            TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_org_notes_org ON organization_notes(organization_id, created_at);

    -- Phase 5A: Alerts & Notifications Center. Alerts themselves are
    -- computed live on every request from current data (expiring licenses,
    -- pending registrations, locked accounts — see alertService.js), not
    -- pre-materialized by a background job (scheduled job infrastructure is
    -- an explicit later milestone). This table only persists per-alert
    -- read/dismiss state, keyed by a stable, deterministic alert_key so
    -- that state survives across recomputation.
    CREATE TABLE IF NOT EXISTS platform_alert_state (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_key    TEXT NOT NULL UNIQUE,
      read_at      TEXT,
      dismissed_at TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    -- Phase 5B: Platform Security. One recovery code per row (not a JSON
    -- blob) so each is independently single-use and its consumption is
    -- individually auditable.
    CREATE TABLE IF NOT EXISTS platform_mfa_recovery_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON platform_mfa_recovery_codes(user_id);

    -- "Remember this device" — a random token (hashed at rest, like a
    -- password) issued after a successful MFA challenge, letting a later
    -- login from the same browser skip MFA until expiry or explicit revoke.
    CREATE TABLE IF NOT EXISTS platform_trusted_devices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      device_name  TEXT NOT NULL DEFAULT '',
      browser      TEXT NOT NULL DEFAULT '',
      os           TEXT NOT NULL DEFAULT '',
      ip           TEXT NOT NULL DEFAULT '',
      last_used_at TEXT DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      revoked_at   TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON platform_trusted_devices(user_id);

    -- Platform API Keys — for future external/automation integrations
    -- against Z-SUPERADMIN's own API. key_hash is a SHA-256 of the full
    -- key (never reversible); key_prefix is stored in the clear purely so
    -- an operator can recognize a key in a list without ever seeing it
    -- again in full (same convention as GitHub/Stripe API key UIs).
    CREATE TABLE IF NOT EXISTS platform_api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      key_prefix   TEXT NOT NULL,
      permissions  TEXT NOT NULL DEFAULT '[]',
      created_by   INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
      last_used_at TEXT,
      usage_count  INTEGER NOT NULL DEFAULT 0,
      expires_at   TEXT,
      revoked_at   TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    -- Password History — every password ever set (including the current
    -- one) is archived here so a new password can be checked against the
    -- policy's history_count without needing to reverse any hash.
    CREATE TABLE IF NOT EXISTS platform_password_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_password_history_user ON platform_password_history(user_id, created_at);

    -- Single configurable policy row — password rules, lockout, and session
    -- timeout policy co-located since they're all "authentication posture"
    -- settings an operator tunes from one Security Settings screen.
    CREATE TABLE IF NOT EXISTS platform_password_policy (
      id                              INTEGER PRIMARY KEY CHECK (id = 1),
      min_length                      INTEGER NOT NULL DEFAULT 8,
      require_uppercase               INTEGER NOT NULL DEFAULT 0,
      require_lowercase               INTEGER NOT NULL DEFAULT 0,
      require_number                  INTEGER NOT NULL DEFAULT 1,
      require_symbol                  INTEGER NOT NULL DEFAULT 0,
      max_age_days                    INTEGER,
      history_count                   INTEGER NOT NULL DEFAULT 3,
      lockout_threshold                INTEGER NOT NULL DEFAULT 5,
      lockout_window_minutes          INTEGER NOT NULL DEFAULT 15,
      lockout_duration_minutes        INTEGER NOT NULL DEFAULT 30,
      session_idle_timeout_minutes    INTEGER NOT NULL DEFAULT 60,
      session_absolute_timeout_hours  INTEGER NOT NULL DEFAULT 12,
      updated_at                      TEXT DEFAULT (datetime('now'))
    );

    -- Phase 5C: Runtime Operations — the Job Runner's own execution
    -- history. One row per attempt-set (retries collapse into a single
    -- row via the "attempts" count, not one row per retry) so this table
    -- stays a clean run log, not a retry log.
    CREATE TABLE IF NOT EXISTS platform_job_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name        TEXT NOT NULL,
      started_at      TEXT NOT NULL,
      finished_at     TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('success','failure')),
      detail          TEXT NOT NULL DEFAULT '',
      items_processed INTEGER,
      attempts        INTEGER NOT NULL DEFAULT 1,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_runs_name ON platform_job_runs(job_name, started_at);

    -- One row per calendar day, upserted by the Metric Snapshot Job — real
    -- historical data for Reports & Trends, which otherwise can only
    -- compute from CURRENT state (unable to reconstruct a past point in
    -- time for anything that changes destructively, like active sessions).
    CREATE TABLE IF NOT EXISTS platform_metric_snapshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date       TEXT NOT NULL UNIQUE,
      total_organizations INTEGER NOT NULL DEFAULT 0,
      active_licenses     INTEGER NOT NULL DEFAULT 0,
      expired_licenses    INTEGER NOT NULL DEFAULT 0,
      active_sessions     INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT DEFAULT (datetime('now'))
    );

    -- Phase 5D: Platform Maintenance & Business Continuity. Z-SUPERADMIN
    -- is the single source of truth; scope_ref is TEXT (not a FK) for the
    -- same reason organization_notes.organization_id is — it must hold a
    -- product slug ("shoperp"), a synthetic org id ("shoperp:7"), or NULL
    -- (platform-wide), and must support future products with zero schema
    -- change. "emergency" is a MODE, not a scope — it can apply at any
    -- scope and wins resolution regardless of specificity (see
    -- maintenanceService.resolveEffective's documented precedence).
    CREATE TABLE IF NOT EXISTS platform_maintenance_windows (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type              TEXT NOT NULL CHECK (scope_type IN ('platform','product','organization')),
      scope_ref               TEXT,
      mode                    TEXT NOT NULL DEFAULT 'scheduled' CHECK (mode IN ('scheduled','immediate','emergency')),
      access_level            TEXT NOT NULL DEFAULT 'locked' CHECK (access_level IN ('read_only','locked')),
      status                  TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','expired','cancelled')),
      message                 TEXT NOT NULL DEFAULT '',
      eta                     TEXT NOT NULL DEFAULT '',
      starts_at               TEXT,
      ends_at                 TEXT,
      allowlist_users         TEXT NOT NULL DEFAULT '[]',
      allowlist_organizations TEXT NOT NULL DEFAULT '[]',
      allowlist_ips           TEXT NOT NULL DEFAULT '[]',
      created_by              INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
      created_at              TEXT DEFAULT (datetime('now')),
      updated_at              TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_maint_windows_scope ON platform_maintenance_windows(scope_type, scope_ref);
    CREATE INDEX IF NOT EXISTS idx_maint_windows_status ON platform_maintenance_windows(status);

    CREATE TABLE IF NOT EXISTS platform_maintenance_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      window_id  INTEGER REFERENCES platform_maintenance_windows(id) ON DELETE CASCADE,
      action     TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '',
      actor      TEXT NOT NULL DEFAULT 'system',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_maint_history_window ON platform_maintenance_history(window_id, created_at);

    -- Phase 5E: Business Operations — the Plan Catalog. plan_code strings
    -- already in use on platform_licenses (and, independently, ShopERP's
    -- own tenant_licenses) become catalog-backed here rather than free
    -- text — real device/user/storage limits and features per plan.
    -- Existing plan_codes (TRIAL/BASIC) are seeded below so no existing
    -- license row becomes orphaned from the catalog.
    CREATE TABLE IF NOT EXISTS platform_subscription_plans (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      code             TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      billing_cycle    TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('trial','monthly','yearly','lifetime')),
      device_limit     INTEGER NOT NULL DEFAULT 2,
      user_limit       INTEGER NOT NULL DEFAULT 5,
      storage_limit_mb INTEGER NOT NULL DEFAULT 1024,
      price_amount     REAL NOT NULL DEFAULT 0,
      price_currency   TEXT NOT NULL DEFAULT 'INR',
      features         TEXT NOT NULL DEFAULT '[]',
      is_active        INTEGER NOT NULL DEFAULT 1,
      sort_order       INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now'))
    );

    -- One row per license lifecycle event, for BOTH local (platform_licenses)
    -- and adapter-backed organizations — organization_id is TEXT for the
    -- same reason organization_notes.organization_id is (a local integer id
    -- or a "shoperp:7" synthetic ref). This is what makes "License Timeline"
    -- and "Renewal History" first-class, dedicated views distinct from the
    -- general platform_audit_logs (which stays untouched and keeps logging
    -- these same actions too, for the platform-wide audit trail).
    CREATE TABLE IF NOT EXISTS platform_license_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      product_id      INTEGER REFERENCES platform_products(id) ON DELETE SET NULL,
      event_type      TEXT NOT NULL,
      from_value      TEXT,
      to_value        TEXT,
      detail          TEXT NOT NULL DEFAULT '',
      actor           TEXT NOT NULL DEFAULT 'system',
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_license_history_org ON platform_license_history(organization_id, created_at);

    -- Manual Billing Ledger — no payment gateway in this phase, every row
    -- here is operator-entered. organization_id is TEXT (adapter-friendly)
    -- so billing works identically for local and ShopERP-backed customers
    -- without touching the adapter contract at all (billing is pure
    -- platform business data, not product data).
    CREATE TABLE IF NOT EXISTS platform_invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      product_id      INTEGER REFERENCES platform_products(id) ON DELETE SET NULL,
      invoice_number  TEXT NOT NULL UNIQUE,
      description     TEXT NOT NULL DEFAULT '',
      amount          REAL NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'INR',
      status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','overdue','void')),
      issued_at       TEXT DEFAULT (datetime('now')),
      due_at          TEXT,
      paid_at         TEXT,
      created_by      INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_org ON platform_invoices(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON platform_invoices(status);

    CREATE TABLE IF NOT EXISTS platform_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      invoice_id      INTEGER REFERENCES platform_invoices(id) ON DELETE SET NULL,
      amount          REAL NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'INR',
      method          TEXT NOT NULL DEFAULT 'manual',
      reference       TEXT NOT NULL DEFAULT '',
      note            TEXT NOT NULL DEFAULT '',
      recorded_by     INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_org ON platform_payments(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_invoice ON platform_payments(invoice_id);

    -- Credit Note (type='credit', reduces outstanding balance) and Debit
    -- Adjustment (type='debit', increases it) share one table — same
    -- reasoning as platform_maintenance_history covering every action with
    -- one discriminator column rather than near-identical parallel tables.
    CREATE TABLE IF NOT EXISTS platform_billing_adjustments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      invoice_id      INTEGER REFERENCES platform_invoices(id) ON DELETE SET NULL,
      type            TEXT NOT NULL CHECK (type IN ('credit','debit')),
      amount          REAL NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'INR',
      reason          TEXT NOT NULL DEFAULT '',
      created_by      INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_billing_adj_org ON platform_billing_adjustments(organization_id, created_at);

    -- Phase 5F: Integration Platform — the Event Bus. One row per business
    -- event, INSERT-only for the life of the row (no code anywhere ever
    -- UPDATEs a platform_events row) — that is what "events must be
    -- immutable" means in practice for a SQLite-backed log; the Event
    -- Retention Job's bulk delete of rows past their retention window is
    -- data lifecycle management, not a mutation of a live event.
    -- organization_id is TEXT (like organization_notes/platform_license_
    -- history) so events cover adapter-backed organizations too.
    CREATE TABLE IF NOT EXISTS platform_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type      TEXT NOT NULL,
      organization_id TEXT,
      product_id      INTEGER REFERENCES platform_products(id) ON DELETE SET NULL,
      payload         TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON platform_events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_org ON platform_events(organization_id, created_at);

    -- Outbound Webhooks. secret is stored in the clear (unlike an API key's
    -- hash) because it must be read back on every delivery to compute the
    -- HMAC signature — same posture as Stripe/GitHub webhook secrets,
    -- which are retrievable/regenerable, not one-way hashed like a
    -- password. event_types is a JSON array of subscribed event_type
    -- strings; an empty array means "all events".
    CREATE TABLE IF NOT EXISTS platform_webhooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      event_types TEXT NOT NULL DEFAULT '[]',
      secret      TEXT NOT NULL,
      is_enabled  INTEGER NOT NULL DEFAULT 1,
      created_by  INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- Delivery attempts. payload is a DENORMALIZED copy of the triggering
    -- event's payload, captured at enqueue time — deliberately NOT a live
    -- join back to platform_events, so the Webhook Retry Job can always
    -- retry a delivery correctly even after the Event Retention Job has
    -- purged the original event row (event_id is kept purely as a
    -- best-effort cross-reference, ON DELETE SET NULL, never load-bearing).
    CREATE TABLE IF NOT EXISTS platform_webhook_deliveries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id       INTEGER NOT NULL REFERENCES platform_webhooks(id) ON DELETE CASCADE,
      event_id         INTEGER REFERENCES platform_events(id) ON DELETE SET NULL,
      event_type       TEXT NOT NULL,
      payload          TEXT NOT NULL DEFAULT '{}',
      status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dead_letter')),
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  TEXT,
      last_status_code INTEGER,
      last_error       TEXT,
      delivered_at     TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON platform_webhook_deliveries(webhook_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON platform_webhook_deliveries(status, next_attempt_at);

    -- Public API Foundation: per-request usage metrics for API-key-
    -- authenticated calls, keyed to the existing platform_api_keys table
    -- (no new auth mechanism — "reuse existing Platform API Keys").
    CREATE TABLE IF NOT EXISTS platform_api_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id  INTEGER REFERENCES platform_api_keys(id) ON DELETE SET NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status_code INTEGER,
      duration_ms INTEGER,
      request_id  TEXT NOT NULL DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_key ON platform_api_usage(api_key_id, created_at);
  `);

  runMigration(db, 'ALTER TABLE platform_licenses ADD COLUMN license_key TEXT', 'platform_licenses.license_key');
  runMigration(db, 'ALTER TABLE platform_licenses ADD COLUMN grace_started_at TEXT', 'platform_licenses.grace_started_at');
  runMigration(db, 'ALTER TABLE platform_licenses ADD COLUMN cancelled_at TEXT', 'platform_licenses.cancelled_at');

  runMigration(db, 'ALTER TABLE platform_users ADD COLUMN locked_until TEXT', 'platform_users.locked_until');
  runMigration(db, 'ALTER TABLE platform_users ADD COLUMN totp_secret TEXT', 'platform_users.totp_secret');
  runMigration(db, 'ALTER TABLE platform_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0', 'platform_users.totp_enabled');
  runMigration(db, 'ALTER TABLE platform_users ADD COLUMN totp_enrolled_at TEXT', 'platform_users.totp_enrolled_at');
  runMigration(db, 'ALTER TABLE platform_users ADD COLUMN password_changed_at TEXT', 'platform_users.password_changed_at');
  runMigration(db, 'ALTER TABLE platform_roles ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0', 'platform_roles.mfa_required');
  // SQLite forbids a non-constant (e.g. datetime('now')) default on ALTER
  // TABLE ADD COLUMN, so pre-existing rows get NULL from the ALTER above —
  // backfill using created_at as the best available approximation of when
  // each user's password was last set (same reasoning this whole engagement
  // already uses for every other backfill-from-legacy-data migration).
  db.exec("UPDATE platform_users SET password_changed_at = created_at WHERE password_changed_at IS NULL");

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

  // Phase 5E: Plan Catalog seed. TRIAL/BASIC/PREMIUM device_limit values
  // exactly mirror ShopERP's own real subscription_plans seed
  // (server/local.js) — TRIAL=2, BASIC=2, PREMIUM=5 — so the two catalogs
  // describe the same real-world tiers rather than inventing conflicting
  // names; this also matches plan_code strings already in use on existing
  // platform_licenses rows and pre-existing test fixtures. ENTERPRISE/
  // LIFETIME are genuine additional tiers above what ShopERP currently
  // sells, not a conflict with anything.
  const insertPlan = db.prepare(`
    INSERT OR IGNORE INTO platform_subscription_plans
      (code, name, billing_cycle, device_limit, user_limit, storage_limit_mb, price_amount, price_currency, features, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPlan.run('TRIAL', 'Trial', 'trial', 2, 3, 512, 0, 'INR', '["core-features"]', 0);
  insertPlan.run('BASIC', 'Basic', 'monthly', 2, 5, 1024, 999, 'INR', '["core-features","email-support"]', 1);
  insertPlan.run('PREMIUM', 'Premium', 'monthly', 5, 15, 5120, 2499, 'INR', '["core-features","priority-support","multi-device","reports"]', 2);
  insertPlan.run('ENTERPRISE', 'Enterprise', 'yearly', 20, 50, 20480, 24999, 'INR', '["core-features","priority-support","multi-device","reports","dedicated-account-manager"]', 3);
  insertPlan.run('LIFETIME', 'Lifetime', 'lifetime', 10, 25, 10240, 49999, 'INR', '["core-features","priority-support","multi-device","reports"]', 4);

  // Phase 5B: the two highest-privilege roles require MFA before they can
  // use the platform for anything beyond enrolling it (enforced by
  // requireMfaCompliance middleware) — every other role starts optional.
  db.prepare("UPDATE platform_roles SET mfa_required = 1 WHERE code IN ('OWNER','SUPER_ADMIN')").run();

  db.prepare('INSERT OR IGNORE INTO platform_password_policy (id) VALUES (1)').run();
}

module.exports = { migrate };
