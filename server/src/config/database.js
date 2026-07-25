/**
 * server/src/config/database.js
 *
 * Typed MariaDB connection config, derived from the validated environment
 * (see env.js). Consumed by server/src/database/connection.js — nothing
 * else in this tree should read DB_* environment variables directly.
 */
'use strict';

const { loadEnv } = require('./env');

/**
 * @typedef {Object} DatabaseConfig
 * @property {string} host
 * @property {number} port
 * @property {string} database
 * @property {string} user
 * @property {string} password
 * @property {number} connectionLimit
 * @property {number} minimumIdle
 */

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {DatabaseConfig}
 */
function getDatabaseConfig(source) {
  const env = loadEnv(source);
  return Object.freeze({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectionLimit: env.DB_POOL_MAX,
    minimumIdle: env.DB_POOL_MIN,
  });
}

module.exports = { getDatabaseConfig };
