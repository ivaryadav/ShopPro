/**
 * server/src/logging/transports/cloudTransport.js
 *
 * NOT IMPLEMENTED. This file exists so the transport interface every
 * future cloud-logging integration (Datadog, CloudWatch, etc.) must match
 * is decided now, in Phase 1, rather than invented ad hoc whenever a
 * later phase actually needs one — and so no cloud-provider SDK dependency
 * is added before there's a real reason to pick one.
 *
 * A real implementation exports `createCloudTransport(config)` returning
 * `{ write(entry) }`, exactly like consoleTransport.js and
 * fileTransport.js — Logger.js only ever calls `.write(entry)` on
 * whatever transports it's given, so swapping this stub for a real
 * implementation later requires no change to Logger.js itself.
 */
'use strict';

/**
 * @param {object} [config] - Provider-specific config, once a provider is chosen.
 * @returns {{ write: (entry: object) => void }}
 */
function createCloudTransport(_config) {
  return {
    write() {
      throw new Error(
        '[Logging] Cloud transport is not implemented yet. Do not enable it in ' +
        'config until a real provider integration replaces this stub.'
      );
    },
  };
}

module.exports = { createCloudTransport };
