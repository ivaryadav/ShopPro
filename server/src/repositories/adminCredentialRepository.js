/**
 * server/src/repositories/adminCredentialRepository.js
 *
 * Persistence only (ADR-0005). Matches local.js's admin_credentials
 * table and its seed/read/update queries exactly (local.js:298-303,
 * 316-321, 1201-1220).
 */
'use strict';

const { withConnection } = require('../database');

/** @returns {Promise<object|null>} the single admin_credentials row (id=1), or null if never seeded */
async function get() {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT * FROM admin_credentials WHERE id = 1');
    return rows[0] || null;
  });
}

/**
 * Matches local.js:321's boot-time seed exactly — idempotent, only ever
 * inserts if the row doesn't already exist (never overwrites a real,
 * already-set admin password with the env-var default on a later boot).
 * @param {string} passwordHash
 */
async function ensureSeeded(passwordHash) {
  await withConnection((conn) =>
    conn.query(`INSERT IGNORE INTO admin_credentials (id, password_hash, algo) VALUES (1, ?, 'sha256')`, [passwordHash])
  );
}

/**
 * Matches local.js:1217's automatic sha256->bcrypt migration-on-login exactly.
 * @param {string} passwordHash @param {string} algo
 */
async function updateHash(passwordHash, algo) {
  await withConnection((conn) =>
    conn.query(`UPDATE admin_credentials SET password_hash = ?, algo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [passwordHash, algo])
  );
}

module.exports = { get, ensureSeeded, updateHash };
