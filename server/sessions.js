/**
 * ShopERP Pro — Session Management (Wave 1)
 * ──────────────────────────────────────────
 * See docs/architecture-review/SessionArchitecture.md for the design this
 * implements. Kept in its own module so server/local.js's diff for this wave
 * stays small and reviewable, matching this project's existing split
 * (server/license.js) for the same reason.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days of no activity -> expired
const CLEANUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // hard-delete revoked/expired rows older than this
// Grace window for refresh-token reuse — see refreshSession() below. Found
// during post-implementation review: two tabs of the SAME browser share
// localStorage, so both can race to refresh with the same soon-to-be-stale
// token; without this, the loser gets a spurious full logout roughly every
// 15 minutes for any shop that keeps two tabs open. 20s comfortably covers
// that race while remaining far too tight a window for genuine token theft
// (a stolen token used within 20s of the legitimate owner's own refresh) to
// realistically slip through as a false negative.
const REFRESH_GRACE_MS = 20 * 1000;

// BENIGN_MIGRATION_ERROR / runMigration: same classification used by
// server/local.js's migration runner (see the comment there for why) —
// duplicated rather than imported to keep this module's existing
// zero-internal-dependency shape (see the file-level comment above).
// `failures` is an array the caller owns (server/local.js passes its own
// migrationState.failures so both modules' results land in one list for
// GET /health); defaults to a throwaway array so `migrate(db)` alone still
// works for any other caller, unchanged.
const BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i;
function runMigration(db, sql, label, failures) {
  try {
    db.exec(sql);
  } catch (e) {
    if (BENIGN_MIGRATION_ERROR.test(e.message)) return;
    console.error(`[MIGRATION FAILED] ${label}: ${e.message}`);
    failures.push({ label, error: e.message, at: new Date().toISOString() });
  }
}

function migrate(db, failures) {
  if (!failures) failures = [];
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id             TEXT UNIQUE NOT NULL,
      tenant_id              INTEGER NOT NULL,
      user_id                INTEGER NOT NULL,
      jwt_id                 TEXT,
      device_id              TEXT,
      login_time             TEXT DEFAULT (datetime('now')),
      last_activity          TEXT DEFAULT (datetime('now')),
      current_page           TEXT,
      status                  TEXT NOT NULL DEFAULT 'active',
      refresh_token_hash     TEXT,
      prev_refresh_token_hash TEXT,
      refresh_rotated_at     TEXT,
      ip_address             TEXT,
      browser                TEXT,
      os                     TEXT,
      created_at             TEXT DEFAULT (datetime('now'))
    );
  `);
  runMigration(db, 'ALTER TABLE user_sessions ADD COLUMN prev_refresh_token_hash TEXT', 'user_sessions.prev_refresh_token_hash', failures);
  runMigration(db, 'ALTER TABLE user_sessions ADD COLUMN refresh_rotated_at TEXT', 'user_sessions.refresh_rotated_at', failures);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON user_sessions(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(tenant_id, user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON user_sessions(refresh_token_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_prev_refresh ON user_sessions(prev_refresh_token_hash)');
  // device_id has no FK/uniqueness yet — Wave 2 (Trusted Devices) will extend this
  // column's usage; left nullable and unindexed-beyond-above until that lands.
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function newSessionId() { return crypto.randomBytes(24).toString('hex'); }
function newRefreshToken() { return crypto.randomBytes(32).toString('hex'); }
function newJwtId() { return crypto.randomBytes(12).toString('hex'); }

// Minimal, dependency-free UA parse — informational only, never a security
// decision (matches the project's existing no-new-npm-dependency posture for
// small utilities, e.g. the in-memory rate limiter).
function parseUA(uaString) {
  const ua = uaString || '';
  let browser = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  let os = 'Unknown';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}

function signAccessToken(secret, { userId, tenantId, role, shopName, sessionId, jwtId }) {
  return jwt.sign(
    { userId, tenantId, role, shopName, sid: sessionId, jti: jwtId },
    secret,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

/**
 * Creates a brand-new session row + token pair at login/register.
 * Returns { accessToken, refreshToken, sessionId } — callers merge accessToken
 * into the existing `token` field of their JSON response for backward
 * compatibility with every client call site that already reads res.token.
 */
function createSession(db, secret, { user, tenant, req }) {
  const sessionId = newSessionId();
  const jwtId = newJwtId();
  const refreshToken = newRefreshToken();
  const ua = parseUA(req.headers['user-agent']);
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;

  db.prepare(
    `INSERT INTO user_sessions
     (session_id, tenant_id, user_id, jwt_id, login_time, last_activity, status, refresh_token_hash, ip_address, browser, os)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 'active', ?, ?, ?, ?)`
  ).run(sessionId, tenant.id, user.id, jwtId, sha256(refreshToken), ip, ua.browser, ua.os);

  const accessToken = signAccessToken(secret, {
    userId: user.id, tenantId: tenant.id, role: user.role, shopName: tenant.shop_name, sessionId, jwtId,
  });
  return { accessToken, refreshToken, sessionId };
}

/**
 * requireAuth calls this after verifying the JWT signature. Two shapes:
 *  - New tokens carry `sid` — must resolve to an 'active' session row, and
 *    last_activity is touched on every authenticated request (cheap indexed
 *    UPDATE; this is what makes "last activity" meaningful without a
 *    separate heartbeat call on every page).
 *  - Legacy tokens (issued before Wave 1, no `sid`) have no session to check
 *    — accepted as-is until they naturally expire on their original 7-day
 *    lifetime. See docs/architecture-review/MigrationPlan.md.
 */
function checkSession(db, payload) {
  if (!payload.sid) return { ok: true, legacy: true };
  const row = db.prepare('SELECT status FROM user_sessions WHERE session_id = ?').get(payload.sid);
  if (!row || row.status !== 'active') return { ok: false };
  db.prepare("UPDATE user_sessions SET last_activity = datetime('now') WHERE session_id = ?").run(payload.sid);
  return { ok: true, legacy: false };
}

/**
 * POST /api/auth/refresh — rotates both tokens on every use (refresh-token
 * rotation: the presented token is invalidated the moment it's used, so a
 * stolen-but-unused refresh token becomes worthless the next time the real
 * owner refreshes, and reuse of an already-rotated token is a strong signal
 * of theft — surfaced by revoking the session outright rather than issuing
 * yet another token pair).
 */
function refreshSession(db, secret, refreshToken) {
  const hash = sha256(refreshToken);
  let row = db.prepare('SELECT * FROM user_sessions WHERE refresh_token_hash = ?').get(hash);
  let graceHit = false;
  if (!row) {
    // Not the current token — might be one that a concurrent request from
    // another tab of the same device (they share localStorage) *just*
    // rotated away. Accept it if we're still inside the short grace window;
    // see REFRESH_GRACE_MS above for why this doesn't meaningfully weaken
    // theft detection.
    const graceCutoff = new Date(Date.now() - REFRESH_GRACE_MS).toISOString().replace('T', ' ').slice(0, 19);
    row = db.prepare(
      `SELECT * FROM user_sessions WHERE prev_refresh_token_hash = ? AND refresh_rotated_at > ? AND status = 'active'`
    ).get(hash, graceCutoff);
    graceHit = !!row;
  }
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.status !== 'active') return { ok: false, reason: 'revoked' };

  // Resolve and validate before mutating anything — a failed lookup here
  // must never burn the token with no replacement issued.
  const tenant = db.prepare('SELECT shop_name FROM tenants WHERE id = ?').get(row.tenant_id);
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(row.user_id);
  if (!tenant || !user) return { ok: false, reason: 'invalid' };

  const newJti = newJwtId();
  if (graceHit) {
    // Don't rotate again — this tab is racing a sibling tab that already
    // won. Just mint a fresh access token; the refresh token to use going
    // forward is whatever the winning tab already wrote to the shared
    // localStorage (we never persisted the plaintext, so we couldn't hand
    // it back even if we wanted to — the client's setRefreshToken(null) is
    // a deliberate no-op for exactly this response).
    db.prepare("UPDATE user_sessions SET jwt_id = ?, last_activity = datetime('now') WHERE session_id = ?").run(newJti, row.session_id);
    const accessToken = signAccessToken(secret, {
      userId: row.user_id, tenantId: row.tenant_id, role: user.role, shopName: tenant.shop_name,
      sessionId: row.session_id, jwtId: newJti,
    });
    return { ok: true, accessToken, refreshToken: null, sessionId: row.session_id };
  }

  const newRefresh = newRefreshToken();
  db.prepare(
    `UPDATE user_sessions
     SET prev_refresh_token_hash = refresh_token_hash, refresh_rotated_at = datetime('now'),
         refresh_token_hash = ?, jwt_id = ?, last_activity = datetime('now')
     WHERE session_id = ?`
  ).run(sha256(newRefresh), newJti, row.session_id);

  const accessToken = signAccessToken(secret, {
    userId: row.user_id, tenantId: row.tenant_id, role: user.role, shopName: tenant.shop_name,
    sessionId: row.session_id, jwtId: newJti,
  });
  return { ok: true, accessToken, refreshToken: newRefresh, sessionId: row.session_id };
}

function revokeSession(db, sessionId) {
  return db.prepare("UPDATE user_sessions SET status = 'revoked' WHERE session_id = ?").run(sessionId).changes > 0;
}

function revokeAllUserSessions(db, tenantId, userId, exceptSessionId) {
  return db.prepare(
    "UPDATE user_sessions SET status = 'revoked' WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND session_id != ?"
  ).run(tenantId, userId, exceptSessionId || '').changes;
}

function touchHeartbeat(db, sessionId, currentPage) {
  db.prepare(
    "UPDATE user_sessions SET last_activity = datetime('now'), current_page = ? WHERE session_id = ? AND status = 'active'"
  ).run(currentPage || null, sessionId);
}

function listActiveSessions(db, tenantId) {
  return db.prepare(
    `SELECT s.session_id, s.user_id, u.display_name, u.mobile, s.login_time, s.last_activity,
            s.current_page, s.ip_address, s.browser, s.os
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.tenant_id = ? AND s.status = 'active' ORDER BY s.last_activity DESC`
  ).all(tenantId);
}

// Periodic housekeeping — mirrors the pattern already used for the in-memory
// rate-limit bucket cleanup in server/local.js. Idle sessions (no activity
// for SESSION_IDLE_EXPIRY_MS) are marked expired; long-dead revoked/expired
// rows are hard-deleted so the table doesn't grow unbounded.
function runCleanup(db) {
  const idleCutoff = new Date(Date.now() - SESSION_IDLE_EXPIRY_MS).toISOString().replace('T', ' ').slice(0, 19);
  const deleteCutoff = new Date(Date.now() - CLEANUP_RETENTION_MS).toISOString().replace('T', ' ').slice(0, 19);
  const expired = db.prepare(
    "UPDATE user_sessions SET status = 'expired' WHERE status = 'active' AND last_activity < ?"
  ).run(idleCutoff);
  const deleted = db.prepare(
    "DELETE FROM user_sessions WHERE status IN ('revoked','expired') AND last_activity < ?"
  ).run(deleteCutoff);
  return { expired: expired.changes, deleted: deleted.changes };
}

module.exports = {
  migrate, createSession, checkSession, refreshSession, revokeSession,
  revokeAllUserSessions, touchHeartbeat, listActiveSessions, runCleanup,
  REFRESH_TOKEN_TTL_MS,
};
