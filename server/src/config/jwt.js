/**
 * server/src/config/jwt.js
 *
 * Typed JWT config. Mirrors server/local.js's existing posture (JWT_SECRET
 * has no safe default — an unset secret must fail loudly, never silently
 * fall back) but expressed as validated, typed config rather than a
 * top-of-file `if (!process.env.JWT_SECRET) process.exit(1)` block.
 */
'use strict';

const { loadEnv } = require('./env');

/**
 * @typedef {Object} JwtConfig
 * @property {string} secret
 * @property {string} accessTokenTtl
 * @property {number} refreshTokenTtlDays
 */

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {JwtConfig}
 * @throws {Error} If JWT_SECRET is unset — matches server/local.js's existing
 *   fail-fast posture, since an unset secret silently invalidates every
 *   session on the next restart (a correctness bug, not a soft default).
 */
function getJwtConfig(source) {
  const env = loadEnv(source);
  if (!env.JWT_SECRET) {
    throw new Error(
      '[Config] JWT_SECRET is not set. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n" +
      'and set it in your environment before starting the server.'
    );
  }
  return Object.freeze({
    secret: env.JWT_SECRET,
    accessTokenTtl: env.JWT_ACCESS_TTL,
    refreshTokenTtlDays: env.JWT_REFRESH_TTL_DAYS,
  });
}

module.exports = { getJwtConfig };
