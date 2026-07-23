/**
 * ShopERP Pro — Local WiFi Server (SQLite)
 * ─────────────────────────────────────────
 * Run this on your main billing PC.
 * Every device on the same WiFi can then access live data.
 *
 * Usage:
 *   node local.js
 *
 * No database to install. Data saved to shoperpro.db in this folder.
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const Database = require('better-sqlite3');
const cors     = require('cors');
const compression = require('compression');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const license  = require('./license');
const sessions = require('./sessions');
const logger   = require('./logger');

// Load .env file if present (no dotenv dependency needed)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Wave 1 — JWT_SECRET is now mandatory. A per-boot random fallback meant every
// server restart silently invalidated every session (see
// docs/architecture-review/SecurityReview.md F-1); a real session table
// (server/sessions.js) is only durable if the secret that signs its tokens
// is durable too. Fail loudly at startup instead of degrading silently —
// matches the existing pattern in stripLicenseSecrets() below.
if (!process.env.JWT_SECRET) {
  console.error('\n[FATAL] JWT_SECRET is not set in server/.env.');
  console.error('Every server restart would otherwise log everyone out. Generate one with:');
  console.error("  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
  console.error('and add it to server/.env as JWT_SECRET=<the generated value>\n');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
// DB_PATH — configurable so tests can point at an isolated, disposable file
// instead of the real production database (see docs/architecture-review/
// DatabaseIsolationPlan.md). Default is unchanged from before this existed:
// an unset DB_PATH resolves to the exact same server/shoperpro.db it always
// has — no behavior change for the normal `node local.js` production path.
const DB_PATH    = process.env.DB_PATH || path.join(__dirname, 'shoperpro.db');
const HTML_PATH  = path.join(__dirname, '..', 'app', 'ShopERP_Pro_v8.html');

// ── Admin key — used by Super Admin panel to call remote control endpoints ──
// Set ADMIN_KEY env var = sha256 hash of your admin password.
// Run:  echo -n 'YourAdminPassword' | shasum -a 256
// Default = current admin password hash. CHANGE THIS if you change admin password.
const ADMIN_KEY  = process.env.ADMIN_KEY || '2b5877210c3581cccac2431c0a5681ea1c5674ae71dbb5d664eda93e3965a3dd';

// mailer.js reads its required SMTP_* env vars at require time and exits the
// process if any are missing — must be required here, after the .env file
// load above, not alongside the top-of-file requires (process.env wouldn't
// have the .env values yet at that point).
const mailer = require('./mailer');

// ── Startup validation ────────────────────────────────────────────────────────
// OperationalReadinessPlan.md §2. Two checks, neither changing existing
// behavior for a correctly-configured deployment:
//
// 1. ADMIN_KEY unset → warn loudly, don't fail. Unset is a legitimate
//    default for local single-shop use (unlike JWT_SECRET above, which
//    fails hard — an unset JWT_SECRET silently breaks every session on
//    restart, a correctness bug; an unset ADMIN_KEY just means a known,
//    fixed admin credential, a security posture question the operator
//    should see plainly rather than discover later). Visible only at
//    boot (console log + this warning) — deliberately NOT exposed via
//    GET /health (TenantStatusConsistency.md, Blocker 3): that's a public,
//    unauthenticated endpoint, and telling any caller for free whether a
//    deployment is still on the known default admin-key hash is a real
//    reconnaissance gift to an attacker.
// 2. DB_PATH's parent directory must exist and be writable before
//    new Database(DB_PATH) is attempted, so a bad path fails with a clear,
//    operator-actionable message instead of better-sqlite3's own raw
//    "unable to open database file" (FailureScenarioReport.md scenario 2
//    already confirmed the server fails closed here — this only improves
//    the message, not the fail-closed behavior itself).
if (!process.env.ADMIN_KEY) {
  logger.warn('ADMIN_KEY not set — using the default admin key hash', {
    hint: 'Set ADMIN_KEY in server/.env to use your own admin password. Check this server\'s boot log ("Custom key configured") for a live check.',
  });
}
try {
  fs.accessSync(path.dirname(DB_PATH), fs.constants.W_OK);
} catch (e) {
  console.error(`\n[FATAL] Cannot write to the database directory: ${path.dirname(DB_PATH)}`);
  console.error(`DB_PATH is set to: ${DB_PATH}`);
  console.error('Check that this directory exists and the server process has write permission.\n');
  process.exit(1);
}

// ── SQLite database ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // faster concurrent reads
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_name   TEXT    NOT NULL,
    is_active   INTEGER DEFAULT 1,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username      TEXT    NOT NULL,
    display_name  TEXT,
    mobile        TEXT,
    email         TEXT,
    password_hash TEXT    NOT NULL,
    role          TEXT    DEFAULT 'staff',
    is_active     INTEGER DEFAULT 1,
    last_login    TEXT,
    created_at    TEXT    DEFAULT (datetime('now')),
    UNIQUE(tenant_id, username)
  );

  CREATE TABLE IF NOT EXISTS tenant_data (
    tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    data       TEXT    NOT NULL DEFAULT '{}',
    updated_at TEXT    DEFAULT (datetime('now'))
  );
`);

// Migrate existing DB — add columns if missing.
//
// runMigration() replaces bare `try{db.exec(sql)}catch(_){}`: that pattern
// swallowed EVERY error identically, including a genuine failure (a typo, a
// locked file, a corrupted schema) — the server would boot as if nothing
// went wrong, and the real symptom (e.g. "no such column: mobile") would
// only surface later, at a call site far from the true cause. Confirmed via
// live reproduction, see docs/architecture-review/FailureScenarioReport.md
// scenario 8 and docs/architecture-review/MigrationSafetyReport.md.
//
// SQLite's own error messages are the only reliable signal available here
// (there's no separate "already exists" error code to check) — matched
// case-insensitively against the two shapes these specific statements can
// legitimately produce on a re-run: "duplicate column name" (ALTER TABLE
// ADD COLUMN) and "already exists" (CREATE TABLE/INDEX without IF NOT
// EXISTS). Anything else is a genuine failure: logged loudly (not silently
// swallowed) and recorded in migrationState.failures, which GET /health
// reports — but does NOT crash the process. Startup migrations here are
// independent, additive ALTER/CREATE statements (see failure-scenario
// testing referenced above); a bad server generation on ONE historical
// column shouldn't take down a server that has otherwise booted correctly
// and would keep working for every tenant not touching that column — that
// tradeoff (visibility over availability) is exactly what a general-purpose
// process.exit(1) would get wrong, and is why this differs from the
// JWT_SECRET fail-fast pattern above (that check has no legitimate
// "already applied" case to distinguish; migrations do).
const migrationState = { failures: [] };
const BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i;
function runMigration(sql, label) {
  try {
    db.exec(sql);
  } catch (e) {
    if (BENIGN_MIGRATION_ERROR.test(e.message)) return; // already applied — expected, not an error
    logger.error(`[MIGRATION FAILED] ${label}`, { error: e.message });
    migrationState.failures.push({ label, error: e.message, at: new Date().toISOString() });
  }
}
runMigration('ALTER TABLE users ADD COLUMN display_name TEXT', 'users.display_name');
runMigration('ALTER TABLE users ADD COLUMN mobile TEXT', 'users.mobile');
runMigration('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile) WHERE mobile IS NOT NULL', 'idx_users_mobile');
// Tenant status columns — support remote pause/terminate
runMigration("ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active'", 'tenants.status');
runMigration("ALTER TABLE tenants ADD COLUMN suspend_reason TEXT NOT NULL DEFAULT ''", 'tenants.suspend_reason');
// Cloud backup table — keyed by license key hash (machine-bound)
db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_backups (
    key_hash    TEXT PRIMARY KEY,
    shop_name   TEXT,
    data        TEXT NOT NULL,
    backed_up_at TEXT DEFAULT (datetime('now'))
  );
`);
runMigration('ALTER TABLE cloud_backups ADD COLUMN shop_name TEXT', 'cloud_backups.shop_name');
runMigration('ALTER TABLE tenants ADD COLUMN license_key_hash TEXT', 'tenants.license_key_hash');
runMigration('ALTER TABLE tenants ADD COLUMN license_expiry TEXT', 'tenants.license_expiry');
runMigration("ALTER TABLE tenants ADD COLUMN license_plan TEXT NOT NULL DEFAULT 'monthly'", 'tenants.license_plan');
// Wave 0 — optimistic concurrency for tenant_data (see docs/architecture-review/ConflictResolution.md)
runMigration('ALTER TABLE tenant_data ADD COLUMN version INTEGER NOT NULL DEFAULT 1', 'tenant_data.version');
runMigration('ALTER TABLE tenant_data ADD COLUMN updated_by INTEGER', 'tenant_data.updated_by');
runMigration('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_license ON tenants(license_key_hash) WHERE license_key_hash IS NOT NULL', 'idx_tenants_license');
// Wave 1 — session architecture (see docs/architecture-review/SessionArchitecture.md)
sessions.migrate(db, migrationState.failures);

// ── SaaS Licensing / Registration / Subscription system ──────────────────────
// See docs/architecture-review/LicenseArchitecture.md and DatabaseDesign.md.
// Web/hosted mode only — the offline desktop machine-locked activation path
// (server/license.js, and the client's own copy of the same engine) is
// completely untouched by everything below.
//
// All additive: new tables, new columns on tenants/users. The legacy
// tenants.status/suspend_reason/license_key_hash/license_expiry/license_plan
// columns keep their original meaning and every existing reader of them
// (requireActive(), the old /api/auth/verify-license, /api/admin/tenants,
// /api/admin/web-users) keeps working exactly as before, unchanged.
//
// One exception, added post-launch (TenantStatusConsistency.md, Blocker 1):
// tenant_licenses.status is the single authoritative source of truth for
// "is this tenant allowed to use the product" — every protected endpoint
// gates on it (directly, or via requireActive() as a second, redundant
// layer). /api/auth/register now also creates a tenant_licenses row (it
// used to leave tenants without one, which is exactly the condition the
// license middleware fails open on), and /api/admin/tenant/status now also
// writes tenant_licenses.status in the same request it writes tenants.status,
// so the two can no longer drift apart the way they did before this fix.
db.exec(`
  CREATE TABLE IF NOT EXISTS subscription_plans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL UNIQUE,
    label         TEXT    NOT NULL,
    device_limit  INTEGER NOT NULL,
    trial_days    INTEGER,
    is_active     INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tenant_licenses (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id                INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    status                   TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                                CHECK (status IN ('PENDING_APPROVAL','ACTIVE','READ_ONLY','SUSPENDED','ARCHIVED')),
    plan_code                TEXT NOT NULL DEFAULT 'TRIAL' REFERENCES subscription_plans(code),
    requested_plan_code      TEXT,
    billing_cycle            TEXT,
    device_limit             INTEGER NOT NULL DEFAULT 2,
    license_key              TEXT,
    requested_devices_bucket TEXT,
    requested_modules        TEXT NOT NULL DEFAULT '[]',
    starts_at                TEXT,
    expires_at               TEXT,
    read_only_since          TEXT,
    suspended_since          TEXT,
    last_verified_at         TEXT,
    offline_grace_days       INTEGER NOT NULL DEFAULT 15,
    created_at               TEXT DEFAULT (datetime('now')),
    updated_at               TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_licenses_key ON tenant_licenses(license_key) WHERE license_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_tenant_licenses_status ON tenant_licenses(status);

  CREATE TABLE IF NOT EXISTS license_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type   TEXT NOT NULL,
    from_status  TEXT,
    to_status    TEXT,
    detail       TEXT NOT NULL DEFAULT '',
    actor        TEXT NOT NULL DEFAULT 'system',
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_license_history_tenant ON license_history(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS trusted_devices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id      TEXT NOT NULL,
    device_name    TEXT,
    browser        TEXT,
    os             TEXT,
    first_login_at TEXT DEFAULT (datetime('now')),
    last_login_at  TEXT DEFAULT (datetime('now')),
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(tenant_id, user_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_trusted_devices_tenant ON trusted_devices(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);

  -- Web admin credential — single row (id=1), replaces the ADMIN_KEY env var
  -- as the source of truth once seeded. See docs/production-hardening/
  -- PasswordMigration.md. algo starts 'sha256' (seeded from the legacy
  -- env-var-derived hash for exact backward compatibility) and flips to
  -- 'bcrypt' automatically the first time that legacy password verifies
  -- successfully — no forced reset, no new password required.
  CREATE TABLE IF NOT EXISTS admin_credentials (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    algo          TEXT NOT NULL DEFAULT 'sha256',
    updated_at    TEXT DEFAULT (datetime('now'))
  );
`);
runMigration("ALTER TABLE tenants ADD COLUMN address TEXT NOT NULL DEFAULT ''", 'tenants.address');
runMigration("ALTER TABLE tenants ADD COLUMN gst_number TEXT NOT NULL DEFAULT ''", 'tenants.gst_number');
runMigration('ALTER TABLE users ADD COLUMN email_verify_token_hash TEXT', 'users.email_verify_token_hash');
runMigration('ALTER TABLE users ADD COLUMN email_verify_expires TEXT', 'users.email_verify_expires');
runMigration('ALTER TABLE users ADD COLUMN email_verified_at TEXT', 'users.email_verified_at');

// Seed the 3 plan tiers — idempotent, safe to run every boot.
db.prepare(`INSERT OR IGNORE INTO subscription_plans (code,label,device_limit,trial_days,sort_order) VALUES ('TRIAL','Trial',2,14,0)`).run();
db.prepare(`INSERT OR IGNORE INTO subscription_plans (code,label,device_limit,trial_days,sort_order) VALUES ('BASIC','Basic',2,NULL,1)`).run();
db.prepare(`INSERT OR IGNORE INTO subscription_plans (code,label,device_limit,trial_days,sort_order) VALUES ('PREMIUM','Premium',5,NULL,2)`).run();

// Seed the admin credential from the legacy ADMIN_KEY env var (or its
// hardcoded default) on first boot only — from then on, admin_credentials
// is authoritative and ADMIN_KEY is never read again. This is the same
// "env var is just the initial seed" posture ADMIN_KEY already had before
// this table existed (it was always `process.env.ADMIN_KEY || <default>`).
db.prepare(`INSERT OR IGNORE INTO admin_credentials (id, password_hash, algo) VALUES (1, ?, 'sha256')`).run(ADMIN_KEY);

const LICENSE_KEY_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // matches license.js's no-0/O/1/I charset
function generateHostedLicenseKey() {
  const group = () => {
    const b = crypto.randomBytes(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += LICENSE_KEY_CHARSET[b[i] % LICENSE_KEY_CHARSET.length];
    return s;
  };
  for (let i = 0; i < 20; i++) {
    const key = 'SHOP-' + group() + '-' + group() + '-' + group();
    if (!db.prepare('SELECT 1 FROM tenant_licenses WHERE license_key = ?').get(key)) return key;
  }
  throw new Error('Could not generate a unique license key after 20 attempts');
}
function addLicenseHistory(tenantId, eventType, { fromStatus, toStatus, detail, actor } = {}) {
  db.prepare(
    `INSERT INTO license_history (tenant_id, event_type, from_status, to_status, detail, actor) VALUES (?,?,?,?,?,?)`
  ).run(tenantId, eventType, fromStatus || null, toStatus || null, detail || '', actor || 'system');
}

// billing_cycle -> duration in days; 'lifetime' never expires (expires_at = NULL).
const BILLING_CYCLE_DAYS = { trial: 14, monthly: 30, halfyearly: 180, yearly: 365, lifetime: null };
// Shared by POST /api/admin/tenant-licenses/:id/assign-plan, /start-trial, and
// the registrations/:id/approve auto-default — one place computing
// plan/billing/device-limit/expiry so all three stay consistent.
function assignPlanToTenant(tenantId, planCode, billingCycle, deviceLimitOverride) {
  const plan = db.prepare('SELECT code, device_limit FROM subscription_plans WHERE code = ? AND is_active = 1')
    .get(String(planCode || '').toUpperCase());
  if (!plan) throw Object.assign(new Error('Unknown plan code'), { status: 400 });
  if (!Object.prototype.hasOwnProperty.call(BILLING_CYCLE_DAYS, billingCycle)) {
    throw Object.assign(new Error('billingCycle must be one of: ' + Object.keys(BILLING_CYCLE_DAYS).join(', ')), { status: 400 });
  }
  const days = BILLING_CYCLE_DAYS[billingCycle];
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
  const deviceLimit = (typeof deviceLimitOverride === 'number' && deviceLimitOverride > 0) ? deviceLimitOverride : plan.device_limit;
  db.prepare(
    `UPDATE tenant_licenses SET plan_code = ?, billing_cycle = ?, device_limit = ?, starts_at = datetime('now'), expires_at = ?, updated_at = datetime('now') WHERE tenant_id = ?`
  ).run(plan.code, billingCycle, deviceLimit, expiresAt, tenantId);
  return { planCode: plan.code, billingCycle, deviceLimit, expiresAt };
}

// Backfill — every pre-existing tenant (created before this feature shipped)
// unconditionally needs a tenant_licenses row, or the new admin dashboard
// simply shows nothing for them. Runs automatically every boot (idempotent
// WHERE NOT EXISTS anti-join), not as a one-off manual SQL file like the
// 2026-07-19 backfill — that one fixed a historical bug affecting some rows,
// this is a universal consequence of shipping the feature at all. Cheap at
// the 50-500 row scale this app targets. device_limit=5 (not BASIC's default
// of 2) because real per-tenant device usage is unknown — defaulting low
// risks locking an existing shop out of its own second/third device.
try {
  db.prepare(`
    INSERT INTO tenant_licenses (tenant_id, status, plan_code, billing_cycle, device_limit, expires_at, last_verified_at)
    SELECT t.id,
      CASE t.status WHEN 'paused' THEN 'SUSPENDED' WHEN 'terminated' THEN 'ARCHIVED' ELSE 'ACTIVE' END,
      'BASIC',
      CASE WHEN t.license_plan IN ('monthly','halfyearly','yearly','lifetime') THEN t.license_plan ELSE 'monthly' END,
      5,
      t.license_expiry,
      datetime('now')
    FROM tenants t
    WHERE NOT EXISTS (SELECT 1 FROM tenant_licenses tl WHERE tl.tenant_id = t.id)
  `).run();
  const needsKey = db.prepare(`SELECT tenant_id FROM tenant_licenses WHERE license_key IS NULL`).all();
  for (const row of needsKey) {
    const key = generateHostedLicenseKey();
    db.prepare(`UPDATE tenant_licenses SET license_key = ? WHERE tenant_id = ?`).run(key, row.tenant_id);
    addLicenseHistory(row.tenant_id, 'BACKFILLED', { detail: 'tenant_licenses row created from legacy tenants columns at feature rollout' });
  }
} catch (e) {
  logger.error('[LICENSING BACKFILL FAILED]', { error: e.message });
  migrationState.failures.push({ label: 'tenant_licenses backfill', error: e.message, at: new Date().toISOString() });
}

if (migrationState.failures.length > 0) {
  logger.warn(`${migrationState.failures.length} migration statement(s) failed at startup`, {
    hint: 'See [MIGRATION FAILED] lines above. Server is continuing to boot (these are additive schema changes; existing functionality not touching the affected column/table is unaffected), but check GET /health and investigate before relying on the affected feature.',
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// Wave 1: token issuance now goes through sessions.createSession() (see
// server/sessions.js), which both signs the access token AND writes the
// user_sessions row it's tied to — replaces the old standalone makeToken().

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    const check = sessions.checkSession(db, payload);
    if (!check.ok) {
      return res.status(401).json({ error: 'Session expired or was signed out elsewhere. Please log in again.' });
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// Blocks API calls if tenant is paused, terminated, or license expired
function requireActive(req, res, next) {
  const t = db.prepare('SELECT status, suspend_reason, license_expiry, license_plan FROM tenants WHERE id = ?').get(req.user.tenantId);
  if (!t) return res.status(404).json({ error: 'Tenant not found' });
  if (t.status === 'paused')     return res.status(403).json({ error: 'Account paused',     status: 'paused',      reason: t.suspend_reason || '' });
  if (t.status === 'terminated') return res.status(403).json({ error: 'Account terminated', status: 'terminated',  reason: t.suspend_reason || '' });
  if (t.license_plan !== 'lifetime' && t.license_expiry) {
    const expMs = new Date(t.license_expiry).getTime();
    if (Date.now() > expMs) {
      return res.status(403).json({ error: 'License expired on ' + t.license_expiry + '. Contact Ravi (+91 94511 00556) to renew.', status: 'expired', expiry: t.license_expiry });
    }
  }
  next();
}

// ── SaaS licensing gates (tenant_licenses.status) ────────────────────────────
// Runs in addition to (always after) requireActive above, which is left
// untouched — these gate the NEW 5-state enum for tenants that have a
// tenant_licenses row. Tenants without one (shouldn't happen post-backfill,
// but fail open rather than break a request over a missing row) pass through.
function getTenantLicense(tenantId) {
  return db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
}
function requireLicenseRead(req, res, next) {
  const lic = getTenantLicense(req.user.tenantId);
  if (!lic) return next();
  if (lic.status === 'PENDING_APPROVAL') {
    return res.status(403).json({ error: 'Your registration is pending admin approval.', licenseStatus: lic.status });
  }
  if (lic.status === 'SUSPENDED') {
    return res.status(403).json({ error: 'Subscription expired. Please contact administrator.', licenseStatus: lic.status });
  }
  if (lic.status === 'ARCHIVED') {
    return res.status(403).json({ error: 'This account has been archived. Please contact administrator.', licenseStatus: lic.status });
  }
  next(); // ACTIVE and READ_ONLY may read
}
function requireLicenseWrite(req, res, next) {
  const lic = getTenantLicense(req.user.tenantId);
  if (!lic) return next();
  if (lic.status === 'READ_ONLY') {
    return res.status(403).json({ error: 'Your subscription has expired. You can view your data, but new entries and edits are disabled until you renew. Contact your administrator.', licenseStatus: lic.status });
  }
  return requireLicenseRead(req, res, next);
}

// ── Admin session tokens (Issue 2, PasswordMigration.md) ─────────────────────
// Replaces the old model (a single static, long-lived secret compared
// directly against X-Admin-Key on every request) with a real login: a
// password is verified once against admin_credentials (bcrypt, or legacy
// sha256 with automatic upgrade — see the /api/admin/login handler below),
// and a short-lived, random, single-use-until-expiry session token is
// issued. bcrypt hashes are non-deterministic (a fresh salt every time),
// so they cannot themselves be sent as a repeatable bearer credential the
// way a plain hash could — a real login exchange is the correct fix, not
// an incidental architecture change.
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const _adminSessions = new Map(); // token -> expiresAt (ms)
function issueAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  _adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}
// Validates X-Admin-Key header against the currently-active admin session
// tokens (not a single static secret anymore). Still timing-safe per token
// compared (S-10, SecurityHardeningReview.md) — meaningfully stronger than
// before regardless, since the credential being matched now rotates on
// every login and expires, rather than being one fixed value for the life
// of the deployment.
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || '';
  const keyBuf = Buffer.from(key, 'utf8');
  const now = Date.now();
  for (const [token, expiresAt] of _adminSessions) {
    if (expiresAt <= now) { _adminSessions.delete(token); continue; }
    const tokenBuf = Buffer.from(token, 'utf8');
    if (keyBuf.length === tokenBuf.length && crypto.timingSafeEqual(keyBuf, tokenBuf)) {
      return next();
    }
  }
  return res.status(401).json({ error: 'Invalid or expired admin session. Please log in again.' });
}

// ── In-memory rate limiter (no npm dependency) ───────────────────────────────
const _rateBuckets = new Map();
function rateLimit(maxReq, windowMs) {
  return function(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = ip + ':' + req.path;
    const now = Date.now();
    let bucket = _rateBuckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > bucket.reset) { bucket = { count: 0, reset: now + windowMs }; }
    bucket.count++;
    _rateBuckets.set(key, bucket);
    if (bucket.count > maxReq) {
      const retryAfter = Math.ceil((bucket.reset - now) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many requests. Try again in ' + retryAfter + 's.' });
    }
    next();
  };
}
// Clean up expired buckets every 5 minutes
setInterval(function() {
  const now = Date.now();
  for (const [k, v] of _rateBuckets.entries()) { if (now > v.reset) _rateBuckets.delete(k); }
}, 5 * 60 * 1000);

// Wave 1 — session cleanup: mark idle sessions expired, hard-delete old
// revoked/expired rows so user_sessions doesn't grow unbounded. Runs on boot
// and every 30 minutes after.
function _runSessionCleanup() {
  try {
    const result = sessions.runCleanup(db);
    if (result.expired || result.deleted) {
      console.log(`[Sessions] cleanup: ${result.expired} expired, ${result.deleted} deleted`);
    }
  } catch (e) { console.error('Session cleanup error:', e); }
}
_runSessionCleanup();
setInterval(_runSessionCleanup, 30 * 60 * 1000);

// ── Licensing status-transition sweep ────────────────────────────────────────
// No job scheduler exists in this repo — follows the same setInterval
// pattern as the session cleanup above. Interval is env-configurable so
// tests can shrink it and fast-forward transitions by backdating
// expires_at/read_only_since/suspended_since directly (same technique
// wave1-sessions.test.js already uses against a test server's own DB file).
const LICENSE_SWEEP_INTERVAL_MS = Number(process.env.LICENSE_SWEEP_INTERVAL_MS) || 15 * 60 * 1000;
function runLicenseTransitionSweep() {
  try {
    // ACTIVE -> READ_ONLY once expires_at has passed.
    const toReadOnly = db.prepare(
      `SELECT tenant_id FROM tenant_licenses WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at < datetime('now')`
    ).all();
    for (const row of toReadOnly) {
      db.prepare(
        `UPDATE tenant_licenses SET status = 'READ_ONLY', read_only_since = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ?`
      ).run(row.tenant_id);
      addLicenseHistory(row.tenant_id, 'STATUS_CHANGED', { fromStatus: 'ACTIVE', toStatus: 'READ_ONLY', detail: 'expires_at passed (sweep)' });
    }

    // READ_ONLY -> SUSPENDED 30 days after read_only_since; kill sessions too.
    const toSuspended = db.prepare(
      `SELECT tenant_id FROM tenant_licenses WHERE status = 'READ_ONLY' AND read_only_since IS NOT NULL AND read_only_since < datetime('now', '-30 days')`
    ).all();
    for (const row of toSuspended) {
      db.prepare(
        `UPDATE tenant_licenses SET status = 'SUSPENDED', suspended_since = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ?`
      ).run(row.tenant_id);
      sessions.revokeAllTenantSessions(db, row.tenant_id);
      addLicenseHistory(row.tenant_id, 'STATUS_CHANGED', { fromStatus: 'READ_ONLY', toStatus: 'SUSPENDED', detail: '30 days in READ_ONLY (sweep)' });
    }

    // SUSPENDED -> ARCHIVED 365 days after suspended_since.
    const toArchived = db.prepare(
      `SELECT tenant_id FROM tenant_licenses WHERE status = 'SUSPENDED' AND suspended_since IS NOT NULL AND suspended_since < datetime('now', '-365 days')`
    ).all();
    for (const row of toArchived) {
      db.prepare(
        `UPDATE tenant_licenses SET status = 'ARCHIVED', updated_at = datetime('now') WHERE tenant_id = ?`
      ).run(row.tenant_id);
      addLicenseHistory(row.tenant_id, 'STATUS_CHANGED', { fromStatus: 'SUSPENDED', toStatus: 'ARCHIVED', detail: '365 days in SUSPENDED, non-payment (sweep)' });
    }
  } catch (e) {
    logger.error('[LICENSE SWEEP FAILED]', { error: e.message });
  }
}
runLicenseTransitionSweep();
setInterval(runLicenseTransitionSweep, LICENSE_SWEEP_INTERVAL_MS);

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

// CORS: allow same-origin and local network only (no wild-card in production)
const _allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null; // null = allow all (local/dev mode)
app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true); // allow non-browser / Electron
    if (!_allowedOrigins) return cb(null, true); // no restriction configured
    if (_allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// Security headers on every response
app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Issue 4 (DevOpsHardening.md) — this app never requests any browser
  // hardware/sensor permission, so a fully-locked-down default costs
  // nothing and closes off a class of feature-hijack via injected/embedded
  // content. Independent of, and does not touch, the CSP below.
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()'
  );
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https://prod.spline.design https://app.spline.design; media-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' https://prod.spline.design https://unpkg.com; worker-src 'self' blob:; frame-ancestors 'none';"
  );
  next();
});

// Issue 4 (DevOpsHardening.md) — gzip/brotli response compression. Placed
// after the security-headers middleware (so those headers are always set
// regardless of whether a given response ends up compressed) and before
// the routes it applies to; compression is purely a transport-encoding
// concern and doesn't interact with CSP or any other header's semantics.
app.use(compression());

app.use(express.json({ limit: '5mb' }));

// ── Health ───────────────────────────────────────────────────────────────────
// Previously a static {status:'ok'} with no actual check — reachable iff the
// process is alive, regardless of whether the database or migrations are
// actually working (OperationalReadinessPlan.md §1). Extended, additively,
// with a real DB connectivity check, migration state, and startup
// validation status — the three items that plan flagged as cheap/low-risk
// to add. No existing field removed or renamed; a caller that only reads
// `status`/`mode`/`time` sees identical behavior to before.
app.get('/health', (_req, res) => {
  let dbStatus = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch (e) {
    dbStatus = 'error';
    logger.error('[HEALTH] DB connectivity check failed', { error: e.message });
  }
  const migrationFailures = migrationState.failures.length;
  const overallStatus = (dbStatus === 'ok' && migrationFailures === 0) ? 'ok' : 'degraded';
  res.json({
    status: overallStatus,
    mode: 'sqlite-local',
    time: new Date().toISOString(),
    db: dbStatus,
    migrationFailures,
    startup: {
      // jwtSecretConfigured is always true here — an unset JWT_SECRET exits
      // the process before this route is ever registered (see the top of
      // this file). Reported anyway so /health's startup block is a
      // complete, self-contained record rather than a partial one.
      //
      // Blocker 3 (TenantStatusConsistency.md): this used to also report
      // adminKeyIsDefault here — telling any unauthenticated caller, for
      // free, whether this deployment's admin credential is still on the
      // known public default hash. That's a real reconnaissance gift to an
      // attacker and this is a public, unauthenticated endpoint; an operator
      // gets the identical signal privately from the boot-time console log
      // ("Custom key configured: yes/no") instead, which isn't network-reachable.
      jwtSecretConfigured: true,
    },
  });
});

// ── POST /api/auth/verify-license — check license key, return shop info ─────
app.post('/api/auth/verify-license', rateLimit(20, 5 * 60 * 1000), (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey || !/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(licenseKey)) {
    return res.status(400).json({ error: 'Invalid license key format' });
  }
  const keyHash = require('crypto').createHash('sha256').update(licenseKey.toUpperCase()).digest('hex');
  try {
    const tenant = db.prepare('SELECT id, shop_name, license_plan, license_expiry, status, suspend_reason FROM tenants WHERE license_key_hash = ?').get(keyHash);
    if (!tenant) {
      // Key not registered yet - valid format but no shop yet
      return res.json({ found: false, keyHash });
    }
    if (tenant.status === 'terminated') {
      return res.status(403).json({ error: 'This license has been terminated. Contact Ravi for assistance.' });
    }
    if (tenant.status === 'paused') {
      return res.status(403).json({ error: 'This account is paused. Contact Ravi to restore access.', reason: tenant.suspend_reason });
    }
    // Check expiry
    if (tenant.license_expiry && tenant.license_plan !== 'lifetime') {
      const expMs = new Date(tenant.license_expiry).getTime();
      if (Date.now() > expMs) {
        return res.status(403).json({ error: 'License expired on ' + tenant.license_expiry + '. Contact Ravi to renew.' });
      }
    }
    // Get users for this tenant (names only - no passwords returned)
    const users = db.prepare("SELECT display_name, role, mobile FROM users WHERE tenant_id = ? AND is_active = 1 ORDER BY role DESC, created_at").all(tenant.id);
    res.json({
      found: true,
      shopName: tenant.shop_name,
      plan: tenant.license_plan || 'monthly',
      expiry: tenant.license_expiry || null,
      users: users.map(u => ({ name: u.display_name || u.mobile, role: u.role, mobile: u.mobile }))
    });
  } catch (e) {
    console.error('Verify license error:', e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── POST /api/auth/register — requires a valid license key issued by admin ────
app.post('/api/auth/register', rateLimit(5, 10 * 60 * 1000), (req, res) => {
  const { shopName, ownerName, mobile, pin, licenseKey } = req.body;
  const mob = (mobile || '').replace(/\D/g, '');
  if (!licenseKey) {
    return res.status(400).json({ error: 'A license key from Ravi is required to register. Contact +91 94511 00556.' });
  }
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(licenseKey)) {
    return res.status(400).json({ error: 'Invalid license key format. Keys look like XXXX-XXXX-XXXX-XXXX.' });
  }
  if (!shopName || !mob || !pin) {
    return res.status(400).json({ error: 'Shop name, mobile number, and PIN are required' });
  }
  if (mob.length < 10) {
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
  }
  // Decode the key ourselves — never trust plan/expiry from the client.
  // Web/hosted keys are all generated against the fixed WEB_LICENSE_MID.
  const decoded = license.decodeKey(licenseKey, license.WEB_LICENSE_MID);
  if (!decoded.valid) {
    return res.status(400).json({ error: 'This license key was not recognized. Double-check it or contact Ravi (+91 94511 00556).' });
  }
  if (decoded.expired) {
    return res.status(400).json({ error: 'This license key has already expired. Contact Ravi (+91 94511 00556) for a new one.' });
  }
  const keyHash = require('crypto').createHash('sha256').update(licenseKey.toUpperCase()).digest('hex');
  try {
    // Check if this license key is already registered to a shop
    const existingTenant = db.prepare('SELECT id, shop_name FROM tenants WHERE license_key_hash = ?').get(keyHash);
    if (existingTenant) {
      return res.status(409).json({ error: 'This license key is already registered to ' + existingTenant.shop_name + '. Please sign in instead.' });
    }
    const existingMob = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mob);
    if (existingMob) {
      return res.status(409).json({ error: 'This mobile number is already registered. Please sign in.' });
    }
    const hash = bcrypt.hashSync(pin, 10);
    // Blocker 1 fix (TenantStatusConsistency.md): this legacy endpoint used to
    // leave a tenant with NO tenant_licenses row at all — the exact condition
    // requireLicenseRead/Write fail open on. Every tenant, legacy or new, must
    // now get one at creation so tenant_licenses.status (the single
    // authoritative source of truth) is never missing for anyone. Wrapped in
    // a transaction (Blocker 3) so a crash mid-sequence can never leave a
    // tenant half-created with some of these five rows missing.
    const registerTenant = db.transaction(() => {
      const tenant = db.prepare(
        'INSERT INTO tenants (shop_name, license_key_hash, license_expiry, license_plan) VALUES (?,?,?,?) RETURNING *'
      ).get(shopName, keyHash, decoded.plan === 'lifetime' ? null : decoded.expiryDate, decoded.plan);
      const user = db.prepare(
        'INSERT INTO users (tenant_id, username, display_name, mobile, password_hash, role) VALUES (?,?,?,?,?,?) RETURNING *'
      ).get(tenant.id, mob, ownerName || 'Owner', mob, hash, 'owner');
      db.prepare('INSERT INTO tenant_data (tenant_id, data) VALUES (?,?)').run(tenant.id, '{}');
      const billingCycle = ['monthly', 'halfyearly', 'yearly', 'lifetime'].includes(decoded.plan) ? decoded.plan : 'monthly';
      const licKey = generateHostedLicenseKey();
      db.prepare(
        `INSERT INTO tenant_licenses (tenant_id, status, plan_code, billing_cycle, device_limit, license_key, expires_at, last_verified_at)
         VALUES (?, 'ACTIVE', 'BASIC', ?, 5, ?, ?, datetime('now'))`
      ).run(tenant.id, billingCycle, licKey, decoded.plan === 'lifetime' ? null : decoded.expiryDate);
      addLicenseHistory(tenant.id, 'REGISTERED', { toStatus: 'ACTIVE', detail: 'legacy key-based registration (/api/auth/register)' });
      return { tenant, user };
    });
    const { tenant, user } = registerTenant();
    const session = sessions.createSession(db, JWT_SECRET, { user, tenant, req });
    res.status(201).json({
      message: 'Shop registered',
      token: session.accessToken,
      refreshToken: session.refreshToken,
      shopName: tenant.shop_name,
      username: user.display_name,
      role: user.role,
      licenseExpiry: tenant.license_expiry,
      licensePlan: tenant.license_plan,
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'License key or mobile already registered.' });
    }
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/signup — self-service registration (PENDING_APPROVAL) ─────
// New. The legacy /api/auth/register above is left completely untouched, for
// any already-published client build that still requires a license key
// upfront. This flow needs no license key from the customer at all — an
// admin reviews and approves later (see docs/architecture-review/
// RegistrationFlow.md). No JWT is issued here; the account isn't usable yet.
app.post('/api/auth/signup', rateLimit(5, 10 * 60 * 1000), async (req, res) => {
  const { shopName, ownerName, mobile, email, pin, address, gst, requestedPlan, requestedDevicesBucket, requestedModules } = req.body;
  const mob = (mobile || '').replace(/\D/g, '');
  if (!shopName || !ownerName || !mob || !email || !pin) {
    return res.status(400).json({ error: 'Shop name, owner name, mobile number, email, and PIN are required' });
  }
  if (mob.length < 10) {
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const planRow = db.prepare('SELECT code, device_limit FROM subscription_plans WHERE code = ? AND is_active = 1')
    .get(String(requestedPlan || 'TRIAL').toUpperCase());
  const plan = planRow || db.prepare("SELECT code, device_limit FROM subscription_plans WHERE code = 'TRIAL'").get();
  const devicesBucket = ['1-2', '3-5', '5+'].includes(requestedDevicesBucket) ? requestedDevicesBucket : null;
  const modules = Array.isArray(requestedModules) ? requestedModules.filter(m => typeof m === 'string').slice(0, 20) : [];

  try {
    const existingMob = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mob);
    if (existingMob) {
      return res.status(409).json({ error: 'This mobile number is already registered. Please sign in.' });
    }
    const hash = bcrypt.hashSync(pin, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Blocker 3 fix (TenantStatusConsistency.md): wrapped in a transaction so
    // a crash mid-sequence can never leave a tenant with some of these four
    // rows missing — in particular never a tenant with no tenant_licenses
    // row, which is the exact condition the license middleware fails open on.
    const signupTenant = db.transaction(() => {
      const tenant = db.prepare(
        'INSERT INTO tenants (shop_name, address, gst_number) VALUES (?,?,?) RETURNING *'
      ).get(shopName, address || '', gst || '');
      db.prepare(
        `INSERT INTO users (tenant_id, username, display_name, mobile, email, password_hash, role, email_verify_token_hash, email_verify_expires)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(tenant.id, mob, ownerName, mob, email, hash, 'owner', verifyTokenHash, verifyExpires);
      db.prepare('INSERT INTO tenant_data (tenant_id, data) VALUES (?,?)').run(tenant.id, '{}');
      db.prepare(
        `INSERT INTO tenant_licenses (tenant_id, status, plan_code, requested_plan_code, device_limit, requested_devices_bucket, requested_modules)
         VALUES (?, 'PENDING_APPROVAL', ?, ?, ?, ?, ?)`
      ).run(tenant.id, plan.code, plan.code, plan.device_limit, devicesBucket, JSON.stringify(modules));
      addLicenseHistory(tenant.id, 'REGISTERED', { toStatus: 'PENDING_APPROVAL', detail: `requested plan ${plan.code}` });
      return tenant;
    });
    const tenant = signupTenant();

    const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verifyToken}`;
    try {
      await mailer.sendVerificationEmail(email, { shopName, verifyUrl });
    } catch (e) {
      console.error('[Signup] Failed to send verification email:', e.message);
    }

    res.status(201).json({
      message: 'Registration received. Please check your email to verify your address.',
      tenantId: tenant.id,
      status: 'PENDING_APPROVAL',
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Mobile number already registered.' });
    }
    console.error('Signup error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── GET /api/auth/verify-email — clicked from the verification email link ───
// Returns a small static HTML page (not JSON) — this is a link opened in a
// browser/email client, not an API call from the SPA.
app.get('/api/auth/verify-email', (req, res) => {
  const token = req.query.token;
  function sendPage(title, message) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${title} — ShopERP Pro</title></head>` +
      `<body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#222">` +
      `<h2>${title}</h2><p>${message}</p></body></html>`);
  }
  if (!token) return sendPage('Invalid link', 'This verification link is missing a token.');
  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = db.prepare(
      `SELECT id, tenant_id FROM users WHERE email_verify_token_hash = ? AND email_verify_expires > datetime('now')`
    ).get(tokenHash);
    if (!user) {
      return sendPage('Link expired or invalid', 'This verification link has expired or was already used. Request a new one from the sign-in screen.');
    }
    db.prepare(
      `UPDATE users SET email_verified_at = datetime('now'), email_verify_token_hash = NULL, email_verify_expires = NULL WHERE id = ?`
    ).run(user.id);
    addLicenseHistory(user.tenant_id, 'EMAIL_VERIFIED', {});
    sendPage('Email verified', 'Thank you — your email has been verified. Our team will review your registration and approve your account shortly.');
  } catch (e) {
    console.error('Verify-email error:', e);
    sendPage('Something went wrong', 'Please try again later or contact support.');
  }
});

// ── POST /api/auth/resend-verification ───────────────────────────────────────
app.post('/api/auth/resend-verification', rateLimit(3, 10 * 60 * 1000), async (req, res) => {
  const { mobile } = req.body;
  const mob = (mobile || '').replace(/\D/g, '');
  if (!mob) return res.status(400).json({ error: 'Mobile number required' });
  const genericOk = { ok: true, message: 'If that mobile number has a pending verification, a new email has been sent.' };
  try {
    const user = db.prepare(
      `SELECT u.id, u.tenant_id, u.email, u.email_verified_at, t.shop_name FROM users u
       JOIN tenants t ON t.id = u.tenant_id WHERE u.mobile = ?`
    ).get(mob);
    if (!user || user.email_verified_at) {
      return res.json(genericOk); // don't reveal whether a mobile number exists
    }
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET email_verify_token_hash = ?, email_verify_expires = ? WHERE id = ?')
      .run(verifyTokenHash, verifyExpires, user.id);
    const verifyUrl = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verifyToken}`;
    try {
      await mailer.sendVerificationEmail(user.email, { shopName: user.shop_name, verifyUrl });
    } catch (e) {
      console.error('[Resend] Failed to send verification email:', e.message);
    }
    res.json(genericOk);
  } catch (e) {
    console.error('Resend-verification error:', e);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
app.post('/api/auth/login', rateLimit(10, 5 * 60 * 1000), (req, res) => {
  const { mobile, pin, deviceId } = req.body;
  const mob = (mobile || '').replace(/\D/g, '');
  if (!mob || !pin) {
    return res.status(400).json({ error: 'Mobile number and PIN are required' });
  }
  try {
    const row = db.prepare(
      `SELECT u.*, t.shop_name, t.id as tid FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.mobile = ? AND u.is_active = 1`
    ).get(mob);
    // Generic, identical failure for "no such account" and "wrong PIN" —
    // distinguishing them lets an attacker enumerate which mobile numbers
    // are registered ShopERP customers (Issue 3, AuthenticationReview.md).
    // The real reason is still logged, server-side only, for diagnostics.
    if (!row) {
      logger.warn('[Auth] Login failed', { reason: 'mobile not registered' });
      return res.status(401).json({ error: 'Invalid mobile number or PIN.' });
    }
    if (!bcrypt.compareSync(pin, row.password_hash)) {
      logger.warn('[Auth] Login failed', { reason: 'incorrect PIN', tenantId: row.tid, userId: row.id });
      return res.status(401).json({ error: 'Invalid mobile number or PIN.' });
    }
    // Device-limit enforcement (Phase 8) — only when a deviceId is sent (new
    // client builds); absent = old client build, byte-identical old behavior.
    if (deviceId) {
      const known = db.prepare(
        'SELECT id FROM trusted_devices WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND is_active = 1'
      ).get(row.tid, row.id, deviceId);
      const ua = sessions.parseUA(req.headers['user-agent']);
      if (known) {
        db.prepare("UPDATE trusted_devices SET last_login_at = datetime('now'), browser = ?, os = ? WHERE id = ?")
          .run(ua.browser, ua.os, known.id);
      } else {
        const lic = db.prepare('SELECT device_limit FROM tenant_licenses WHERE tenant_id = ?').get(row.tid);
        const deviceLimit = lic ? lic.device_limit : 2;
        const activeCount = db.prepare('SELECT COUNT(*) as c FROM trusted_devices WHERE tenant_id = ? AND is_active = 1').get(row.tid).c;
        if (activeCount >= deviceLimit) {
          return res.status(403).json({
            error: `Device limit reached (${activeCount}/${deviceLimit}). Ask your admin to remove an old device or increase your limit.`,
            code: 'DEVICE_LIMIT_REACHED',
          });
        }
        try {
          db.prepare('INSERT INTO trusted_devices (tenant_id, user_id, device_id, browser, os) VALUES (?,?,?,?,?)')
            .run(row.tid, row.id, deviceId, ua.browser, ua.os);
        } catch (e) {
          // Race: two near-simultaneous first logins from the same brand-new
          // device — UNIQUE(tenant_id,user_id,device_id) means the loser's
          // INSERT throws; harmless, the row exists either way.
        }
      }
    }
    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(row.id);
    const tenant = { id: row.tid, shop_name: row.shop_name };
    const user   = { id: row.id, role: row.role };
    const tenantInfo = db.prepare('SELECT license_expiry, license_plan FROM tenants WHERE id = ?').get(row.tid);
    const session = sessions.createSession(db, JWT_SECRET, { user, tenant, req });
    res.json({
      token: session.accessToken,
      refreshToken: session.refreshToken,
      shopName: row.shop_name,
      username: row.display_name || row.username,
      role: row.role,
      licenseExpiry: tenantInfo ? tenantInfo.license_expiry : null,
      licensePlan: tenantInfo ? tenantInfo.license_plan : 'monthly',
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/refresh — exchange a refresh token for a new access token ─
// Rotates both tokens on every use; see server/sessions.js for why.
app.post('/api/auth/refresh', rateLimit(30, 5 * 60 * 1000), (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  const result = sessions.refreshSession(db, JWT_SECRET, refreshToken);
  if (!result.ok) {
    return res.status(401).json({ error: 'Refresh token is invalid or has been revoked. Please log in again.' });
  }
  res.json({ token: result.accessToken, refreshToken: result.refreshToken });
});

// ── POST /api/auth/logout — revokes the session tied to the current token ────
app.post('/api/auth/logout', requireAuth, (req, res) => {
  if (req.user.sid) sessions.revokeSession(db, req.user.sid);
  res.json({ ok: true });
});

// ── POST /api/auth/heartbeat — updates last_activity (+ optional page) ───────
// Lightweight REST polling for now; Wave 3 (Realtime Presence, not yet built)
// is the WebSocket upgrade of this same signal — this endpoint intentionally
// gives it a session row and a current_page column to build on.
app.post('/api/auth/heartbeat', requireAuth, (req, res) => {
  if (!req.user.sid) return res.json({ ok: true, legacy: true });
  sessions.touchHeartbeat(db, req.user.sid, (req.body && req.body.currentPage) || null);
  res.json({ ok: true });
});

// ── GET /api/auth/sessions — list this tenant's active sessions (owner only) ─
app.get('/api/auth/sessions', requireAuth, requireActive, requireLicenseRead, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can view active sessions' });
  res.json({ sessions: sessions.listActiveSessions(db, req.user.tenantId) });
});

// ── POST /api/auth/sessions/:sessionId/revoke — force-logout one session ─────
app.post('/api/auth/sessions/:sessionId/revoke', requireAuth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can revoke a session' });
  // Ownership check — only allow revoking a session that belongs to this tenant.
  const row = db.prepare('SELECT tenant_id FROM user_sessions WHERE session_id = ?').get(req.params.sessionId);
  if (!row || row.tenant_id !== req.user.tenantId) return res.status(404).json({ error: 'Session not found' });
  sessions.revokeSession(db, req.params.sessionId);
  res.json({ ok: true });
});

// ── POST /api/auth/add-staff ─────────────────────────────────────────────────
app.post('/api/auth/add-staff', requireAuth, requireActive, requireLicenseWrite, (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can add staff' });
  }
  const { displayName, mobile, pin, role = 'staff' } = req.body;
  const mob = (mobile || '').replace(/\D/g, '');
  if (!mob || !pin) {
    return res.status(400).json({ error: 'Mobile number and PIN required' });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
  }
  try {
    const existingMob = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mob);
    if (existingMob) {
      return res.status(409).json({ error: 'This mobile number is already registered' });
    }
    const hash = bcrypt.hashSync(pin, 10);
    const user = db.prepare(
      'INSERT INTO users (tenant_id, username, display_name, mobile, password_hash, role) VALUES (?,?,?,?,?,?) RETURNING id, display_name, role'
    ).get(req.user.tenantId, mob, displayName || mob, mob, hash, role);
    res.status(201).json({ message: 'Staff added', user });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Mobile number already registered' });
    }
    res.status(500).json({ error: 'Failed to add staff' });
  }
});

// ── POST /api/auth/renew-license — apply a new key to this tenant ───────────
app.post('/api/auth/renew-license', requireAuth, rateLimit(10, 10 * 60 * 1000), (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can renew the license' });
  }
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'License key required' });
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(licenseKey)) {
    return res.status(400).json({ error: 'Invalid license key format. Keys look like XXXX-XXXX-XXXX-XXXX.' });
  }
  const decoded = license.decodeKey(licenseKey, license.WEB_LICENSE_MID);
  if (!decoded.valid) {
    return res.status(400).json({ error: 'This license key was not recognized. Double-check it or contact Ravi (+91 94511 00556).' });
  }
  if (decoded.expired) {
    return res.status(400).json({ error: 'This license key has already expired. Contact Ravi (+91 94511 00556) for a new one.' });
  }
  const keyHash = require('crypto').createHash('sha256').update(licenseKey.toUpperCase()).digest('hex');
  try {
    const existing = db.prepare('SELECT id, shop_name FROM tenants WHERE license_key_hash = ? AND id != ?').get(keyHash, req.user.tenantId);
    if (existing) {
      return res.status(409).json({ error: 'This license key is already registered to ' + existing.shop_name + '.' });
    }
    const newExpiry = decoded.plan === 'lifetime' ? null : decoded.expiryDate;
    db.prepare('UPDATE tenants SET license_key_hash = ?, license_expiry = ?, license_plan = ? WHERE id = ?')
      .run(keyHash, newExpiry, decoded.plan, req.user.tenantId);
    console.log(`[License] Tenant ${req.user.tenantId} renewed → ${decoded.plan} (expires ${newExpiry || 'never'})`);
    res.json({ ok: true, licenseExpiry: newExpiry, licensePlan: decoded.plan, message: 'License renewed: ' + decoded.planLabel + (newExpiry ? ' — valid until ' + newExpiry : ' — never expires') });
  } catch (e) {
    console.error('Renew license error:', e);
    res.status(500).json({ error: 'Renewal failed' });
  }
});

// ── GET /api/license/status — called on app boot to check pause/terminate ────
// Deliberately ungated by requireLicenseRead/Write — this endpoint's entire
// purpose is to report status regardless of what that status is, and it's
// also how the client re-verifies after an offline period (Phase 7).
app.get('/api/license/status', requireAuth, (req, res) => {
  const t = db.prepare('SELECT status, suspend_reason, license_expiry, license_plan FROM tenants WHERE id = ?').get(req.user.tenantId);
  if (!t) return res.status(404).json({ error: 'Tenant not found' });

  // UPDATE...RETURNING in one step — this call IS the "re-verify" event, so
  // last_verified_at in the response must be THIS call's timestamp, not
  // whatever was stored from the previous call (a plain SELECT-then-UPDATE
  // would report the stale prior value, leaving a fresh tenant's very first
  // check with no usable offline-grace anchor at all).
  const lic = db.prepare(
    `UPDATE tenant_licenses SET last_verified_at = datetime('now') WHERE tenant_id = ? RETURNING *`
  ).get(req.user.tenantId);
  let license = null;
  if (lic) {
    const devicesUsed = db.prepare('SELECT COUNT(*) as c FROM trusted_devices WHERE tenant_id = ? AND is_active = 1').get(req.user.tenantId).c;
    const daysRemaining = lic.expires_at ? Math.ceil((new Date(lic.expires_at).getTime() - Date.now()) / 86400000) : null;
    license = {
      status: lic.status,
      planCode: lic.plan_code,
      billingCycle: lic.billing_cycle,
      deviceLimit: lic.device_limit,
      devicesUsed,
      expiresAt: lic.expires_at,
      daysRemaining,
      licenseKey: lic.license_key,
      lastVerifiedAt: lic.last_verified_at,
      offlineGraceDays: lic.offline_grace_days,
      requestedModules: JSON.parse(lic.requested_modules || '[]'),
      requestedDevicesBucket: lic.requested_devices_bucket,
      requestedPlanCode: lic.requested_plan_code,
    };
  }

  if (t.license_plan !== 'lifetime' && t.license_expiry && Date.now() > new Date(t.license_expiry).getTime()) {
    return res.json({ status: 'expired', reason: '', licenseExpiry: t.license_expiry, licensePlan: t.license_plan, license });
  }
  res.json({ status: t.status || 'active', reason: t.suspend_reason || '', licenseExpiry: t.license_expiry, licensePlan: t.license_plan, license });
});

// ── POST /api/admin/login — exchange the admin password for a session token ─
// New (Issue 2, PasswordMigration.md). Verifies against admin_credentials:
// bcrypt if already migrated, else the legacy single-round SHA-256 the
// original ADMIN_KEY was — and on a successful *legacy* verification,
// transparently re-hashes with bcrypt and persists that going forward. No
// password reset, no new password, no downtime for the existing operator.
app.post('/api/admin/login', rateLimit(10, 5 * 60 * 1000), (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Invalid credentials' }); // generic — see AuthenticationReview.md
  try {
    const row = db.prepare('SELECT * FROM admin_credentials WHERE id = 1').get();
    if (!row) return res.status(500).json({ error: 'Admin credentials not configured' });

    let verified = false;
    if (row.algo === 'bcrypt') {
      verified = bcrypt.compareSync(password, row.password_hash);
    } else {
      // Legacy path: the original scheme was a single SHA-256 round of the
      // password, compared timing-safely against ADMIN_KEY.
      const candidate = crypto.createHash('sha256').update(password).digest('hex');
      const candidateBuf = Buffer.from(candidate, 'utf8');
      const storedBuf = Buffer.from(row.password_hash, 'utf8');
      verified = candidateBuf.length === storedBuf.length && crypto.timingSafeEqual(candidateBuf, storedBuf);
      if (verified) {
        // Automatic migration on successful login — same password, stronger hash from now on.
        const newHash = bcrypt.hashSync(password, 10);
        db.prepare(`UPDATE admin_credentials SET password_hash = ?, algo = 'bcrypt', updated_at = datetime('now') WHERE id = 1`).run(newHash);
        logger.info('[Admin] Credential automatically migrated from sha256 to bcrypt on successful login');
      }
    }

    if (!verified) {
      logger.warn('[Admin] Login failed', { reason: 'incorrect password' }); // detail stays server-side only — see AuthenticationReview.md
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = issueAdminSession();
    res.json({ ok: true, adminToken: token });
  } catch (e) {
    logger.error('[Admin] Login error', { error: e.message });
    res.status(500).json({ error: 'Invalid credentials' }); // generic even on an internal error — no stack trace, no detail leaked
  }
});

// ── POST /api/admin/tenant/status — pause / terminate / restore (remote) ─────
// tenant_licenses.status is the single authoritative source of truth every
// protected endpoint gates on (TenantStatusConsistency.md, Blocker 1). This
// legacy action still writes tenants.status first, for full backward
// compatibility with every existing reader of that column (requireActive(),
// GET /api/admin/tenants, GET /api/admin/web-users) — but it now ALSO
// synchronizes tenant_licenses.status in the same request, closing the gap
// that let a "terminated" tenant keep working through any endpoint gated
// only by the newer license middleware.
function syncLegacyStatusToLicense(tenantId, legacyStatus, reason) {
  const lic = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return; // no license row yet (should not happen post-fix; fail safe rather than throw)
  const licStatus = legacyStatus === 'paused' ? 'SUSPENDED' : legacyStatus === 'terminated' ? 'ARCHIVED' : 'ACTIVE';
  if (lic.status === licStatus) return; // already in sync, nothing to do
  if (licStatus === 'SUSPENDED') {
    db.prepare(`UPDATE tenant_licenses SET status = 'SUSPENDED', suspended_since = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
    sessions.revokeAllTenantSessions(db, tenantId);
  } else if (licStatus === 'ARCHIVED') {
    db.prepare(`UPDATE tenant_licenses SET status = 'ARCHIVED', updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
    sessions.revokeAllTenantSessions(db, tenantId);
  } else {
    db.prepare(`UPDATE tenant_licenses SET status = 'ACTIVE', read_only_since = NULL, suspended_since = NULL, updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
  }
  addLicenseHistory(tenantId, 'STATUS_CHANGED', { fromStatus: lic.status, toStatus: licStatus, detail: reason || ('legacy admin action: ' + legacyStatus), actor: 'admin' });
}
app.post('/api/admin/tenant/status', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const { shopName, status, reason = '' } = req.body;
  if (!shopName || !status) return res.status(400).json({ error: 'shopName and status required' });
  if (!['active', 'paused', 'terminated'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const t = db.prepare('SELECT id, shop_name FROM tenants WHERE LOWER(shop_name) = LOWER(?)').get(shopName);
  if (!t) return res.status(404).json({ error: 'Shop not found on this server' });
  db.prepare('UPDATE tenants SET status = ?, suspend_reason = ? WHERE id = ?').run(status, reason, t.id);
  syncLegacyStatusToLicense(t.id, status, reason);
  console.log(`[Admin] ${t.shop_name} → ${status}${reason ? ' ('+reason+')' : ''}`);
  res.json({ ok: true, shopName: t.shop_name, status, reason });
});

// ── POST /api/admin/generate-key — mint a license key (Super Admin only) ─────
// The crypto secret lives only here on the server; browsers never see it.
app.post('/api/admin/generate-key', requireAdminKey, rateLimit(60, 60 * 1000), (req, res) => {
  const { plan, machineId } = req.body;
  if (!plan || !license.PLANS[plan]) return res.status(400).json({ error: 'Unknown or missing plan' });
  const mid = machineId ? machineId.replace(/-/g, '').toUpperCase() : license.WEB_LICENSE_MID;
  if (machineId && mid.length !== 16) return res.status(400).json({ error: 'Machine ID must be 16 characters' });
  try {
    const key = license.generateKey(mid, plan);
    const decoded = license.decodeKey(key, mid);
    res.json({ key, plan, planLabel: license.PLANS[plan].label, expiryDate: decoded.expiryDate, hosted: !machineId });
  } catch (e) {
    console.error('Key generation error:', e);
    res.status(500).json({ error: 'Key generation failed' });
  }
});

// ── POST /api/admin/validate-key — decode/inspect a key (Super Admin only) ───
app.post('/api/admin/validate-key', requireAdminKey, rateLimit(60, 60 * 1000), (req, res) => {
  const { key, machineId } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  const mid = machineId ? machineId.replace(/-/g, '').toUpperCase() : license.WEB_LICENSE_MID;
  res.json(license.decodeKey(key, mid));
});

// ── GET /api/admin/tenants — list all tenants with status ────────────────────
app.get('/api/admin/tenants', requireAdminKey, (req, res) => {
  const tenants = db.prepare(
    "SELECT id, shop_name, status, suspend_reason, created_at FROM tenants ORDER BY created_at DESC"
  ).all();
  res.json({ tenants });
});

// ── GET /api/admin/web-users — all users across all shops ────────────────────
app.get('/api/admin/web-users', requireAdminKey, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id, u.display_name, u.mobile, u.role, u.is_active, u.last_login, u.created_at,
             t.id AS tenant_id, t.shop_name, t.status AS shop_status, t.license_plan
      FROM users u
      JOIN tenants t ON t.id = u.tenant_id
      ORDER BY t.shop_name, u.role DESC, u.created_at
    `).all();
    // Group by shop
    const shops = {};
    rows.forEach(r => {
      if (!shops[r.tenant_id]) {
        shops[r.tenant_id] = { tenantId: r.tenant_id, shopName: r.shop_name, shopStatus: r.shop_status, licensePlan: r.license_plan, users: [] };
      }
      shops[r.tenant_id].users.push({
        id: r.id, name: r.display_name || r.mobile, mobile: r.mobile,
        role: r.role, isActive: r.is_active === 1, lastLogin: r.last_login, createdAt: r.created_at
      });
    });
    res.json({ shops: Object.values(shops) });
  } catch (e) {
    console.error('web-users error:', e);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── POST /api/admin/reset-user-pin — force new PIN for a web user ────────────
app.post('/api/admin/reset-user-pin', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const { userId, newPin } = req.body;
  if (!userId || !newPin) return res.status(400).json({ error: 'userId and newPin required' });
  if (!/^\d{6}$/.test(newPin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
  try {
    const user = db.prepare('SELECT id, display_name, mobile, tenant_id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const hash = bcrypt.hashSync(newPin, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    console.log(`[Admin] PIN reset for user ${userId} (${user.display_name || user.mobile})`);
    res.json({ ok: true, userId, name: user.display_name || user.mobile, mobile: user.mobile });
  } catch (e) {
    console.error('reset-pin error:', e);
    res.status(500).json({ error: 'Failed to reset PIN' });
  }
});

// ── POST /api/admin/toggle-user — enable / disable a specific web user ────────
app.post('/api/admin/toggle-user', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const { userId, active } = req.body;
  if (userId === undefined || active === undefined) return res.status(400).json({ error: 'userId and active required' });
  try {
    const user = db.prepare('SELECT id, display_name, mobile, role FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner' && !active) {
      // make sure shop has at least one active owner before blocking
      const ownerCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE tenant_id=(SELECT tenant_id FROM users WHERE id=?) AND role='owner' AND is_active=1").get(userId);
      if (ownerCount.c <= 1) return res.status(400).json({ error: 'Cannot disable the only active owner of a shop.' });
    }
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, userId);
    const status = active ? 'enabled' : 'disabled';
    console.log(`[Admin] User ${userId} (${user.display_name || user.mobile}) ${status}`);
    res.json({ ok: true, userId, name: user.display_name || user.mobile, isActive: active });
  } catch (e) {
    console.error('toggle-user error:', e);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── GET /api/admin/registrations — PENDING_APPROVAL queue (Phase 2) ─────────
app.get('/api/admin/registrations', requireAdminKey, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.id AS tenant_id, t.shop_name, t.address, t.gst_number, t.created_at AS registered_at,
             u.display_name AS owner_name, u.mobile, u.email, u.email_verified_at,
             tl.requested_plan_code, tl.requested_devices_bucket, tl.requested_modules
      FROM tenant_licenses tl
      JOIN tenants t ON t.id = tl.tenant_id
      JOIN users u ON u.tenant_id = t.id AND u.role = 'owner'
      WHERE tl.status = 'PENDING_APPROVAL'
      ORDER BY t.created_at ASC
    `).all();
    res.json({
      registrations: rows.map(r => ({
        tenantId: r.tenant_id, shopName: r.shop_name, address: r.address, gstNumber: r.gst_number,
        registeredAt: r.registered_at, ownerName: r.owner_name, mobile: r.mobile, email: r.email,
        emailVerified: !!r.email_verified_at,
        requestedPlan: r.requested_plan_code, requestedDevicesBucket: r.requested_devices_bucket,
        requestedModules: JSON.parse(r.requested_modules || '[]'),
      })),
    });
  } catch (e) {
    console.error('registrations error:', e);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// ── POST /api/admin/registrations/:tenantId/approve ──────────────────────────
app.post('/api/admin/registrations/:tenantId/approve', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const lic = db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  if (lic.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ error: 'This registration is not pending approval (current status: ' + lic.status + ')' });
  }
  const owner = db.prepare("SELECT email_verified_at FROM users WHERE tenant_id = ? AND role = 'owner'").get(tenantId);
  if (!owner || !owner.email_verified_at) {
    return res.status(400).json({ error: 'This shop has not verified their email yet. Ask them to check their inbox (or use Resend) before approving.' });
  }
  try {
    // If nothing was pre-configured (assign-plan/start-trial/generate-license
    // never called), auto-default to a 14-day TRIAL so Approve is always
    // safe to click on its own.
    let planResult = null;
    if (!lic.starts_at) {
      planResult = assignPlanToTenant(tenantId, 'TRIAL', 'trial');
    }
    if (!lic.license_key) {
      const key = generateHostedLicenseKey();
      db.prepare('UPDATE tenant_licenses SET license_key = ? WHERE tenant_id = ?').run(key, tenantId);
    }
    db.prepare(`UPDATE tenant_licenses SET status = 'ACTIVE', updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
    addLicenseHistory(tenantId, 'APPROVED', {
      fromStatus: 'PENDING_APPROVAL', toStatus: 'ACTIVE',
      detail: planResult ? `auto-defaulted to ${planResult.planCode}/${planResult.billingCycle}` : '', actor: 'admin',
    });
    res.json({ ok: true, status: 'ACTIVE' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Approval failed' });
  }
});

// ── POST /api/admin/registrations/:tenantId/reject ───────────────────────────
// No dedicated REJECTED state in the fixed 5-status enum — ARCHIVED's "soft,
// never delete" semantics fit a rejected signup (data, if any, is retained).
app.post('/api/admin/registrations/:tenantId/reject', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { reason } = req.body;
  const lic = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  if (lic.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ error: 'This registration is not pending approval (current status: ' + lic.status + ')' });
  }
  db.prepare(`UPDATE tenant_licenses SET status = 'ARCHIVED', updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
  addLicenseHistory(tenantId, 'REJECTED', { fromStatus: 'PENDING_APPROVAL', toStatus: 'ARCHIVED', detail: reason || '', actor: 'admin' });
  res.json({ ok: true, status: 'ARCHIVED' });
});

// ── GET /api/admin/tenant-licenses — Phase 9 full dashboard ──────────────────
app.get('/api/admin/tenant-licenses', requireAdminKey, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.id AS tenant_id, t.shop_name, t.created_at AS registered_at,
             tl.status, tl.plan_code, tl.billing_cycle, tl.device_limit, tl.expires_at,
             tl.requested_modules, tl.license_key,
             (SELECT MAX(last_login) FROM users WHERE tenant_id = t.id) AS last_login,
             (SELECT COUNT(*) FROM trusted_devices WHERE tenant_id = t.id AND is_active = 1) AS devices_used
      FROM tenant_licenses tl
      JOIN tenants t ON t.id = tl.tenant_id
      ORDER BY t.shop_name
    `).all();
    const now = Date.now();
    res.json({
      tenants: rows.map(r => ({
        tenantId: r.tenant_id, shopName: r.shop_name, registeredAt: r.registered_at,
        status: r.status, planCode: r.plan_code, billingCycle: r.billing_cycle,
        deviceLimit: r.device_limit, devicesUsed: r.devices_used,
        expiresAt: r.expires_at,
        daysRemaining: r.expires_at ? Math.ceil((new Date(r.expires_at).getTime() - now) / 86400000) : null,
        requestedModules: JSON.parse(r.requested_modules || '[]'),
        licenseKey: r.license_key, lastLogin: r.last_login,
      })),
    });
  } catch (e) {
    console.error('tenant-licenses error:', e);
    res.status(500).json({ error: 'Failed to fetch tenant licenses' });
  }
});

// ── GET /api/admin/tenant-licenses/:tenantId/history — audit trail ──────────
app.get('/api/admin/tenant-licenses/:tenantId/history', requireAdminKey, (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const history = db.prepare('SELECT * FROM license_history WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
  res.json({ history });
});

// ── POST /api/admin/tenant-licenses/:tenantId/assign-plan ────────────────────
app.post('/api/admin/tenant-licenses/:tenantId/assign-plan', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const lic = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  try {
    const result = assignPlanToTenant(tenantId, req.body.planCode, req.body.billingCycle, req.body.deviceLimitOverride);
    addLicenseHistory(tenantId, 'PLAN_ASSIGNED', { detail: `${result.planCode}/${result.billingCycle}, device_limit=${result.deviceLimit}`, actor: 'admin' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to assign plan' });
  }
});

// ── POST /api/admin/tenant-licenses/:tenantId/start-trial — Assign-Plan shortcut ─
app.post('/api/admin/tenant-licenses/:tenantId/start-trial', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const lic = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  try {
    const result = assignPlanToTenant(tenantId, 'TRIAL', 'trial');
    addLicenseHistory(tenantId, 'TRIAL_STARTED', { detail: `expires ${result.expiresAt}`, actor: 'admin' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to start trial' });
  }
});

// ── POST /api/admin/tenant-licenses/:tenantId/generate-license ───────────────
app.post('/api/admin/tenant-licenses/:tenantId/generate-license', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { regenerate } = req.body || {};
  const lic = db.prepare('SELECT license_key FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  if (lic.license_key && !regenerate) {
    return res.status(409).json({ error: 'A license key already exists for this tenant. Pass regenerate:true to replace it.', licenseKey: lic.license_key });
  }
  try {
    const key = generateHostedLicenseKey();
    db.prepare(`UPDATE tenant_licenses SET license_key = ?, updated_at = datetime('now') WHERE tenant_id = ?`).run(key, tenantId);
    addLicenseHistory(tenantId, lic.license_key ? 'KEY_REGENERATED' : 'KEY_GENERATED', { detail: key, actor: 'admin' });
    res.json({ ok: true, licenseKey: key });
  } catch (e) {
    console.error('generate-license error:', e);
    res.status(500).json({ error: 'Failed to generate license key' });
  }
});

// ── POST /api/admin/tenant-licenses/:tenantId/extend — Phase 10 renewal ─────
// Updates expires_at (and reactivates if currently READ_ONLY/SUSPENDED).
// Nothing else changes — tenant_data is never touched.
app.post('/api/admin/tenant-licenses/:tenantId/extend', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const lic = db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  if (lic.status === 'PENDING_APPROVAL') return res.status(400).json({ error: 'Approve this registration before extending the subscription.' });
  if (lic.status === 'ARCHIVED') return res.status(400).json({ error: 'This account is archived. Reactivate it first.' });

  const { days, newExpiresAt } = req.body;
  let expiresAt;
  if (newExpiresAt) {
    expiresAt = new Date(newExpiresAt).toISOString();
  } else if (typeof days === 'number' && days > 0) {
    const base = (lic.expires_at && new Date(lic.expires_at).getTime() > Date.now()) ? new Date(lic.expires_at) : new Date();
    expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  } else {
    return res.status(400).json({ error: 'Provide either days (number) or newExpiresAt (date string)' });
  }
  db.prepare(
    `UPDATE tenant_licenses SET expires_at = ?, status = 'ACTIVE', read_only_since = NULL, suspended_since = NULL, updated_at = datetime('now') WHERE tenant_id = ?`
  ).run(expiresAt, tenantId);
  addLicenseHistory(tenantId, 'EXTENDED', { fromStatus: lic.status, toStatus: 'ACTIVE', detail: `expires_at -> ${expiresAt}`, actor: 'admin' });
  res.json({ ok: true, expiresAt, reactivated: lic.status === 'READ_ONLY' || lic.status === 'SUSPENDED' });
});

// ── POST /api/admin/tenant-licenses/:tenantId/suspend — manual suspend ──────
app.post('/api/admin/tenant-licenses/:tenantId/suspend', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { reason } = req.body;
  const lic = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  db.prepare(`UPDATE tenant_licenses SET status = 'SUSPENDED', suspended_since = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
  sessions.revokeAllTenantSessions(db, tenantId);
  addLicenseHistory(tenantId, 'STATUS_CHANGED', { fromStatus: lic.status, toStatus: 'SUSPENDED', detail: reason || 'manual admin suspend', actor: 'admin' });
  res.json({ ok: true });
});

// ── POST /api/admin/tenant-licenses/:tenantId/reactivate ─────────────────────
app.post('/api/admin/tenant-licenses/:tenantId/reactivate', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const lic = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  db.prepare(`UPDATE tenant_licenses SET status = 'ACTIVE', read_only_since = NULL, suspended_since = NULL, updated_at = datetime('now') WHERE tenant_id = ?`).run(tenantId);
  addLicenseHistory(tenantId, 'STATUS_CHANGED', { fromStatus: lic.status, toStatus: 'ACTIVE', detail: 'manual admin reactivate', actor: 'admin' });
  res.json({ ok: true });
});

// ── POST /api/admin/tenant-licenses/:tenantId/kill-sessions ──────────────────
app.post('/api/admin/tenant-licenses/:tenantId/kill-sessions', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const revoked = sessions.revokeAllTenantSessions(db, tenantId);
  addLicenseHistory(tenantId, 'SESSIONS_KILLED', { detail: `${revoked} session(s) revoked`, actor: 'admin' });
  res.json({ ok: true, revoked });
});

// ── POST /api/admin/tenant-licenses/:tenantId/notes ──────────────────────────
app.post('/api/admin/tenant-licenses/:tenantId/notes', requireAdminKey, rateLimit(60, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note required' });
  addLicenseHistory(tenantId, 'NOTE_ADDED', { detail: note, actor: 'admin' });
  res.json({ ok: true });
});

// ── POST /api/admin/tenant-licenses/:tenantId/call-note ──────────────────────
app.post('/api/admin/tenant-licenses/:tenantId/call-note', requireAdminKey, rateLimit(60, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note required' });
  addLicenseHistory(tenantId, 'CALL_LOGGED', { detail: note, actor: 'admin' });
  res.json({ ok: true });
});

// ── GET /api/admin/tenant-licenses/:tenantId/devices ──────────────────────────
app.get('/api/admin/tenant-licenses/:tenantId/devices', requireAdminKey, (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const devices = db.prepare(`
    SELECT d.id, d.device_id, d.device_name, d.browser, d.os, d.first_login_at, d.last_login_at, d.is_active,
           u.display_name, u.mobile
    FROM trusted_devices d JOIN users u ON u.id = d.user_id
    WHERE d.tenant_id = ? ORDER BY d.last_login_at DESC
  `).all(tenantId);
  res.json({ devices });
});

// ── POST /api/admin/tenant-licenses/:tenantId/devices/:rowId/remove ──────────
app.post('/api/admin/tenant-licenses/:tenantId/devices/:rowId/remove', requireAdminKey, rateLimit(60, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const rowId = Number(req.params.rowId);
  const row = db.prepare('SELECT id FROM trusted_devices WHERE id = ? AND tenant_id = ?').get(rowId, tenantId);
  if (!row) return res.status(404).json({ error: 'Device not found' });
  db.prepare('UPDATE trusted_devices SET is_active = 0 WHERE id = ?').run(rowId); // soft-remove only — audit trail preserved
  addLicenseHistory(tenantId, 'DEVICE_REMOVED', { detail: `device row ${rowId}`, actor: 'admin' });
  res.json({ ok: true });
});

// ── POST /api/admin/tenant-licenses/:tenantId/devices/reset-all ─────────────
app.post('/api/admin/tenant-licenses/:tenantId/devices/reset-all', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const result = db.prepare('UPDATE trusted_devices SET is_active = 0 WHERE tenant_id = ? AND is_active = 1').run(tenantId);
  addLicenseHistory(tenantId, 'DEVICES_RESET', { detail: `${result.changes} device(s) reset`, actor: 'admin' });
  res.json({ ok: true, reset: result.changes });
});

// ── POST /api/admin/tenant-licenses/:tenantId/devices/limit ──────────────────
app.post('/api/admin/tenant-licenses/:tenantId/devices/limit', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const { deviceLimit } = req.body;
  if (typeof deviceLimit !== 'number' || deviceLimit < 1) return res.status(400).json({ error: 'deviceLimit must be a positive number' });
  const lic = db.prepare('SELECT device_limit FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
  if (!lic) return res.status(404).json({ error: 'Tenant license not found' });
  db.prepare(`UPDATE tenant_licenses SET device_limit = ?, updated_at = datetime('now') WHERE tenant_id = ?`).run(deviceLimit, tenantId);
  addLicenseHistory(tenantId, 'DEVICE_LIMIT_CHANGED', { detail: `${lic.device_limit} -> ${deviceLimit}`, actor: 'admin' });
  res.json({ ok: true, deviceLimit });
});

// ── GET /api/data ────────────────────────────────────────────────────────────
app.get('/api/data', requireAuth, requireActive, requireLicenseRead, (req, res) => {
  try {
    const row = db.prepare('SELECT data, version, updated_at FROM tenant_data WHERE tenant_id = ?').get(req.user.tenantId);
    if (!row) return res.json({ data: {}, version: 0, updatedAt: null });
    res.json({ data: JSON.parse(row.data || '{}'), version: row.version, updatedAt: row.updated_at });
  } catch (e) {
    console.error('Load data error:', e);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// ── PUT /api/data — optimistic concurrency: caller must supply the version ───
// it last read (expectedVersion). Never silently overwrites a newer save from
// another device — see docs/architecture-review/ConflictResolution.md.
app.put('/api/data', requireAuth, requireActive, requireLicenseWrite, (req, res) => {
  const { data, expectedVersion } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data must be a JSON object' });
  }
  if (typeof expectedVersion !== 'number') {
    // Missing/old-client request — fail safe into the same conflict path
    // below rather than guessing at what version it thinks it has.
    return sendConflict(req, res);
  }
  try {
    const existing = db.prepare('SELECT version FROM tenant_data WHERE tenant_id = ?').get(req.user.tenantId);
    if (!existing) {
      // Tenant has no tenant_data row at all — some pre-existing accounts
      // predate this column set (or any INSERT ever running for them; found
      // during Wave 0/1 review). GET /api/data reports version:0 for this
      // state, so 0 is the only expectedVersion that means "I know there's
      // nothing here yet." Anything else means the client's assumption is
      // stale even about that.
      if (expectedVersion !== 0) return sendConflict(req, res);
      try {
        db.prepare(
          `INSERT INTO tenant_data (tenant_id, data, version, updated_at, updated_by) VALUES (?, ?, 1, datetime('now'), ?)`
        ).run(req.user.tenantId, JSON.stringify(data), req.user.userId);
      } catch (insertErr) {
        // Lost a race to a concurrent first save from another device for the
        // same tenant (tenant_id is tenant_data's primary key, so the second
        // INSERT throws) — no data was overwritten, just tell this caller to
        // reload and retry with the real version.
        return sendConflict(req, res);
      }
      return res.json({ ok: true, version: 1, savedAt: new Date().toISOString() });
    }
    const result = db.prepare(
      `UPDATE tenant_data
       SET data = ?, version = version + 1, updated_at = datetime('now'), updated_by = ?
       WHERE tenant_id = ? AND version = ?`
    ).run(JSON.stringify(data), req.user.userId, req.user.tenantId, expectedVersion);
    if (result.changes === 0) {
      return sendConflict(req, res);
    }
    const row = db.prepare('SELECT version, updated_at FROM tenant_data WHERE tenant_id = ?').get(req.user.tenantId);
    res.json({ ok: true, version: row.version, savedAt: row.updated_at });
  } catch (e) {
    console.error('Save error:', e);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

function sendConflict(req, res) {
  try {
    const row = db.prepare('SELECT version, updated_at, updated_by FROM tenant_data WHERE tenant_id = ?').get(req.user.tenantId);
    let updatedByName = null;
    if (row && row.updated_by) {
      const u = db.prepare('SELECT display_name, mobile FROM users WHERE id = ?').get(row.updated_by);
      if (u) updatedByName = u.display_name || u.mobile;
    }
    res.status(409).json({
      error: 'This shop\'s data was updated from another device. Reload to get the latest version before saving again.',
      currentVersion: row ? row.version : 0,
      currentUpdatedAt: row ? row.updated_at : null,
      updatedByName,
    });
  } catch (e) {
    console.error('Conflict lookup error:', e);
    res.status(409).json({ error: 'This shop\'s data was updated from another device. Reload to get the latest version before saving again.' });
  }
}

// ── GET /api/data/users ──────────────────────────────────────────────────────
app.get('/api/data/users', requireAuth, requireActive, requireLicenseRead, (req, res) => {
  try {
    const users = db.prepare(
      'SELECT id, username, email, role, is_active, last_login, created_at FROM users WHERE tenant_id = ? ORDER BY created_at'
    ).all(req.user.tenantId);
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── POST /api/cloud/backup — push encrypted shop data tied to license key hash ─
// X-License-Key header must be the raw 19-char license key (validated server-side by SHA-256)
app.post('/api/cloud/backup', requireAdminKey, (req, res) => {
  // In production this endpoint is called from the app with the admin key embedded.
  // For open deployment, swap requireAdminKey with a per-tenant token.
  const { keyHash, shopName, data } = req.body;
  if (!keyHash || !data) return res.status(400).json({ error: 'keyHash and data required' });
  try {
    db.prepare(
      `INSERT INTO cloud_backups (key_hash, shop_name, data, backed_up_at)
       VALUES (?,?,?,datetime('now'))
       ON CONFLICT(key_hash) DO UPDATE SET
         shop_name=excluded.shop_name,
         data=excluded.data,
         backed_up_at=excluded.backed_up_at`
    ).run(keyHash, shopName || '', data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Backup failed' });
  }
});

// ── GET /api/cloud/restore/:keyHash — pull backup for a license key ───────────
app.get('/api/cloud/restore/:keyHash', requireAdminKey, (req, res) => {
  const row = db.prepare('SELECT data, shop_name, backed_up_at FROM cloud_backups WHERE key_hash = ?').get(req.params.keyHash);
  if (!row) return res.status(404).json({ error: 'No backup found for this license key' });
  res.json({ data: row.data, shopName: row.shop_name, backedUpAt: row.backed_up_at });
});

// ── DELETE /api/cloud/backup/:keyHash — wipe backup (admin only) ──────────────
app.delete('/api/cloud/backup/:keyHash', requireAdminKey, (req, res) => {
  db.prepare('DELETE FROM cloud_backups WHERE key_hash = ?').run(req.params.keyHash);
  res.json({ ok: true });
});

// ── Strip the license crypto engine before serving HTML to browsers ─────────
// Electron loads app/*.html directly from disk, bypassing this server, so it
// still gets the full offline engine for machine-locked desktop activation.
// Anything served over HTTP (this route) must NEVER contain MASTER_SECRET or
// the functions that use it — otherwise any browser visitor could read the
// page source and forge their own license keys.
//
// Each block below must match the source file's text exactly. If the source
// changes and a block no longer matches, stripping fails LOUDLY (throws) so
// we refuse to serve the page rather than risk leaking the secret silently.
const _SECRET_BLOCKS = [
  `const MASTER_SECRET = 'SH0P3RP0-PR0-M4ST3R-K3Y-D33P4K-2025-X9Z';`,
  `function computeSegments(mid, planCode, expiryDays) {
  const eD = (expiryDays >>> 0);
  const pC = (planCode   >>> 0);
  // Base string: machine + plan + expiry + secret (no custId)
  const base = mid + '|' + pC + '|' + eD + '|' + MASTER_SECRET;
  const h1 = fnv32(base + '~S1');
  const h2 = fnv32(base + '~S2');
  const h3 = fnv32(base + '~S3');
  const h4 = fnv32(base + '~S4');
  // XOR with plan and expiry constants to guarantee plan-distinct keys
  const x1 = (h1 ^ ((eD & 0xFFFF) * pC)) >>> 0;
  const x2 = (h2 ^ (pC * 0x9E37))        >>> 0;
  const x3 = (h3 ^ (eD >> 4))             >>> 0;
  const x4 = (h4 ^ (pC << 8))             >>> 0;
  return [enc(x1, 4), enc(x2, 4), enc(x3, 4), enc(x4, 4)];
}`,
  `function generateKey(machineId, plan, custId) {
  const p = PLANS[plan];
  if (!p) throw new Error('Unknown plan: ' + plan);
  const mid = machineId.replace(/-/g, '').toUpperCase().padEnd(16, '0').substring(0, 16);
  const todayDays = Math.floor(Date.now() / 86400000);
  const expiryDays = (todayDays + p.days) >>> 0;
  const segs = computeSegments(mid, p.code, expiryDays);
  return segs.join('-');
}`,
  `function validateKeyForReset(key, machineId){
  var clean=key.replace(/-/g,'').toUpperCase();
  if(clean.length!==16)return false;
  for(var _ci=0;_ci<clean.length;_ci++){if(CS.indexOf(clean[_ci])<0)return false;}
  var mid=machineId.replace(/-/g,'').toUpperCase().padEnd(16,'0').substring(0,16);
  var todayDays=Math.floor(Date.now()/86400000);
  var planKeys=Object.keys(PLANS);
  for(var pi=0;pi<planKeys.length;pi++){
    var p=PLANS[planKeys[pi]];
    var lookback=Math.min(365,p.days+365);
    for(var ago=0;ago<=lookback;ago++){
      var expiryDays=(todayDays-ago+p.days)>>>0;
      var segs=computeSegments(mid,p.code,expiryDays);
      if(segs.join('')===clean)return true;
    }
  }
  return false;
}`,
  `function validateKey(key, machineId) {
  const clean = key.replace(/-/g, '').toUpperCase();
  if (clean.length !== 16) return { valid: false, message: 'Key must be 16 characters (got ' + clean.length + ')' };
  for (const c of clean) {
    if (CS.indexOf(c) < 0) return { valid: false, message: 'Invalid character in key: ' + c };
  }
  const mid = machineId.replace(/-/g, '').toUpperCase().padEnd(16, '0').substring(0, 16);
  const todayDays = Math.floor(Date.now() / 86400000);

  // Try every plan × every possible issue date
  for (const [planId, p] of Object.entries(PLANS)) {
    for (let ago = 0; ago <= p.days; ago++) {
      const expiryDays = (todayDays - ago + p.days) >>> 0;
      const segs = computeSegments(mid, p.code, expiryDays);
      if (segs.join('') === clean) {
        const daysLeft = Math.max(0, expiryDays - todayDays);
        const expired  = daysLeft <= 0;
        const expDate  = new Date(expiryDays * 86400000).toISOString().split('T')[0];
        return {
          valid: true, expired,
          plan: planId, planLabel: p.label,
          expiryDate: expDate, daysLeft,
          message: expired
            ? 'Expired ' + (todayDays - expiryDays) + ' days ago'
            : planId === 'lifetime'
              ? 'Lifetime - never expires'
              : daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + ' remaining (expires ' + expDate + ')',
        };
      }
    }
  }
  return { valid: false, message: 'Key is invalid or belongs to a different machine' };
}`,
  `function runSelfTest() {
  const mid   = 'A3F29B1C7E4D2F8A';
  const wrong = 'FFFFFFFFFFFFFFFF';
  const results = [];
  const allKeys = [];
  let pass = 0, fail = 0;

  for (const planId of Object.keys(PLANS)) {
    // Generate with various custIds - should produce SAME key (custId doesn't matter)
    const key1 = generateKey(mid, planId, 'CUST1');
    const key2 = generateKey(mid, planId, 'CUST99');
    const key3 = generateKey(mid, planId, undefined);
    const custIdIndependent = (key1 === key2 && key2 === key3);

    const r1 = validateKey(key1, mid);    // correct machine
    const r2 = validateKey(key1, wrong);  // wrong machine
    const planMatch = r1.plan === planId;
    const isUnique  = !allKeys.includes(key1);
    allKeys.push(key1);

    const ok = r1.valid && !r1.expired && !r2.valid && planMatch && isUnique && custIdIndependent;
    if (ok) pass++; else fail++;
    results.push({ planId, key: key1, valid: r1.valid, wrongValid: r2.valid, planMatch, isUnique, custIdIndependent, status: ok ? 'PASS' : 'FAIL' });
  }
  return { pass, fail, total: pass + fail, results };
}`,
];

function stripLicenseSecrets(html) {
  let out = html;
  for (const block of _SECRET_BLOCKS) {
    if (!out.includes(block)) {
      throw new Error('License engine block not found while stripping (source may have changed): ' + block.slice(0, 50) + '...');
    }
    out = out.split(block).join('// [license engine — server-side only, see server/license.js]');
  }
  return out;
}

// ── Serve the ShopERP HTML (local/single-device mode) ────────────────────────
// App runs in local mode — data stays in browser localStorage on this device.
app.get('/', (req, res) => {
  if (!fs.existsSync(HTML_PATH)) {
    return res.status(404).send('ShopERP_Pro_v8.html not found. Make sure the app/ folder is next to server/');
  }
  const rawHtml = fs.readFileSync(HTML_PATH, 'utf8');
  let html;
  try {
    html = stripLicenseSecrets(rawHtml);
  } catch (e) {
    console.error('[SECURITY] Refusing to serve HTML — license engine stripping failed:', e.message);
    return res.status(500).send('Server misconfiguration — the app file could not be safely served. Contact admin.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(html);
});

// ── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  const ip  = getLocalIp();
  const url = `http://${ip}:${PORT}`;
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   ShopERP Pro - Local Server  ✅ Running           ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║  This PC  →  http://localhost:${PORT}               ║`);
  console.log(`║  Phone / Tablet / Other PC on WiFi →               ║`);
  console.log(`║             ${url.padEnd(38)}║`);
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║  Remote Admin Control (pause / terminate shops):  ║');
  console.log('║  Set ADMIN_KEY env var = sha256 of admin password ║');
  // Blocker 3 (TenantStatusConsistency.md): used to print the first 16 hex
  // characters of the actual key hash here — real secret material, even if
  // truncated, has no reason to be in stdout logs that a log aggregator may
  // retain far more permissively than the secret store itself. A yes/no
  // confirmation gives an operator the same practical signal (did my .env
  // override take effect) with nothing to leak.
  console.log('║  Custom key configured: ' + (process.env.ADMIN_KEY ? 'yes' : 'NO — using the default key, set ADMIN_KEY'));
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║  Press Ctrl+C to stop                             ║');
  console.log('╚════════════════════════════════════════════════════╝');
  // Printed outside the fixed-width box since DB_PATH can be arbitrarily
  // long (e.g. a temp test file path) — and deliberately loud when it's not
  // the default, so a test run is never mistakable for a production one.
  const isDefaultDbPath = DB_PATH === path.join(__dirname, 'shoperpro.db');
  if (isDefaultDbPath) {
    console.log(`Data saved to: ${DB_PATH}\n`);
  } else {
    console.log(`\n⚠️  NON-DEFAULT DATABASE — DB_PATH override in effect:`);
    console.log(`   ${DB_PATH}\n`);
  }
});

// Blocker 3 (TenantStatusConsistency.md): graceful shutdown. Previously
// absent — a SIGTERM (docker stop / systemctl restart / most orchestrators)
// killed the process immediately with no chance to stop accepting new
// connections or close the DB handle cleanly. WAL-mode SQLite tolerates an
// abrupt kill without corruption regardless, so this was a low
// data-integrity risk — but a real availability one (in-flight requests get
// a connection reset instead of a response) that costs nothing to close.
function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received, closing server...`);
  server.close(() => {
    try { db.close(); } catch (_) {}
    console.log('[Shutdown] Closed out remaining connections. Exiting.');
    process.exit(0);
  });
  // Force-exit if some connection never drains (default Node keep-alive is
  // 5s; give it 10s of headroom before giving up on a clean close).
  setTimeout(() => {
    console.error('[Shutdown] Forced exit — some connections did not close in time.');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
