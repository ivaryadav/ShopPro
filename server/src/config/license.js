/**
 * server/src/config/license.js
 *
 * Typed config for the licensing subsystem's operational parameters
 * (Phase 4). Deliberately holds only *operational* knobs (sweep timing,
 * offline grace period) — the actual plan definitions (TRIAL/BASIC/PREMIUM,
 * device limits, pricing) are business data belonging in the database
 * (subscription_plans), not environment config, matching how
 * server/local.js already treats them.
 */
'use strict';

const { loadEnv } = require('./env');

/**
 * @typedef {Object} LicenseConfig
 * @property {number} sweepIntervalMs
 * @property {number} offlineGraceDays
 */

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {LicenseConfig}
 */
function getLicenseConfig(source) {
  const env = loadEnv(source);
  return Object.freeze({
    sweepIntervalMs: env.LICENSE_SWEEP_INTERVAL_MS,
    offlineGraceDays: env.LICENSE_OFFLINE_GRACE_DAYS,
  });
}

module.exports = { getLicenseConfig };
