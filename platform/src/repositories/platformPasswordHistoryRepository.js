'use strict';

const { getDb } = require('../database/connection');

function record(userId, passwordHash) {
  getDb().prepare('INSERT INTO platform_password_history (user_id, password_hash) VALUES (?,?)').run(userId, passwordHash);
}
function recentForUser(userId, limit) {
  return getDb().prepare('SELECT password_hash FROM platform_password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}

module.exports = { record, recentForUser };
