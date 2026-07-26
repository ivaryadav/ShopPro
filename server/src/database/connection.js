/**
 * server/src/database/connection.js
 *
 * MariaDB connection pool manager. One pool per process, created lazily
 * and reused — mirrors server/local.js's existing "one `db` handle for the
 * process lifetime" pattern, adapted for a pooled client/server database
 * instead of an in-process SQLite file.
 *
 * NOT wired into server/local.js or server/index.js. Nothing outside
 * server/src/ imports this yet; it has no effect on the currently-running
 * application (ADR-0002).
 */
'use strict';

const mariadb = require('mariadb');
const { getDatabaseConfig } = require('../config/database');
const { DatabaseError } = require('../errors/DatabaseError');

/** @type {import('mariadb').Pool|null} */
let _pool = null;

/**
 * @param {NodeJS.ProcessEnv} [source] - Injectable for tests; ignored once the pool exists.
 * @returns {import('mariadb').Pool}
 */
function getPool(source) {
  if (!_pool) {
    const config = getDatabaseConfig(source);
    _pool = mariadb.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionLimit: config.connectionLimit,
      minimumIdle: config.minimumIdle,
      bigIntAsNumber: true,
      // RC1 Validation fix: the driver's own defaults (10s connect timeout,
      // NO socket timeout at all — 0, meaning "wait forever") meant a real
      // database outage made every in-flight request on an already-pooled
      // connection hang indefinitely (found via a live "kill the database
      // mid-request" test: 10+ seconds even with connectTimeout alone,
      // since that setting only governs establishing brand-new connections,
      // not detecting an existing one going dead). Both are set from the
      // same config value — 5s is generous for a healthy connection but
      // fails fast enough that a real outage doesn't look like a frozen app.
      connectTimeout: config.connectTimeoutMs,
      socketTimeout: config.connectTimeoutMs,
    });
  }
  return _pool;
}

/**
 * Acquires a connection, runs `fn(conn)`, and always releases the
 * connection afterward — the standard "don't leak pool connections"
 * pattern every repository should use rather than calling
 * getPool().getConnection() directly.
 * @template T
 * @param {(conn: import('mariadb').Connection) => Promise<T>} fn
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Promise<T>}
 */
async function withConnection(fn, source) {
  const pool = getPool(source);
  let conn;
  try {
    conn = await pool.getConnection();
    return await fn(conn);
  } catch (e) {
    if (e instanceof DatabaseError) throw e;
    throw new DatabaseError(`Database operation failed: ${e.message}`, e);
  } finally {
    if (conn) await conn.release();
  }
}

/** Closes the pool — for graceful shutdown and test teardown. */
async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Test-only: discards the pool so the next getPool() call re-reads config. */
function _resetForTests() {
  _pool = null;
}

module.exports = { getPool, withConnection, closePool, _resetForTests };
