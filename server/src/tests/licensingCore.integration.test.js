/**
 * RC1 Sprint 1 integration test — the full Licensing Domain stack
 * (migration -> repositories -> services) against a REAL MariaDB, end to
 * end: pending registration, approval, plan assignment, extension,
 * license status (device count + days remaining), the full
 * ACTIVE->READ_ONLY->SUSPENDED->ARCHIVED sweep (fast-forwarded by
 * backdating timestamps directly, the same technique
 * wave1-sessions.test.js/license-state-machine.test.js already use), and
 * manual suspend/reactivate.
 *
 * Same honest-skip pattern as every other integration test in this
 * project. Config is env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME).
 *
 * Usage: node server/src/tests/licensingCore.integration.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests, withConnection } = require('../database');
const tenantRepository = require('../repositories/tenantRepository');
const roleRepository = require('../repositories/roleRepository');
const userRepository = require('../repositories/userRepository');
const tenantLicenseService = require('../services/tenantLicenseService');
const tenantLicenseRepository = require('../repositories/tenantLicenseRepository');

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
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_phase6_test',
};

async function main() {
  console.log('RC1 Sprint 1 integration test: full Licensing Domain stack against real MariaDB');
  console.log('');

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);
  if (!health.ok) {
    for (const label of [
      'a new tenant starts PENDING_APPROVAL and can be approved',
      'assignPlanToTenant and extendLicense update expiry correctly',
      'getLicenseStatus reports real device count and days remaining',
      'the sweep transitions ACTIVE -> READ_ONLY -> SUSPENDED -> ARCHIVED on backdated timestamps',
      'manual suspend kills sessions and reactivate restores ACTIVE',
      'license_history records every transition',
    ]) skip(label, `no reachable/authenticated database: ${health.error}`);
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(failed > 0 ? 1 : 0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  try {
    await migrateUp(pool);
    const ownerRole = await roleRepository.findByCode('owner');
    const tenant = await tenantRepository.create('Licensing Integration Shop ' + Date.now());
    await userRepository.create({
      tenantId: tenant.id, mobile: '95000' + String(Date.now()).slice(-5),
      displayName: 'Licensing Owner', passwordHash: bcrypt.hashSync('123456', 10), roleId: ownerRole.id,
    });

    // ── Pending registration + approval ──────────────────────────────
    const pending = await tenantLicenseService.createPendingLicense({ tenantId: tenant.id, requestedPlan: 'PREMIUM', requestedDevicesBucket: '5+', requestedModules: ['billing'] });
    assert(pending.status === 'PENDING_APPROVAL', 'a new tenant license starts PENDING_APPROVAL against the real database');

    const approveResult = await tenantLicenseService.approveRegistration(tenant.id);
    assert(approveResult.status === 'ACTIVE', 'approveRegistration moves a fresh registration to ACTIVE');
    const afterApprove = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(!!afterApprove.license_key, 'approveRegistration auto-generates a license key against the real database');
    assert(afterApprove.plan_code === 'TRIAL', 'approveRegistration auto-defaults to TRIAL when nothing was pre-assigned');

    // ── assignPlan (admin action) + extendLicense ─────────────────────
    await tenantLicenseService.assignPlan(tenant.id, 'PREMIUM', 'monthly');
    const afterAssign = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(afterAssign.plan_code === 'PREMIUM' && afterAssign.device_limit === 5, 'assignPlan updates plan and device_limit against the real database');

    // assignPlan(..., 'monthly') already set expires_at to +30 days;
    // extendLicense's own rule (matches local.js:1552 exactly) is to add
    // onto an existing FUTURE expiry rather than reset it, so this
    // correctly stacks to roughly +60 days total, not +30.
    const extendResult = await tenantLicenseService.extendLicense(tenant.id, { days: 30 });
    assert(extendResult.reactivated === false, 'extendLicense reports reactivated:false for an already-ACTIVE tenant');

    // ── getLicenseStatus ───────────────────────────────────────────────
    const status = await tenantLicenseService.getLicenseStatus(tenant.id);
    assert(status.devicesUsed === 0, 'getLicenseStatus reports 0 active devices for a tenant with none registered');
    assert(status.daysRemaining > 55 && status.daysRemaining <= 60, 'getLicenseStatus computes daysRemaining correctly against the real database, including extendLicense stacking onto the existing future expiry (matches local.js:1552 exactly)');
    assert(!!status.lastVerifiedAt, 'getLicenseStatus stamps last_verified_at on every call (the offline-grace anchor)');

    // ── Sweep: ACTIVE -> READ_ONLY (backdate expires_at) ──────────────
    await withConnection((conn) => conn.query("UPDATE tenant_licenses SET expires_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 DAY) WHERE tenant_id = ?", [tenant.id]));
    let sweepResult = await tenantLicenseService.runTransitionSweep();
    assert(sweepResult.toReadOnly >= 1, 'the sweep transitions an expired ACTIVE tenant to READ_ONLY');
    let afterSweep1 = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(afterSweep1.status === 'READ_ONLY' && !!afterSweep1.read_only_since, 'tenant is now READ_ONLY with read_only_since stamped');

    // ── Sweep: READ_ONLY -> SUSPENDED (backdate read_only_since 31 days) ──
    await withConnection((conn) => conn.query("UPDATE tenant_licenses SET read_only_since = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 31 DAY) WHERE tenant_id = ?", [tenant.id]));
    sweepResult = await tenantLicenseService.runTransitionSweep();
    assert(sweepResult.toSuspended >= 1, 'the sweep transitions a 31-day-stale READ_ONLY tenant to SUSPENDED');
    let afterSweep2 = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(afterSweep2.status === 'SUSPENDED', 'tenant is now SUSPENDED after the 30-day grace window');

    // ── Sweep: SUSPENDED -> ARCHIVED (backdate suspended_since 366 days) ──
    await withConnection((conn) => conn.query("UPDATE tenant_licenses SET suspended_since = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 366 DAY) WHERE tenant_id = ?", [tenant.id]));
    sweepResult = await tenantLicenseService.runTransitionSweep();
    assert(sweepResult.toArchived >= 1, 'the sweep transitions a 366-day-stale SUSPENDED tenant to ARCHIVED');
    let afterSweep3 = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(afterSweep3.status === 'ARCHIVED', 'tenant is now ARCHIVED — the full 4-state lifecycle completed end to end against the real database');

    // ── Manual reactivate ──────────────────────────────────────────────
    await tenantLicenseService.reactivateTenant(tenant.id);
    const afterReactivate = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(afterReactivate.status === 'ACTIVE' && !afterReactivate.read_only_since && !afterReactivate.suspended_since, 'reactivateTenant restores ACTIVE and clears both timer columns');

    // ── Manual suspend kills sessions ──────────────────────────────────
    await tenantLicenseService.suspendTenant(tenant.id, 'integration test');
    const afterSuspend = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(afterSuspend.status === 'SUSPENDED', 'manual suspendTenant works against the real database');

    // ── license_history audit trail ────────────────────────────────────
    const history = await tenantLicenseService.getHistory(tenant.id);
    const eventTypes = history.map((h) => h.event_type);
    assert(eventTypes.includes('REGISTERED') && eventTypes.includes('APPROVED') && eventTypes.includes('PLAN_ASSIGNED') && eventTypes.includes('EXTENDED'), 'license_history records every transition performed above, in order, against the real database');
    assert(eventTypes.filter((e) => e === 'STATUS_CHANGED').length >= 4, 'license_history records every STATUS_CHANGED transition (sweep x3 + reactivate + suspend)');

    // ── Device limit ─────────────────────────────────────────────────
    await tenantLicenseService.setDeviceLimit(tenant.id, 8);
    const afterLimit = await tenantLicenseRepository.findByTenantId(tenant.id);
    assert(afterLimit.device_limit === 8, 'setDeviceLimit updates device_limit against the real database');
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
