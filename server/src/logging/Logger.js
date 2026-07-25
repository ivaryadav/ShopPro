/**
 * server/src/logging/Logger.js
 *
 * Enterprise logging abstraction for server/src/. Supports DEBUG, INFO,
 * WARN, ERROR, FATAL, each dispatched to every configured transport
 * (console, file, and — once implemented — cloud). Every entry is
 * structured (timestamp, level, message, optional meta), never a bare
 * string — matching and extending this project's existing
 * server/logger.js convention.
 *
 * "No console.log outside the logger" (Phase 1 requirement) means: once a
 * later phase wires this into server/src/ code, no file under
 * server/src/ should call console.log/console.error directly — it calls
 * logger.debug/info/warn/error/fatal instead, and this class is the only
 * place that touches console.log/console.error (via consoleTransport.js).
 */
'use strict';

const { isValidLevel, meetsThreshold } = require('./levels');

class Logger {
  /**
   * @param {{
   *   level: 'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL',
   *   transports: Array<{ write: (entry: object) => void }>,
   *   context?: object,
   * }} options
   */
  constructor({ level, transports, context = {} }) {
    if (!isValidLevel(level)) {
      throw new Error(`[Logging] Invalid log level '${level}'`);
    }
    if (!Array.isArray(transports) || transports.length === 0) {
      throw new Error('[Logging] Logger requires at least one transport');
    }
    this._level = level;
    this._transports = transports;
    this._context = context;
  }

  /**
   * Returns a new Logger sharing this one's level/transports but with
   * additional context merged into every entry it emits — e.g.
   * `logger.child({ tenantId })` for a request-scoped logger.
   * @param {object} context
   * @returns {Logger}
   */
  child(context) {
    return new Logger({
      level: this._level,
      transports: this._transports,
      context: { ...this._context, ...context },
    });
  }

  /**
   * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL'} level
   * @param {string} message
   * @param {object} [meta]
   */
  log(level, message, meta) {
    if (!isValidLevel(level)) {
      throw new Error(`[Logging] Invalid log level '${level}'`);
    }
    if (!meetsThreshold(level, this._level)) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(Object.keys(this._context).length > 0 ? { context: this._context } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };

    for (const transport of this._transports) {
      transport.write(entry);
    }
  }

  debug(message, meta) { this.log('DEBUG', message, meta); }
  info(message, meta) { this.log('INFO', message, meta); }
  warn(message, meta) { this.log('WARN', message, meta); }
  error(message, meta) { this.log('ERROR', message, meta); }
  /** FATAL implies the process cannot continue — callers are still responsible for actually exiting; this only logs. */
  fatal(message, meta) { this.log('FATAL', message, meta); }
}

module.exports = { Logger };
