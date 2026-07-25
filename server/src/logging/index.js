/**
 * server/src/logging/index.js
 *
 * Public entry point for logging. `getLogger()` returns a lazily-created
 * singleton wired to console + file transports per config/logger.js —
 * this is what Phase 2+ code should import, not Logger.js directly
 * (which is exported too, for tests that want to construct an isolated
 * instance with mock transports).
 */
'use strict';

const { Logger } = require('./Logger');
const { createFileTransport } = require('./transports/fileTransport');
const consoleTransport = require('./transports/consoleTransport');
const { getLoggerConfig } = require('../config/logger');

/** @type {Logger|null} */
let _singleton = null;

/**
 * @param {NodeJS.ProcessEnv} [source] - Injectable for tests; ignored once the singleton exists.
 * @returns {Logger}
 */
function getLogger(source) {
  if (!_singleton) {
    const config = getLoggerConfig(source);
    _singleton = new Logger({
      level: config.level,
      transports: [consoleTransport, createFileTransport(config.logDir)],
    });
  }
  return _singleton;
}

/** Test-only: discards the singleton so the next getLogger() call re-reads config. */
function _resetForTests() {
  _singleton = null;
}

module.exports = { getLogger, Logger, _resetForTests };
