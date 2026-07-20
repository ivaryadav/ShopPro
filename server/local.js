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

// ── Startup validation ────────────────────────────────────────────────────────
// OperationalReadinessPlan.md §2. Two checks, neither changing existing
// behavior for a correctly-configured deployment:
//
// 1. ADMIN_KEY unset → warn loudly, don't fail. Unset is a legitimate
//    default for local single-shop use (unlike JWT_SECRET above, which
//    fails hard — an unset JWT_SECRET silently breaks every session on
//    restart, a correctness bug; an unset ADMIN_KEY just means a known,
//    fixed admin credential, a security posture question the operator
//    should see plainly rather than discover later). Already visible via
//    GET /health's startup.adminKeyIsDefault — this adds the boot-time
//    visibility that check alone doesn't give an operator who never polls
//    /health.
// 2. DB_PATH's parent directory must exist and be writable before
//    new Database(DB_PATH) is attempted, so a bad path fails with a clear,
//    operator-actionable message instead of better-sqlite3's own raw
//    "unable to open database file" (FailureScenarioReport.md scenario 2
//    already confirmed the server fails closed here — this only improves
//    the message, not the fail-closed behavior itself).
if (!process.env.ADMIN_KEY) {
  logger.warn('ADMIN_KEY not set — using the default admin key hash', {
    hint: 'Set ADMIN_KEY in server/.env to use your own admin password. See GET /health for a live check.',
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

// Validates X-Admin-Key header for Super Admin remote control endpoints.
// Uses a timing-safe comparison (S-10, SecurityHardeningReview.md) instead
// of `!==`, which short-circuits on the first mismatched byte — a
// textbook timing side-channel, however impractical to exploit over a
// real network. crypto.timingSafeEqual() requires equal-length buffers, so
// the length check must happen first (and is itself not a useful timing
// oracle: key length is not a secret, unlike its content).
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  const keyBuf = Buffer.from(key || '', 'utf8');
  const adminKeyBuf = Buffer.from(ADMIN_KEY, 'utf8');
  const valid = key
    && keyBuf.length === adminKeyBuf.length
    && crypto.timingSafeEqual(keyBuf, adminKeyBuf);
  if (!valid) return res.status(401).json({ error: 'Invalid admin key' });
  next();
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
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https://prod.spline.design https://app.spline.design; media-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' https://prod.spline.design https://unpkg.com; worker-src 'self' blob:; frame-ancestors 'none';"
  );
  next();
});

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
      jwtSecretConfigured: true,
      adminKeyIsDefault: !process.env.ADMIN_KEY,
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
    const hash   = bcrypt.hashSync(pin, 10);
    const tenant = db.prepare(
      'INSERT INTO tenants (shop_name, license_key_hash, license_expiry, license_plan) VALUES (?,?,?,?) RETURNING *'
    ).get(shopName, keyHash, decoded.plan === 'lifetime' ? null : decoded.expiryDate, decoded.plan);
    const user = db.prepare(
      'INSERT INTO users (tenant_id, username, display_name, mobile, password_hash, role) VALUES (?,?,?,?,?,?) RETURNING *'
    ).get(tenant.id, mob, ownerName || 'Owner', mob, hash, 'owner');
    db.prepare('INSERT INTO tenant_data (tenant_id, data) VALUES (?,?)').run(tenant.id, '{}');
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

// ── POST /api/auth/login ─────────────────────────────────────────────────────
app.post('/api/auth/login', rateLimit(10, 5 * 60 * 1000), (req, res) => {
  const { mobile, pin } = req.body;
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
    if (!row) {
      return res.status(401).json({ error: 'Mobile number not registered. Please do First Time Setup.' });
    }
    if (!bcrypt.compareSync(pin, row.password_hash)) {
      return res.status(401).json({ error: 'Incorrect PIN. Please try again.' });
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
app.get('/api/auth/sessions', requireAuth, (req, res) => {
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
app.post('/api/auth/add-staff', requireAuth, (req, res) => {
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
app.get('/api/license/status', requireAuth, (req, res) => {
  const t = db.prepare('SELECT status, suspend_reason, license_expiry, license_plan FROM tenants WHERE id = ?').get(req.user.tenantId);
  if (!t) return res.status(404).json({ error: 'Tenant not found' });
  if (t.license_plan !== 'lifetime' && t.license_expiry && Date.now() > new Date(t.license_expiry).getTime()) {
    return res.json({ status: 'expired', reason: '', licenseExpiry: t.license_expiry, licensePlan: t.license_plan });
  }
  res.json({ status: t.status || 'active', reason: t.suspend_reason || '', licenseExpiry: t.license_expiry, licensePlan: t.license_plan });
});

// ── POST /api/admin/tenant/status — pause / terminate / restore (remote) ─────
app.post('/api/admin/tenant/status', requireAdminKey, rateLimit(30, 60 * 1000), (req, res) => {
  const { shopName, status, reason = '' } = req.body;
  if (!shopName || !status) return res.status(400).json({ error: 'shopName and status required' });
  if (!['active', 'paused', 'terminated'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const t = db.prepare('SELECT id, shop_name FROM tenants WHERE LOWER(shop_name) = LOWER(?)').get(shopName);
  if (!t) return res.status(404).json({ error: 'Shop not found on this server' });
  db.prepare('UPDATE tenants SET status = ?, suspend_reason = ? WHERE id = ?').run(status, reason, t.id);
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

// ── GET /api/data ────────────────────────────────────────────────────────────
app.get('/api/data', requireAuth, requireActive, (req, res) => {
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
app.put('/api/data', requireAuth, requireActive, (req, res) => {
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
app.get('/api/data/users', requireAuth, (req, res) => {
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
app.listen(PORT, '0.0.0.0', () => {
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
  console.log('║  Current key (first 16 chars):                    ║');
  console.log(`║  ${ADMIN_KEY.slice(0,16)}...${' '.repeat(34)}║`);
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
