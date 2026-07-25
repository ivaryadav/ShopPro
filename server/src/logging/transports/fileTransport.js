/**
 * server/src/logging/transports/fileTransport.js
 *
 * Appends structured JSON log lines to a daily-rotated file under
 * `logDir` (e.g. logs/2026-07-25.log). Deliberately simple — one
 * synchronous append per line, no external log-rotation dependency, no
 * buffering/batching. This project's realistic scale (a single server
 * process) doesn't yet justify a proper async log-shipping pipeline; if
 * that changes, replace this transport rather than growing it in place
 * (see server/src/logging/README.md's note on the Cloud transport).
 *
 * Creates `logDir` if it doesn't exist. Never throws on a write failure —
 * a logging failure must not crash the request that triggered the log
 * line; it falls back to console.error so the failure itself is visible.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} logDir
 * @returns {{ write: (entry: object) => void }}
 */
function createFileTransport(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    console.error(`[Logging] Could not create log directory '${logDir}': ${e.message}`);
  }

  return {
    write(entry) {
      try {
        const dateStamp = entry.timestamp.slice(0, 10); // YYYY-MM-DD
        const filePath = path.join(logDir, `${dateStamp}.log`);
        fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
      } catch (e) {
        console.error(`[Logging] File transport write failed: ${e.message}`);
      }
    },
  };
}

module.exports = { createFileTransport };
