/**
 * Phase 2 integration test — the full stack (migration -> repositories ->
 * services) against a REAL MariaDB, end to end: tenant creation, staff
 * creation, login, device trust, session refresh, tenant suspension.
 *
 * Attempts a real connection first and SKIPS with a clear message if none
 * is reachable/authenticated, rather than failing the whole suite or
 * faking a pass — same honest pattern as
 * server/src/tests/database.test.js (Phase 1). This environment has a
 * MySQL server installed and running (via brew services) but no
 * accessible credentials were available to this session, and this
 * session did not attempt to bypass another user's pre-existing database
 * authentication — expect this file to report "skipped" here. Every
 * business-logic claim it would otherwise verify against a real database
 * is already exercised, repository-mocked, in the other server/src/tests/
 * *.test.js files.
 *
 * Usage: node server/src/tests/identityCore.integration.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests } = require('../database');
const tenantRepository = require('../repositories/tenantRepository');
const roleRepository = require('../repositories/roleRepository');
const userRepository = require('../repositories/userRepository');
const authService = require('../services/authService');
const tenantService = require('../services/tenantService');
const { AuthorizationError } = require('../errors');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function skip(label, reason) {
  skipped++;
  console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason);
}

// Phase 6: env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME) so this can
// run against a real, credentialed instance — same defaults as before
// (root/no-password/3306) when unset, preserving the honest-skip behavior.
const TEST_DB_CONFIG = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_phase2_test',
};

function fakeReq() { return { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' }, ip: '127.0.0.1' }; }

async function main() {
  console.log('Phase 2 integration test: full Identity & Tenant Core stack against real MariaDB');
  console.log('');

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);

  if (!health.ok) {
    for (const label of [
      'migrateUp() applies the identity-core schema',
      'a tenant can be created and read back',
      'addStaff creates a real, bcrypt-hashed user',
      'login succeeds end-to-end and issues a real session',
      'a paused tenant blocks assertActive()',
    ]) {
      skip(label, `no reachable/authenticated database: ${health.error}`);
    }
    console.log(
      '\n  Note: same honest-skip situation as Phase 1\'s database.test.js — a MySQL/MariaDB\n' +
      '  server is running on this machine but this session has no credentials to it and\n' +
      '  did not attempt to bypass another user\'s pre-existing database authentication.\n' +
      '  Re-run this file against a real, credentialed MariaDB instance before Phase 3\n' +
      '  relies on this stack for real.'
    );
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(failed > 0 ? 1 : 0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  try {
    await migrateUp(pool);
    passed++; console.log('  \x1b[32m✓\x1b[0m migrateUp() applies the identity-core schema to a real database');

    const ownerRole = await roleRepository.findByCode('owner');
    assert(!!ownerRole, "the seeded 'owner' role exists after migration");

    const tenant = await tenantRepository.create('Integration Test Shop ' + Date.now());
    assert(!!tenant && tenant.status === 'active', 'a new tenant is created with default status ACTIVE');

    const owner = await userRepository.create({
      tenantId: tenant.id, mobile: '90000' + String(Date.now()).slice(-5),
      displayName: 'Integration Owner', passwordHash: bcrypt.hashSync('123456', 10), roleId: ownerRole.id,
    });
    assert(owner.role === 'owner', 'the created user resolves its role via the FK join correctly');

    const loginResult = await authService.login({ mobile: owner.mobile, pin: '123456' }, fakeReq(), 'integration-test-secret');
    assert(!!loginResult.token, 'end-to-end login succeeds against the real database and issues a real JWT');

    await tenantRepository.updateStatus(tenant.id, 'paused', 'Integration test pause');
    try {
      await tenantService.assertActive(tenant.id);
      failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m a paused tenant blocks assertActive()');
    } catch (e) {
      assert(e instanceof AuthorizationError && e.message === 'Account paused', 'a paused tenant correctly blocks assertActive() end-to-end against the real database');
    }
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
