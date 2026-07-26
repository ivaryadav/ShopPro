'use strict';

const { getDb } = require('../database/connection');

/** @param {number|null} expiresInDays — computed via SQLite's own datetime('now', ?) arithmetic, never a JS Date, so it can never mismatch the format findValidByHash compares against. */
function create({ name, keyHash, keyPrefix, permissions, createdBy, expiresInDays }) {
  const result = getDb().prepare(`
    INSERT INTO platform_api_keys (name, key_hash, key_prefix, permissions, created_by, expires_at)
    VALUES (?,?,?,?,?, ${expiresInDays ? "datetime('now', ?)" : 'NULL'})
  `).run(...(expiresInDays
    ? [name, keyHash, keyPrefix, JSON.stringify(permissions || []), createdBy || null, `+${Number(expiresInDays)} days`]
    : [name, keyHash, keyPrefix, JSON.stringify(permissions || []), createdBy || null]));
  return findById(Number(result.lastInsertRowid));
}
function findById(id) { return getDb().prepare('SELECT * FROM platform_api_keys WHERE id = ?').get(id); }
function findByHash(keyHash) { return getDb().prepare('SELECT * FROM platform_api_keys WHERE key_hash = ?').get(keyHash); }
/** The only check requirePlatformAuthOrApiKey should trust — revoked/expired entirely evaluated in SQLite, never in JS. */
function findValidByHash(keyHash) {
  return getDb().prepare(`
    SELECT * FROM platform_api_keys
    WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(keyHash);
}
function listAll() {
  return getDb().prepare(`
    SELECT k.*, u.email AS created_by_email FROM platform_api_keys k
    LEFT JOIN platform_users u ON u.id = k.created_by ORDER BY k.created_at DESC
  `).all();
}
function touchUsage(id) {
  getDb().prepare("UPDATE platform_api_keys SET last_used_at = datetime('now'), usage_count = usage_count + 1 WHERE id = ?").run(id);
}
function rotate(id, newKeyHash, newKeyPrefix) {
  getDb().prepare("UPDATE platform_api_keys SET key_hash = ?, key_prefix = ?, updated_at = datetime('now') WHERE id = ?").run(newKeyHash, newKeyPrefix, id);
  return findById(id);
}
function revoke(id) {
  return getDb().prepare("UPDATE platform_api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id).changes > 0;
}

module.exports = { create, findById, findByHash, findValidByHash, listAll, touchUsage, rotate, revoke };
