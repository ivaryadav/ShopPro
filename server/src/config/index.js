/**
 * server/src/config/index.js
 *
 * Single entry point for every config concern in server/src/. Import this,
 * not the individual files, unless you specifically need one config's
 * loader in isolation (e.g. a test that only cares about jwt.js).
 *
 * Fails fast: calling getConfig() validates the entire environment
 * up front and throws one aggregated error (env.js) if anything is
 * missing or malformed, rather than failing lazily deep inside a request.
 *
 * `mail` is loaded with `{ optional: true }` here specifically so a
 * caller that doesn't need mail (most of Phase 1) isn't forced to have
 * SMTP configured — a real send path should call getMailConfig() itself
 * without that flag, or check `config.mail.host` before using it.
 */
'use strict';

const { loadEnv } = require('./env');
const { getDatabaseConfig } = require('./database');
const { getJwtConfig } = require('./jwt');
const { getMailConfig } = require('./mail');
const { getLoggerConfig } = require('./logger');
const { getLicenseConfig } = require('./license');
const { getStorageConfig } = require('./storage');

/**
 * @param {NodeJS.ProcessEnv} [source] - Defaults to process.env; injectable for tests.
 * @param {{ requireJwt?: boolean }} [opts] - Pass requireJwt:false to load
 *   without a configured JWT_SECRET (e.g. tooling that never issues tokens).
 * @returns {{
 *   env: ReturnType<typeof loadEnv>,
 *   database: ReturnType<typeof getDatabaseConfig>,
 *   jwt: ReturnType<typeof getJwtConfig> | null,
 *   mail: ReturnType<typeof getMailConfig>,
 *   logger: ReturnType<typeof getLoggerConfig>,
 *   license: ReturnType<typeof getLicenseConfig>,
 *   storage: ReturnType<typeof getStorageConfig>,
 * }}
 */
function getConfig(source, opts = {}) {
  const requireJwt = opts.requireJwt !== false;
  return Object.freeze({
    env: loadEnv(source),
    database: getDatabaseConfig(source),
    jwt: requireJwt ? getJwtConfig(source) : null,
    mail: getMailConfig(source, { optional: true }),
    logger: getLoggerConfig(source),
    license: getLicenseConfig(source),
    storage: getStorageConfig(source),
  });
}

module.exports = {
  getConfig,
  getDatabaseConfig,
  getJwtConfig,
  getMailConfig,
  getLoggerConfig,
  getLicenseConfig,
  getStorageConfig,
};
