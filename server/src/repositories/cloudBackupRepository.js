/**
 * server/src/repositories/cloudBackupRepository.js
 *
 * Persistence only (ADR-0005). Matches local.js's cloud_backups queries
 * exactly (local.js:1753-1784) — a single row per key_hash, upsert
 * semantics (a second backup for the same key_hash overwrites the first;
 * there is no history/versioning, matching local.js exactly).
 */
'use strict';

const { withConnection } = require('../database');

/**
 * Matches local.js:1759-1766's INSERT ... ON CONFLICT ... DO UPDATE exactly.
 * @param {{keyHash:string,shopName?:string,data:string}} params
 */
async function upsert({ keyHash, shopName, data }) {
  await withConnection((conn) =>
    conn.query(
      `INSERT INTO cloud_backups (key_hash, shop_name, data, backed_up_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE shop_name = VALUES(shop_name), data = VALUES(data), backed_up_at = VALUES(backed_up_at)`,
      [keyHash, shopName || '', data]
    )
  );
}

/** Matches local.js:1775 exactly. @param {string} keyHash @returns {Promise<object|null>} */
async function findByKeyHash(keyHash) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT key_hash, data, shop_name, backed_up_at FROM cloud_backups WHERE key_hash = ?', [keyHash]);
    return rows[0] || null;
  });
}

/** Matches local.js:1782 exactly (unconditional delete, no existence check). @param {string} keyHash */
async function remove(keyHash) {
  await withConnection((conn) => conn.query('DELETE FROM cloud_backups WHERE key_hash = ?', [keyHash]));
}

/**
 * No equivalent endpoint in local.js (which only ever looks up one
 * key_hash at a time) — kept repository-only, no public route, for admin
 * visibility/testing. See docs/architecture/Backup.md.
 * @returns {Promise<object[]>}
 */
async function listAll() {
  return withConnection((conn) =>
    conn.query('SELECT key_hash, shop_name, backed_up_at, LENGTH(data) AS data_size FROM cloud_backups ORDER BY backed_up_at DESC')
  );
}

module.exports = { upsert, findByKeyHash, remove, listAll };
