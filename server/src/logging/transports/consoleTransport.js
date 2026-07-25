/**
 * server/src/logging/transports/consoleTransport.js
 *
 * Writes structured JSON log lines to stdout/stderr — ERROR and FATAL go
 * to stderr, everything else to stdout, matching Unix convention and this
 * project's existing server/logger.js behavior (which this supersedes for
 * server/src/ code once a later phase wires it in).
 */
'use strict';

/**
 * @param {{ timestamp: string, level: string, message: string, meta?: object }} entry
 */
function write(entry) {
  const line = JSON.stringify(entry);
  if (entry.level === 'ERROR' || entry.level === 'FATAL') {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = { write };
