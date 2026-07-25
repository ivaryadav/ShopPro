/**
 * server/src/database/healthCheck.js
 *
 * Real connectivity check — mirrors server/local.js's `GET /health` (which
 * runs `SELECT 1` against SQLite) so the enterprise backend's health
 * endpoint (Phase 2+) has an equivalent, not a weaker, check from day one.
 */
'use strict';

const { getPool } = require('./connection');

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function checkDatabaseHealth(source) {
  const start = Date.now();
  let conn;
  try {
    const pool = getPool(source);
    conn = await pool.getConnection();
    await conn.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message };
  } finally {
    if (conn) await conn.release();
  }
}

module.exports = { checkDatabaseHealth };
