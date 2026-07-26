'use strict';

const { getDb } = require('../database/connection');

function create({ sessionId, userId, jwtId, ip, browser, os }) {
  getDb().prepare(
    'INSERT INTO platform_sessions (session_id, user_id, jwt_id, ip_address, browser, os) VALUES (?,?,?,?,?,?)'
  ).run(sessionId, userId, jwtId, ip || '', browser || '', os || '');
}
function findBySessionId(sessionId) {
  return getDb().prepare('SELECT * FROM platform_sessions WHERE session_id = ?').get(sessionId);
}
function touch(sessionId) {
  getDb().prepare("UPDATE platform_sessions SET last_activity = datetime('now') WHERE session_id = ?").run(sessionId);
}
function revoke(sessionId) {
  return getDb().prepare("UPDATE platform_sessions SET status = 'revoked' WHERE session_id = ?").run(sessionId).changes > 0;
}
function revokeAllForUser(userId) {
  return getDb().prepare("UPDATE platform_sessions SET status = 'revoked' WHERE user_id = ? AND status = 'active'").run(userId).changes;
}
function listForUser(userId) {
  return getDb().prepare('SELECT * FROM platform_sessions WHERE user_id = ? ORDER BY login_time DESC LIMIT 100').all(userId);
}
/** Phase 5B: admin-wide session visibility, across every platform user. */
function listAllActive() {
  return getDb().prepare(`
    SELECT s.*, u.email AS user_email FROM platform_sessions s
    JOIN platform_users u ON u.id = s.user_id
    WHERE s.status = 'active' ORDER BY s.last_activity DESC LIMIT 200
  `).all();
}
function revokeAllActive() {
  return getDb().prepare("UPDATE platform_sessions SET status = 'revoked' WHERE status = 'active'").run().changes;
}
/**
 * Idle/absolute session-timeout check, done entirely in SQLite's own
 * datetime() arithmetic — never parsed into a JS Date, which would
 * silently misbehave depending on the server's local timezone (the same
 * class of bug this engagement already found and fixed once in ShopERP's
 * own login-lockout logic).
 */
function checkExpiry(sessionId, idleMinutes, absoluteHours) {
  return getDb().prepare(`
    SELECT
      (last_activity < datetime('now', ?)) AS idle_expired,
      (login_time < datetime('now', ?)) AS absolute_expired
    FROM platform_sessions WHERE session_id = ?
  `).get(`-${idleMinutes} minutes`, `-${absoluteHours} hours`, sessionId);
}

module.exports = { create, findBySessionId, touch, revoke, revokeAllForUser, listForUser, listAllActive, revokeAllActive, checkExpiry };
