/**
 * server/src/config/logger.js
 *
 * Typed config for server/src/logging/ (the enterprise logger). Separate
 * from the logger implementation itself so config concerns (which level,
 * which directory) stay out of the logging module's own code.
 */
'use strict';

const { loadEnv } = require('./env');

/**
 * @typedef {Object} LoggerConfig
 * @property {'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL'} level
 * @property {string} logDir
 * @property {boolean} isProduction
 */

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {LoggerConfig}
 */
function getLoggerConfig(source) {
  const env = loadEnv(source);
  return Object.freeze({
    level: env.LOG_LEVEL,
    logDir: env.LOG_DIR,
    isProduction: env.NODE_ENV === 'production',
  });
}

module.exports = { getLoggerConfig };
