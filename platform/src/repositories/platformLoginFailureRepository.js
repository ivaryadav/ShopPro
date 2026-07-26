'use strict';

const { getDb } = require('../database/connection');

function record(userId, email, ip) {
  getDb().prepare('INSERT INTO platform_login_failures (user_id, email, ip) VALUES (?,?,?)').run(userId || null, email, ip || '');
}
function countRecent(email, windowMinutes) {
  return getDb().prepare(
    "SELECT COUNT(*) AS c FROM platform_login_failures WHERE email = ? AND created_at >= datetime('now', ?)"
  ).get(email, `-${windowMinutes} minutes`).c;
}
function listForUser(userId) {
  return getDb().prepare('SELECT * FROM platform_login_failures WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId);
}

module.exports = { record, countRecent, listForUser };
