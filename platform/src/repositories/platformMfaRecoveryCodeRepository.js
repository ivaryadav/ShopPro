'use strict';

const { getDb } = require('../database/connection');

function replaceAllForUser(userId, codeHashes) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM platform_mfa_recovery_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO platform_mfa_recovery_codes (user_id, code_hash) VALUES (?,?)');
    for (const hash of codeHashes) insert.run(userId, hash);
  });
  tx();
}
function listUnusedForUser(userId) {
  return getDb().prepare('SELECT * FROM platform_mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL').all(userId);
}
function markUsed(id) {
  getDb().prepare("UPDATE platform_mfa_recovery_codes SET used_at = datetime('now') WHERE id = ?").run(id);
}
function deleteAllForUser(userId) {
  getDb().prepare('DELETE FROM platform_mfa_recovery_codes WHERE user_id = ?').run(userId);
}

module.exports = { replaceAllForUser, listUnusedForUser, markUsed, deleteAllForUser };
