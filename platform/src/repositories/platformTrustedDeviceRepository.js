'use strict';

const { getDb } = require('../database/connection');

function create({ userId, tokenHash, deviceName, browser, os, ip, expiresAt }) {
  const result = getDb().prepare(`
    INSERT INTO platform_trusted_devices (user_id, token_hash, device_name, browser, os, ip, expires_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(userId, tokenHash, deviceName || '', browser || '', os || '', ip || '', expiresAt);
  return getDb().prepare('SELECT * FROM platform_trusted_devices WHERE id = ?').get(Number(result.lastInsertRowid));
}
function findValidByTokenHash(tokenHash, userId) {
  return getDb().prepare(`
    SELECT * FROM platform_trusted_devices
    WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
  `).get(tokenHash, userId);
}
function touch(id) {
  getDb().prepare("UPDATE platform_trusted_devices SET last_used_at = datetime('now') WHERE id = ?").run(id);
}
function listForUser(userId) {
  return getDb().prepare('SELECT * FROM platform_trusted_devices WHERE user_id = ? ORDER BY last_used_at DESC').all(userId);
}
function listAll() {
  return getDb().prepare(`
    SELECT d.*, u.email AS user_email FROM platform_trusted_devices d
    JOIN platform_users u ON u.id = d.user_id ORDER BY d.last_used_at DESC LIMIT 200
  `).all();
}
function revoke(id) {
  return getDb().prepare("UPDATE platform_trusted_devices SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id).changes > 0;
}
function revokeAllForUser(userId) {
  return getDb().prepare("UPDATE platform_trusted_devices SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(userId).changes;
}
function countActive() {
  return getDb().prepare("SELECT COUNT(*) c FROM platform_trusted_devices WHERE revoked_at IS NULL AND expires_at > datetime('now')").get().c;
}

module.exports = { create, findValidByTokenHash, touch, listForUser, listAll, revoke, revokeAllForUser, countActive };
