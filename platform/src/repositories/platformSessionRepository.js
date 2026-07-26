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

module.exports = { create, findBySessionId, touch, revoke, revokeAllForUser, listForUser };
