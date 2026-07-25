/**
 * server/src/config/storage.js
 *
 * Typed config for filesystem storage paths (backups today; a future
 * phase may add object storage for uploaded assets — this module is the
 * single place that decision would be configured from).
 */
'use strict';

const { loadEnv } = require('./env');

/**
 * @typedef {Object} StorageConfig
 * @property {string} backupDir
 */

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {StorageConfig}
 */
function getStorageConfig(source) {
  const env = loadEnv(source);
  return Object.freeze({
    backupDir: env.BACKUP_DIR,
  });
}

module.exports = { getStorageConfig };
