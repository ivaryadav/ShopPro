/**
 * Phase 1 test — server/src/config/. Pure logic, no database or network
 * required. Matches the assert()/pass-fail style used throughout
 * server/test/ for consistency, rather than introducing a new test
 * framework for this new tree.
 *
 * Usage: node server/src/tests/config.test.js
 */
'use strict';

const { loadEnv } = require('../config/env');
const { getJwtConfig } = require('../config/jwt');
const { getMailConfig } = require('../config/mail');
const { getDatabaseConfig } = require('../config/database');
const { getLoggerConfig } = require('../config/logger');
const { getLicenseConfig } = require('../config/license');
const { getStorageConfig } = require('../config/storage');
const { getConfig } = require('../config/index');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function assertThrows(fn, label) {
  try { fn(); failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label + ' (did not throw)'); }
  catch (e) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
}

console.log('Phase 1: config/ tests');
console.log('');

// ── env.js ───────────────────────────────────────────────────────────────
const defaults = loadEnv({});
assert(defaults.PORT === 3000, 'PORT defaults to 3000 and is parsed as a number');
assert(defaults.NODE_ENV === 'development', 'NODE_ENV defaults to development');
assert(defaults.LOG_LEVEL === 'INFO', 'LOG_LEVEL defaults to INFO');

const validOverride = loadEnv({ PORT: '8080', NODE_ENV: 'production', LOG_LEVEL: 'DEBUG' });
assert(validOverride.PORT === 8080, 'PORT respects an explicit override');
assert(validOverride.NODE_ENV === 'production', 'NODE_ENV respects an explicit override');

assertThrows(() => loadEnv({ PORT: 'not-a-number' }), 'loadEnv rejects a non-numeric PORT');
assertThrows(() => loadEnv({ NODE_ENV: 'staging' }), 'loadEnv rejects an unrecognized NODE_ENV');
assertThrows(() => loadEnv({ LOG_LEVEL: 'VERBOSE' }), 'loadEnv rejects an invalid LOG_LEVEL');

try {
  loadEnv({ PORT: 'x', LOG_LEVEL: 'y' });
  failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m loadEnv aggregates multiple problems into one error');
} catch (e) {
  const hasBoth = e.message.includes('PORT') && e.message.includes('LOG_LEVEL');
  assert(hasBoth, 'loadEnv aggregates multiple problems into one error, not just the first');
}

// ── database.js ──────────────────────────────────────────────────────────
const dbConfig = getDatabaseConfig({ DB_HOST: 'db.example.com', DB_PORT: '3307' });
assert(dbConfig.host === 'db.example.com', 'database config reads DB_HOST');
assert(dbConfig.port === 3307, 'database config reads and parses DB_PORT');
assert(dbConfig.connectionLimit === 10, 'database config has a sane default connection limit');

// ── jwt.js ───────────────────────────────────────────────────────────────
assertThrows(() => getJwtConfig({}), 'getJwtConfig throws when JWT_SECRET is unset (fail-fast, matches local.js)');
const jwtConfig = getJwtConfig({ JWT_SECRET: 'a-real-secret' });
assert(jwtConfig.secret === 'a-real-secret', 'getJwtConfig reads JWT_SECRET when set');
assert(jwtConfig.accessTokenTtl === '15m', 'getJwtConfig has the expected default access-token TTL');

// ── mail.js ──────────────────────────────────────────────────────────────
assertThrows(() => getMailConfig({}), 'getMailConfig throws when SMTP_* is unset and not marked optional');
const mailOptional = getMailConfig({}, { optional: true });
assert(mailOptional.host === '', 'getMailConfig with {optional:true} returns empty values instead of throwing');
const mailConfig = getMailConfig({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f@example.com' });
assert(mailConfig.host === 'smtp.example.com', 'getMailConfig reads a fully-configured SMTP setup');

// ── logger.js / license.js / storage.js ─────────────────────────────────
assert(getLoggerConfig({ NODE_ENV: 'production' }).isProduction === true, 'logger config correctly derives isProduction');
assert(getLicenseConfig({}).offlineGraceDays === 15, 'license config has the expected default offline grace period');
assert(getStorageConfig({}).backupDir === './backups', 'storage config has the expected default backup directory');

// ── index.js aggregator ─────────────────────────────────────────────────
const full = getConfig({ JWT_SECRET: 'secret' });
assert(!!full.database && !!full.jwt && !!full.logger, 'getConfig() aggregates every sub-config into one object');
const withoutJwt = getConfig({}, { requireJwt: false });
assert(withoutJwt.jwt === null, 'getConfig({requireJwt:false}) does not throw when JWT_SECRET is unset');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
