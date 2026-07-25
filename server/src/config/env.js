/**
 * server/src/config/env.js
 *
 * Environment validation for the enterprise backend (server/src/). Reads
 * `process.env` in exactly one place so every other module in this new
 * tree imports typed, already-validated config instead of reading
 * `process.env` directly — the "single configuration layer" required by
 * ADR-0001 / the Phase 1 mission.
 *
 * Dependency-free by design, matching this project's established
 * convention (see server/logger.js, server/local.js's in-memory rate
 * limiter) of writing small infrastructure directly rather than adding an
 * npm dependency (e.g. a schema-validation library) for something this
 * project's current scale doesn't need. If a future phase's config needs
 * genuinely outgrow what this file can express clearly, revisit that
 * decision explicitly via a new ADR rather than silently reaching for a
 * library.
 *
 * NOT wired into server/local.js or server/index.js — this module is not
 * imported by, and has no effect on, the currently-running application.
 * It exists so Phase 2 onward has a validated place to read config from
 * the moment real logic starts landing in server/src/.
 */
'use strict';

/**
 * @typedef {Object} EnvSpec
 * @property {boolean} [required] - Fails fast at load time if unset and no default.
 * @property {string} [default] - Used when unset and not required.
 * @property {(raw: string) => any} [parse] - Transform the raw string value.
 * @property {(value: any) => boolean} [validate] - Return false to reject the value.
 * @property {string} [validateMessage] - Shown when validate() returns false.
 */

/**
 * Declarative spec for every environment variable this backend reads.
 * Add a new variable here, never as a bare `process.env.X` elsewhere in
 * `server/src/`.
 * @type {Record<string, EnvSpec>}
 */
const SPEC = {
  NODE_ENV: { default: 'development', validate: (v) => ['development', 'test', 'production'].includes(v), validateMessage: "must be one of 'development', 'test', 'production'" },
  PORT: { default: '3000', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v > 0 && v < 65536, validateMessage: 'must be a valid TCP port number' },

  // MariaDB (ADR-0002) — required in Phase 2 onward, once src/database/ is
  // actually wired to a running server. Not required yet in Phase 1, since
  // nothing in this phase connects to a database.
  DB_HOST: { default: '127.0.0.1' },
  DB_PORT: { default: '3306', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v > 0 && v < 65536, validateMessage: 'must be a valid TCP port number' },
  DB_NAME: { default: 'shoperpro' },
  DB_USER: { default: 'shoperpro' },
  DB_PASSWORD: { default: '' },
  DB_POOL_MIN: { default: '0', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v >= 0, validateMessage: 'must be a non-negative integer' },
  DB_POOL_MAX: { default: '10', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v > 0, validateMessage: 'must be a positive integer' },

  JWT_SECRET: { default: '' },
  JWT_ACCESS_TTL: { default: '15m' },
  JWT_REFRESH_TTL_DAYS: { default: '30', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v > 0, validateMessage: 'must be a positive integer' },

  SMTP_HOST: { default: '' },
  SMTP_PORT: { default: '587', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v > 0 && v < 65536, validateMessage: 'must be a valid TCP port number' },
  SMTP_USER: { default: '' },
  SMTP_PASS: { default: '' },
  SMTP_FROM: { default: '' },

  LOG_LEVEL: { default: 'INFO', validate: (v) => ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(v), validateMessage: 'must be one of DEBUG, INFO, WARN, ERROR, FATAL' },
  LOG_DIR: { default: './logs' },

  LICENSE_SWEEP_INTERVAL_MS: { default: '900000', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v > 0, validateMessage: 'must be a positive integer' },
  LICENSE_OFFLINE_GRACE_DAYS: { default: '15', parse: (v) => Number(v), validate: (v) => Number.isInteger(v) && v > 0, validateMessage: 'must be a positive integer' },

  BACKUP_DIR: { default: './backups' },

  // Administration domain (Sprint 2) — matches local.js:65 exactly,
  // including its exact non-fatal fallback hash (local.js warns, doesn't
  // fail, when unset — a known, documented default admin credential, not
  // a security hole introduced here; see docs/architecture/Administration.md).
  ADMIN_KEY: { default: '2b5877210c3581cccac2431c0a5681ea1c5674ae71dbb5d664eda93e3965a3dd' },
};

/**
 * Reads, parses, and validates every variable in SPEC against
 * `process.env`. Throws a single, clear, aggregated error listing every
 * problem found — fail fast, not one variable at a time.
 * @param {NodeJS.ProcessEnv} [source] - Defaults to process.env; injectable for tests.
 * @returns {Record<string, any>} Frozen, typed config object.
 */
function loadEnv(source = process.env) {
  const result = {};
  const problems = [];

  for (const [key, spec] of Object.entries(SPEC)) {
    const raw = source[key];
    let value;

    if (raw === undefined || raw === '') {
      if (spec.required) {
        problems.push(`${key} is required and was not set.`);
        continue;
      }
      value = spec.default;
    } else {
      value = raw;
    }

    if (spec.parse) {
      try {
        value = spec.parse(value);
      } catch (e) {
        problems.push(`${key}='${value}' could not be parsed: ${e.message}`);
        continue;
      }
    }

    if (spec.validate && !spec.validate(value)) {
      problems.push(`${key}='${value}' is invalid — ${spec.validateMessage || 'failed validation'}.`);
      continue;
    }

    result[key] = value;
  }

  if (problems.length > 0) {
    throw new Error(
      `[Config] Invalid environment configuration:\n` +
      problems.map((p) => `  - ${p}`).join('\n')
    );
  }

  return Object.freeze(result);
}

module.exports = { loadEnv, SPEC };
