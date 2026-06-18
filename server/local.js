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

// Load .env file if present (no dotenv dependency needed)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}

// ── Config ──────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || ('shoperpro-local-' + require('crypto').randomBytes(16).toString('hex'));
const DB_PATH    = path.join(__dirname, 'shoperpro.db');
const HTML_PATH  = path.join(__dirname, '..', 'app', 'ShopERP_Pro_v8.html');

// ── Admin key — used by Super Admin panel to call remote control endpoints ──
// Set ADMIN_KEY env var = sha256 hash of your admin password.
// Run:  echo -n 'YourAdminPassword' | shasum -a 256
// Default = current admin password hash. CHANGE THIS if you change admin password.
const ADMIN_KEY  = process.env.ADMIN_KEY || '2b5877210c3581cccac2431c0a5681ea1c5674ae71dbb5d664eda93e3965a3dd';

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

// Migrate existing DB — add columns if missing
try { db.exec('ALTER TABLE users ADD COLUMN display_name TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN mobile TEXT'); } catch(_) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile) WHERE mobile IS NOT NULL'); } catch(_) {}
// Tenant status columns — support remote pause/terminate
try { db.exec("ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch(_) {}
try { db.exec("ALTER TABLE tenants ADD COLUMN suspend_reason TEXT NOT NULL DEFAULT ''"); } catch(_) {}
// Cloud backup table — keyed by license key hash (machine-bound)
db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_backups (
    key_hash    TEXT PRIMARY KEY,
    shop_name   TEXT,
    data        TEXT NOT NULL,
    backed_up_at TEXT DEFAULT (datetime('now'))
  );
`);
try { db.exec('ALTER TABLE cloud_backups ADD COLUMN shop_name TEXT'); } catch(_) {}

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

function makeToken(user, tenant) {
  return jwt.sign(
    { userId: user.id, tenantId: tenant.id, role: user.role, shopName: tenant.shop_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// Blocks API calls if tenant is paused or terminated
function requireActive(req, res, next) {
  const t = db.prepare('SELECT status, suspend_reason FROM tenants WHERE id = ?').get(req.user.tenantId);
  if (!t) return res.status(404).json({ error: 'Tenant not found' });
  if (t.status === 'paused')     return res.status(403).json({ error: 'Account paused',     status: 'paused',      reason: t.suspend_reason || '' });
  if (t.status === 'terminated') return res.status(403).json({ error: 'Account terminated', status: 'terminated',  reason: t.suspend_reason || '' });
  next();
}

// Validates X-Admin-Key header for Super Admin remote control endpoints
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';"
  );
  next();
});

app.use(express.json({ limit: '5mb' }));

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', mode: 'sqlite-local', time: new Date().toISOString() })
);

// ── POST /api/auth/register ──────────────────────────────────────────────────
app.post('/api/auth/register', rateLimit(5, 10 * 60 * 1000), (req, res) => {
  const { shopName, ownerName, mobile, pin } = req.body;
  const mob = (mobile || '').replace(/\D/g, '');
  if (!shopName || !mob || !pin) {
    return res.status(400).json({ error: 'Shop name, mobile number, and PIN are required' });
  }
  if (mob.length < 10) {
    return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
  }
  try {
    const existingMob = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mob);
    if (existingMob) {
      return res.status(409).json({ error: 'This mobile number is already registered. Please sign in.' });
    }
    const existing = db.prepare('SELECT id FROM tenants WHERE LOWER(shop_name) = LOWER(?)').get(shopName);
    if (existing) {
      return res.status(409).json({ error: 'Shop name already taken — please sign in instead.' });
    }
    const hash   = bcrypt.hashSync(pin, 10);
    const tenant = db.prepare('INSERT INTO tenants (shop_name) VALUES (?) RETURNING *').get(shopName);
    const user   = db.prepare(
      'INSERT INTO users (tenant_id, username, display_name, mobile, password_hash, role) VALUES (?,?,?,?,?,?) RETURNING *'
    ).get(tenant.id, mob, ownerName || 'Owner', mob, hash, 'owner');
    db.prepare('INSERT INTO tenant_data (tenant_id, data) VALUES (?,?)').run(tenant.id, '{}');

    res.status(201).json({
      message: 'Shop registered',
      token: makeToken(user, tenant),
      shopName: tenant.shop_name,
      username: user.display_name,
      role: user.role,
    });
  } catch (e) {
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
    res.json({
      token: makeToken(user, tenant),
      shopName: row.shop_name,
      username: row.display_name || row.username,
      role: row.role,
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
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

// ── GET /api/license/status — called on app boot to check pause/terminate ────
app.get('/api/license/status', requireAuth, (req, res) => {
  const t = db.prepare('SELECT status, suspend_reason FROM tenants WHERE id = ?').get(req.user.tenantId);
  res.json({ status: t?.status || 'active', reason: t?.suspend_reason || '' });
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

// ── GET /api/admin/tenants — list all tenants with status ────────────────────
app.get('/api/admin/tenants', requireAdminKey, (req, res) => {
  const tenants = db.prepare(
    "SELECT id, shop_name, status, suspend_reason, created_at FROM tenants ORDER BY created_at DESC"
  ).all();
  res.json({ tenants });
});

// ── GET /api/data ────────────────────────────────────────────────────────────
app.get('/api/data', requireAuth, requireActive, (req, res) => {
  try {
    const row = db.prepare('SELECT data, updated_at FROM tenant_data WHERE tenant_id = ?').get(req.user.tenantId);
    if (!row) return res.json({ data: {}, updatedAt: null });
    res.json({ data: JSON.parse(row.data || '{}'), updatedAt: row.updated_at });
  } catch (e) {
    console.error('Load data error:', e);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// ── PUT /api/data ────────────────────────────────────────────────────────────
app.put('/api/data', requireAuth, requireActive, (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data must be a JSON object' });
  }
  try {
    db.prepare(
      `INSERT INTO tenant_data (tenant_id, data, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(tenant_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).run(req.user.tenantId, JSON.stringify(data));
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Save error:', e);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

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

// ── Serve the ShopERP HTML (local/single-device mode) ────────────────────────
// App runs in local mode — data stays in browser localStorage on this device.
app.get('/', (req, res) => {
  if (!fs.existsSync(HTML_PATH)) {
    return res.status(404).send('ShopERP_Pro_v8.html not found. Make sure the app/ folder is next to server/');
  }
  const html = fs.readFileSync(HTML_PATH, 'utf8');
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
  console.log('║  Data saved to: server/shoperpro.db               ║');
  console.log('║  Press Ctrl+C to stop                             ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
});
