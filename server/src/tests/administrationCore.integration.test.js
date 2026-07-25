/**
 * RC1 Sprint 2 integration test — the full Administration Domain stack
 * (migration -> repositories -> services) against a REAL MariaDB, end to
 * end: admin login (seeded key, then bcrypt), tenant status management
 * with Licensing sync, admin dashboard listings, user administration
 * (including the last-owner guard), and device management.
 *
 * Same honest-skip pattern as every other integration test in this
 * project. Config is env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME).
 *
 * Usage: node server/src/tests/administrationCore.integration.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests } = require('../database');
const tenantRepository = require('../repositories/tenantRepository');
const roleRepository = require('../repositories/roleRepository');
const userRepository = require('../repositories/userRepository');
const tenantLicenseService = require('../services/tenantLicenseService');
const tenantLicenseRepository = require('../repositories/tenantLicenseRepository');
const trustedDeviceRepository = require('../repositories/trustedDeviceRepository');
const adminAuthService = require('../services/adminAuthService');
const adminTenantService = require('../services/adminTenantService');
const adminUserService = require('../services/adminUserService');
const adminDeviceService = require('../services/adminDeviceService');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function skip(label, reason) { skipped++; console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason); }

const TEST_DB_CONFIG = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_sprint2_test',
};

async function main() {
  console.log('RC1 Sprint 2 integration test: full Administration Domain stack against real MariaDB');
  console.log('');

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);
  if (!health.ok) {
    for (const label of [
      'admin login works end to end against a seeded admin_credentials row',
      'tenant status management syncs to Licensing against the real database',
      'admin dashboard listings (tenants, web-users) work against the real database',
      'user administration (reset-pin, toggle-user, last-owner guard) works against the real database',
      'device management (list, remove, reset-all) works against the real database',
    ]) skip(label, `no reachable/authenticated database: ${health.error}`);
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(failed > 0 ? 1 : 0);
  }

  _resetForTests();
  adminAuthService._resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  try {
    await migrateUp(pool);

    // ── Admin login: seed, then real bcrypt login ──────────────────────
    const seedHash = require('crypto').createHash('sha256').update('test-admin-seed').digest('hex');
    await adminAuthService.ensureSeeded(seedHash);
    const token1 = await adminAuthService.login('test-admin-seed');
    assert(typeof token1 === 'string' && token1.length === 64, 'admin login succeeds against the seeded legacy sha256 credential and returns a real session token');
    assert(adminAuthService.isValidAdminSession(token1), 'the issued token validates against the real in-memory session store');

    // Re-seeding after the automatic bcrypt upgrade must be a no-op (idempotent).
    await adminAuthService.ensureSeeded(seedHash);
    const token2 = await adminAuthService.login('test-admin-seed');
    assert(typeof token2 === 'string', 'admin login still succeeds after the automatic sha256->bcrypt upgrade, using the SAME password');

    // ── Tenant + user setup ─────────────────────────────────────────────
    const ownerRole = await roleRepository.findByCode('owner');
    const tenant = await tenantRepository.create('Admin Integration Shop ' + Date.now());
    const owner = await userRepository.create({
      tenantId: tenant.id, mobile: '96000' + String(Date.now()).slice(-5),
      displayName: 'Admin Test Owner', passwordHash: bcrypt.hashSync('123456', 10), roleId: ownerRole.id,
    });
    const pending = await tenantLicenseService.createPendingLicense({ tenantId: tenant.id, requestedPlan: 'BASIC' });
    assert(pending.status === 'PENDING_APPROVAL', 'setup: a fresh tenant license starts PENDING_APPROVAL');

    // ── Tenant Management: setTenantStatus syncs to Licensing ──────────
    await tenantLicenseService.approveRegistration(tenant.id); // -> ACTIVE, matches real registration-approval flow
    const statusResult = await adminTenantService.setTenantStatus({ shopName: tenant.shop_name, status: 'paused', reason: 'integration test' });
    assert(statusResult.status === 'paused', 'setTenantStatus updates the legacy tenants.status column against the real database');
    const licAfterPause = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(licAfterPause.status === 'SUSPENDED', 'setTenantStatus syncs tenant_licenses.status to SUSPENDED against the real database — matches local.js:1246-1250 exactly');

    await adminTenantService.setTenantStatus({ shopName: tenant.shop_name, status: 'active' });
    const licAfterRestore = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(licAfterRestore.status === 'ACTIVE', 'restoring the legacy status back to active syncs tenant_licenses back to ACTIVE');

    // ── Admin Dashboard listings ─────────────────────────────────────────
    const tenants = await adminTenantService.listTenants();
    assert(tenants.some((t) => t.shop_name === tenant.shop_name), 'listTenants includes the newly created tenant against the real database');
    const webUserShops = await adminTenantService.listWebUsers();
    const shopEntry = webUserShops.find((s) => s.tenantId === tenant.id);
    assert(shopEntry && shopEntry.users.length === 1 && shopEntry.users[0].name === 'Admin Test Owner', 'listWebUsers correctly groups the real owner user under its shop');

    // ── User Administration ───────────────────────────────────────────────
    const resetResult = await adminUserService.resetUserPin(owner.id, '654321');
    assert(resetResult.name === 'Admin Test Owner', 'resetUserPin works end to end against the real database');
    const reLogin = await require('../services/authService').login({ mobile: owner.mobile, pin: '654321' }, { headers: {}, ip: '127.0.0.1' }, 'admin-integration-test-secret');
    assert(!!reLogin.token, 'the reset PIN actually works for a real login afterward — proves the hash was really persisted, not just reported');

    let lastOwnerBlocked = false;
    try {
      await adminUserService.toggleUser(owner.id, false);
    } catch (e) {
      lastOwnerBlocked = e.constructor.name === 'BusinessRuleError';
    }
    assert(lastOwnerBlocked, 'toggleUser correctly refuses to disable the only active owner against the real database');

    // ── Device Management ──────────────────────────────────────────────
    await trustedDeviceRepository.createIgnoringRace(tenant.id, owner.id, 'integration-test-device-1', 'Chrome', 'macOS');
    const devices = await adminDeviceService.listDevices(tenant.id);
    assert(devices.length === 1 && devices[0].display_name === 'Admin Test Owner', 'listDevices returns the real trusted device joined with its user');

    const resetAllResult = await adminDeviceService.resetAllDevices(tenant.id);
    assert(resetAllResult.reset === 1, 'resetAllDevices deactivates the real device and reports the correct count');
    const devicesAfterReset = await adminDeviceService.listDevices(tenant.id);
    assert(devicesAfterReset[0].is_active === 0, 'the device is genuinely deactivated (is_active=0) in the real database, not hard-deleted');

    // ── Sprint 2 Licensing integration additions ──────────────────────
    const killResult = await tenantLicenseService.killSessions(tenant.id);
    assert(typeof killResult.revoked === 'number', 'killSessions works end to end against the real database');
    await tenantLicenseService.addNote(tenant.id, 'Integration test note');
    await tenantLicenseService.addCallNote(tenant.id, 'Integration test call note');
    const history = await tenantLicenseService.getHistory(tenant.id);
    const eventTypes = history.map((h) => h.event_type);
    assert(eventTypes.includes('NOTE_ADDED') && eventTypes.includes('CALL_LOGGED') && eventTypes.includes('SESSIONS_KILLED'), 'license_history records every Sprint 2 admin action against the real database');
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
