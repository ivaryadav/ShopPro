/**
 * server/src/config/admin.js
 *
 * Typed config for the Administration domain (Sprint 2). Just the one
 * seed value — matches local.js's own scope for this env var exactly
 * (everything else Administration needs is real business data in
 * admin_credentials, not environment config).
 */
'use strict';

const { loadEnv } = require('./env');

/**
 * @typedef {Object} AdminConfig
 * @property {string} adminKeySeed
 */

/** @param {NodeJS.ProcessEnv} [source] @returns {AdminConfig} */
function getAdminConfig(source) {
  const env = loadEnv(source);
  return Object.freeze({ adminKeySeed: env.ADMIN_KEY });
}

module.exports = { getAdminConfig };
