/**
 * Migration safety test — the fix for "migration failures are silently
 * swallowed" (FailureScenarioReport.md scenario 8, MigrationSafetyReport.md).
 *
 * Before this fix: `try { db.exec(sql); } catch(_) {}` around every startup
 * migration statement caught ANY error identically — a benign "already
 * applied" re-run and a genuine syntax/corruption error were
 * indistinguishable, both silently swallowed, server boots either way.
 *
 * After: BENIGN_MIGRATION_ERROR classifies the two error shapes SQLite
 * actually produces for "this ALTER/CREATE was already applied" (duplicate
 * column name / already exists) as expected and silent; anything else is
 * logged loudly via console.error and recorded in a failures[] array (which
 * GET /health now reports — see OperationalHardeningReport.md) — but does
 * NOT crash the process, since these are independent, additive statements
 * and a bad one shouldn't take down a server that's otherwise fine.
 *
 * This test extracts the REAL runMigration()/BENIGN_MIGRATION_ERROR source
 * from server/local.js (not a reimplementation) and drives it with a fake
 * `db` whose .exec() throws controlled error messages — the same
 * extract-and-execute-the-real-code approach used in xss-regression.test.js
 * for escHtml(), for the same reason: no live DB corruption is needed to
 * prove the classification and control-flow logic is correct, and
 * deterministically forcing SQLite itself to fail for a "genuine" (not
 * duplicate-column) reason isn't reliably reproducible without contrived
 * file-level corruption that wouldn't prove anything the unit-level check
 * doesn't already.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

const localJsPath = path.join(__dirname, '..', 'local.js');
const src = fs.readFileSync(localJsPath, 'utf8');

const benignMatch = src.match(/const BENIGN_MIGRATION_ERROR = (\/.*\/i);/);
assert(!!benignMatch, 'BENIGN_MIGRATION_ERROR regex found in server/local.js');
// eslint-disable-next-line no-eval
const BENIGN_MIGRATION_ERROR = eval(benignMatch[1]);

const runMigrationMatch = src.match(/function runMigration\(sql, label\) \{[\s\S]*?\n\}/);
assert(!!runMigrationMatch, 'runMigration() function found in server/local.js');

// ---------------------------------------------------------------------
// Layer 1: classification regex — real SQLite error message shapes
// ---------------------------------------------------------------------
assert(BENIGN_MIGRATION_ERROR.test('SQLITE_ERROR: duplicate column name: display_name'),
  'classifies "duplicate column name" (real better-sqlite3 message for a repeated ALTER TABLE ADD COLUMN) as benign');
assert(BENIGN_MIGRATION_ERROR.test('SQLITE_ERROR: table cloud_backups already exists'),
  'classifies "already exists" (real message for CREATE TABLE without IF NOT EXISTS) as benign');
assert(BENIGN_MIGRATION_ERROR.test('SQLITE_ERROR: index idx_tenants_license already exists'),
  'classifies "already exists" for an index the same way');
assert(!BENIGN_MIGRATION_ERROR.test('SQLITE_ERROR: near "TEXTX": syntax error'),
  'does NOT classify a genuine syntax error as benign');
assert(!BENIGN_MIGRATION_ERROR.test('SQLITE_READONLY: attempt to write a readonly database'),
  'does NOT classify a readonly-database error as benign');
assert(!BENIGN_MIGRATION_ERROR.test('SQLITE_CORRUPT: database disk image is malformed'),
  'does NOT classify a corruption error as benign');

// ---------------------------------------------------------------------
// Layer 2: runMigration() control flow, using the REAL extracted function
// against a fake db + captured logger.error (OperationalHardeningPhase2.md
// switched this from console.error to the new structured logger), proving:
//   (a) benign errors are silent and NOT recorded as failures
//   (b) genuine errors ARE logged loudly AND recorded
//   (c) neither case throws out of runMigration (server keeps booting)
// ---------------------------------------------------------------------
function buildRunMigration(execImpl) {
  const migrationState = { failures: [] };
  const db = { exec: execImpl };
  const consoleErrors = [];
  const fakeLogger = { error: (msg, meta) => consoleErrors.push(msg + (meta ? ' ' + JSON.stringify(meta) : '')) };
  // eslint-disable-next-line no-eval
  const runMigration = eval(
    '(function(db, logger, migrationState, BENIGN_MIGRATION_ERROR) { return ' +
    runMigrationMatch[0] + '; })'
  )(db, fakeLogger, migrationState, BENIGN_MIGRATION_ERROR);
  return { runMigration, migrationState, consoleErrors };
}

{
  const { runMigration, migrationState, consoleErrors } = buildRunMigration(() => {
    throw new Error('SQLITE_ERROR: duplicate column name: mobile');
  });
  let threw = false;
  try { runMigration('ALTER TABLE users ADD COLUMN mobile TEXT', 'users.mobile'); } catch (_) { threw = true; }
  assert(!threw, 'runMigration() does not throw for a benign (already-applied) error — boot continues');
  assert(migrationState.failures.length === 0, 'benign error is NOT recorded in migrationState.failures');
  assert(consoleErrors.length === 0, 'benign error produces no console.error output (still silent, matching pre-fix idempotency behavior)');
}

{
  const { runMigration, migrationState, consoleErrors } = buildRunMigration(() => {
    throw new Error('SQLITE_ERROR: near "DEFALUT": syntax error');
  });
  let threw = false;
  try { runMigration('ALTER TABLE users ADD COLUMN broken TEXTX NOT NULL DEFALUT', 'users.broken'); } catch (_) { threw = true; }
  assert(!threw, 'runMigration() does not throw for a genuine error either — one bad migration does not crash the server (availability preserved)');
  assert(migrationState.failures.length === 1, 'genuine error IS recorded in migrationState.failures');
  assert(migrationState.failures[0].label === 'users.broken', 'recorded failure carries the correct label for operator diagnosis');
  assert(migrationState.failures[0].error.includes('syntax error'), 'recorded failure carries the real underlying error message');
  assert(!!migrationState.failures[0].at, 'recorded failure carries a timestamp');
  assert(consoleErrors.length === 1 && consoleErrors[0].includes('[MIGRATION FAILED]') && consoleErrors[0].includes('users.broken'),
    'genuine error IS logged loudly via console.error, prefixed [MIGRATION FAILED], naming the failed migration — this is the actual fix: previously identical to the silent case above');
}

// ---------------------------------------------------------------------
// Layer 3: live boot — a real, unmodified DB still boots clean with zero
// recorded failures (regression guard: the new classification must not
// start flagging any of the server's own real, currently-passing
// migrations as "genuine" failures)
// ---------------------------------------------------------------------
async function liveBootCheck() {
  const { startTestServer } = require('./testServer');
  const srv = await startTestServer();
  try {
    const r = await fetch(srv.baseUrl + '/health');
    const body = await r.json();
    assert(r.ok, 'live isolated server boots successfully with the new migration runner');
    assert(!('migrationFailures' in body) || body.migrationFailures === 0 || (Array.isArray(body.migrationFailures) && body.migrationFailures.length === 0),
      '/health reports zero migration failures on a fresh, correctly-migrating database');
  } finally {
    srv.stop();
  }
}

liveBootCheck().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}).catch(e => {
  console.error('Test run crashed:', e);
  process.exit(1);
});
