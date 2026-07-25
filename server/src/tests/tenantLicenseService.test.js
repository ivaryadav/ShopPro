/**
 * RC1 Sprint 1 test — services/tenantLicenseService.js. Verifies every
 * business rule matches local.js's Licensing domain exactly (see
 * tenantLicenseService.js's own per-function header comments for line
 * citations). No live database needed — repositories are monkey-patched.
 *
 * Usage: node server/src/tests/tenantLicenseService.test.js
 */
'use strict';

const tenantLicenseRepository = require('../repositories/tenantLicenseRepository');
const subscriptionPlanRepository = require('../repositories/subscriptionPlanRepository');
const licenseHistoryRepository = require('../repositories/licenseHistoryRepository');
const tenantLicenseService = require('../services/tenantLicenseService');
const { ValidationError, NotFoundError, ConflictError, BusinessRuleError } = require('../errors');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
async function assertThrows(fn, ErrorClass, label) {
  try {
    await fn();
    failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label + ' (did not throw)');
  } catch (e) {
    if (e instanceof ErrorClass) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
    else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${label} (got ${e.constructor.name}: ${e.message})`); }
  }
}
function patch(mod, overrides) {
  const originals = {};
  for (const [key, fn] of Object.entries(overrides)) { originals[key] = mod[key]; mod[key] = fn; }
  return () => { for (const [key, fn] of Object.entries(originals)) mod[key] = fn; };
}

async function main() {
  console.log('RC1 Sprint 1: tenantLicenseService.js tests');
  console.log('');

  // ── generateLicenseKey ───────────────────────────────────────────────
  {
    const restore = patch(tenantLicenseRepository, { licenseKeyExists: async () => false });
    const key = await tenantLicenseService.generateLicenseKey();
    assert(/^SHOP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key), "generateLicenseKey produces the exact SHOP-XXXX-XXXX-XXXX shape — matches local.js:324-336");
    const randomPortion = key.slice('SHOP-'.length); // exclude the literal "SHOP" prefix, which itself legitimately contains 'O'
    assert(!/[0O1I]/.test(randomPortion), 'generateLicenseKey never uses ambiguous characters 0/O/1/I in its random groups — matches local.js:323\'s charset exactly');
    restore();
  }
  {
    let calls = 0;
    const restore = patch(tenantLicenseRepository, { licenseKeyExists: async () => { calls++; return calls < 3; } });
    const key = await tenantLicenseService.generateLicenseKey();
    assert(calls === 3, 'generateLicenseKey retries past a collision until a unique key is found');
    restore();
  }

  // ── createPendingLicense ─────────────────────────────────────────────
  {
    let created = null, historyRecorded = null;
    const restorePlan = patch(subscriptionPlanRepository, { findActiveByCode: async (code) => (code === 'TRIAL' ? { code: 'TRIAL', device_limit: 2 } : null) });
    const restoreLic = patch(tenantLicenseRepository, { createPending: async (data) => { created = data; return { ...data }; } });
    const restoreHist = patch(licenseHistoryRepository, { record: async (data) => { historyRecorded = data; } });
    await tenantLicenseService.createPendingLicense({ tenantId: 1, requestedPlan: 'BOGUS', requestedDevicesBucket: '3-5', requestedModules: ['a', 'b'] });
    assert(created.planCode === 'TRIAL', 'createPendingLicense falls back to TRIAL when the requested plan is unknown — matches local.js:842-844 exactly');
    assert(created.requestedDevicesBucket === '3-5', 'createPendingLicense accepts a valid devices bucket');
    assert(historyRecorded.eventType === 'REGISTERED' && historyRecorded.toStatus === 'PENDING_APPROVAL', 'createPendingLicense records a REGISTERED history event');
    restorePlan(); restoreLic(); restoreHist();
  }
  {
    const restorePlan = patch(subscriptionPlanRepository, { findActiveByCode: async () => ({ code: 'TRIAL', device_limit: 2 }) });
    const restoreLic = patch(tenantLicenseRepository, { createPending: async (data) => data });
    const restoreHist = patch(licenseHistoryRepository, { record: async () => {} });
    const result = await tenantLicenseService.createPendingLicense({ tenantId: 1, requestedDevicesBucket: 'not-a-real-bucket' });
    assert(result.requestedDevicesBucket === null, "createPendingLicense rejects an invalid devices bucket (nulls it out) — matches local.js:845's ['1-2','3-5','5+'] whitelist exactly");
    restorePlan(); restoreLic(); restoreHist();
  }

  // ── assignPlanToTenant ───────────────────────────────────────────────
  await (async () => {
    const restore = patch(subscriptionPlanRepository, { findActiveByCode: async () => null });
    await assertThrows(() => tenantLicenseService.assignPlanToTenant(1, 'BOGUS', 'monthly'), ValidationError, 'assignPlanToTenant rejects an unknown plan code — matches local.js:351 exactly');
    restore();
  })();
  await (async () => {
    const restore = patch(subscriptionPlanRepository, { findActiveByCode: async () => ({ code: 'BASIC', device_limit: 2 }) });
    await assertThrows(() => tenantLicenseService.assignPlanToTenant(1, 'BASIC', 'weekly'), ValidationError, "assignPlanToTenant rejects an unknown billing cycle — matches local.js:352-354's BILLING_CYCLE_DAYS whitelist exactly");
    restore();
  })();
  {
    const restorePlan = patch(subscriptionPlanRepository, { findActiveByCode: async () => ({ code: 'PREMIUM', device_limit: 5 }) });
    const restoreLic = patch(tenantLicenseRepository, { assignPlan: async () => {} });
    const result = await tenantLicenseService.assignPlanToTenant(1, 'PREMIUM', 'lifetime');
    assert(result.expiresAt === null, "assignPlanToTenant sets expiresAt to null for 'lifetime' billing — matches local.js:344's BILLING_CYCLE_DAYS.lifetime=null exactly");
    restorePlan(); restoreLic();
  }
  {
    const restorePlan = patch(subscriptionPlanRepository, { findActiveByCode: async () => ({ code: 'PREMIUM', device_limit: 5 }) });
    const restoreLic = patch(tenantLicenseRepository, { assignPlan: async () => {} });
    const result = await tenantLicenseService.assignPlanToTenant(1, 'PREMIUM', 'monthly', 10);
    assert(result.deviceLimit === 10, 'assignPlanToTenant honors a positive deviceLimitOverride over the plan default — matches local.js:357 exactly');
    restorePlan(); restoreLic();
  }

  // ── assignPlan (admin action wrapper) ────────────────────────────────
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => null });
    await assertThrows(() => tenantLicenseService.assignPlan(1, 'BASIC', 'monthly'), NotFoundError, 'assignPlan throws NotFoundError for a nonexistent tenant license — matches local.js:1492-1493 exactly');
    restore();
  }
  {
    let historyRecorded = null;
    const restoreLic = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'ACTIVE' }), assignPlan: async () => {} });
    const restorePlan = patch(subscriptionPlanRepository, { findActiveByCode: async () => ({ code: 'BASIC', device_limit: 2 }) });
    const restoreHist = patch(licenseHistoryRepository, { record: async (d) => { historyRecorded = d; } });
    await tenantLicenseService.assignPlan(1, 'BASIC', 'yearly');
    assert(historyRecorded && historyRecorded.eventType === 'PLAN_ASSIGNED' && historyRecorded.detail.includes('BASIC/yearly'), "assignPlan logs a PLAN_ASSIGNED history event with plan/billing/device_limit detail — matches local.js:1496 exactly (distinct from assignPlanToTenant, the shared non-logging helper startTrial/approveRegistration use internally)");
    restoreLic(); restorePlan(); restoreHist();
  }

  // ── approveRegistration ──────────────────────────────────────────────
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => null });
    await assertThrows(() => tenantLicenseService.approveRegistration(1), NotFoundError, 'approveRegistration throws NotFoundError for a nonexistent tenant license');
    restore();
  }
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'ACTIVE' }) });
    await assertThrows(() => tenantLicenseService.approveRegistration(1), BusinessRuleError, "approveRegistration rejects a non-PENDING_APPROVAL tenant — matches local.js:1405-1407 exactly");
    restore();
  }
  {
    let planAssigned = false, keySet = false, marked = false;
    const restoreLic = patch(tenantLicenseRepository, {
      findByTenantId: async () => ({ status: 'PENDING_APPROVAL', starts_at: null, license_key: null }),
      assignPlan: async () => { planAssigned = true; },
      setLicenseKey: async () => { keySet = true; },
      markActive: async () => { marked = true; },
      licenseKeyExists: async () => false,
    });
    const restorePlan = patch(subscriptionPlanRepository, { findActiveByCode: async () => ({ code: 'TRIAL', device_limit: 2 }) });
    const restoreHist = patch(licenseHistoryRepository, { record: async () => {} });
    await tenantLicenseService.approveRegistration(1);
    assert(planAssigned && keySet && marked, "approveRegistration auto-defaults to a TRIAL plan and generates a key when neither was pre-configured — matches local.js:1416-1423 exactly");
    restoreLic(); restorePlan(); restoreHist();
  }

  // ── rejectRegistration ───────────────────────────────────────────────
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'ACTIVE' }) });
    await assertThrows(() => tenantLicenseService.rejectRegistration(1), BusinessRuleError, 'rejectRegistration rejects a non-PENDING_APPROVAL tenant');
    restore();
  }
  {
    let archived = false;
    const restoreLic = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'PENDING_APPROVAL' }), markArchived: async () => { archived = true; } });
    const restoreHist = patch(licenseHistoryRepository, { record: async () => {} });
    await tenantLicenseService.rejectRegistration(1, 'spam');
    assert(archived, "rejectRegistration moves a PENDING_APPROVAL tenant to ARCHIVED — matches local.js:1436's 'no dedicated REJECTED state' design exactly");
    restoreLic(); restoreHist();
  }

  // ── generateLicenseForTenant ─────────────────────────────────────────
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => ({ license_key: 'SHOP-EXISTING' }) });
    await assertThrows(() => tenantLicenseService.generateLicenseForTenant(1, {}), ConflictError, "generateLicenseForTenant rejects overwriting an existing key without regenerate:true — matches local.js:1523-1525 exactly");
    restore();
  }
  {
    const restoreLic = patch(tenantLicenseRepository, { findByTenantId: async () => ({ license_key: 'SHOP-OLD' }), setLicenseKey: async () => {}, licenseKeyExists: async () => false });
    const restoreHist = patch(licenseHistoryRepository, { record: async (d) => { assert(d.eventType === 'KEY_REGENERATED', 'generateLicenseForTenant logs KEY_REGENERATED when replacing an existing key'); } });
    await tenantLicenseService.generateLicenseForTenant(1, { regenerate: true });
    restoreLic(); restoreHist();
  }

  // ── extendLicense ────────────────────────────────────────────────────
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'PENDING_APPROVAL' }) });
    await assertThrows(() => tenantLicenseService.extendLicense(1, { days: 30 }), BusinessRuleError, "extendLicense refuses a PENDING_APPROVAL tenant — matches local.js:1544 exactly");
    restore();
  }
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'ARCHIVED' }) });
    await assertThrows(() => tenantLicenseService.extendLicense(1, { days: 30 }), BusinessRuleError, "extendLicense refuses an ARCHIVED tenant — matches local.js:1545 exactly");
    restore();
  }
  {
    const restore = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'READ_ONLY', expires_at: null }) });
    await assertThrows(() => tenantLicenseService.extendLicense(1, {}), ValidationError, 'extendLicense requires either days or newExpiresAt');
    restore();
  }
  {
    const restoreLic = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'SUSPENDED', expires_at: null }), extend: async () => {} });
    const restoreHist = patch(licenseHistoryRepository, { record: async () => {} });
    const result = await tenantLicenseService.extendLicense(1, { days: 30 });
    assert(result.reactivated === true, 'extendLicense reports reactivated:true when extending a SUSPENDED tenant — matches local.js:1561 exactly');
    restoreLic(); restoreHist();
  }

  // ── suspendTenant / reactivateTenant ─────────────────────────────────
  {
    let suspended = false, sessionsKilled = false;
    const restoreLic = patch(tenantLicenseRepository, {
      findByTenantId: async () => ({ status: 'ACTIVE' }),
      suspend: async () => { suspended = true; },
      revokeAllSessionsForTenant: async () => { sessionsKilled = true; return 3; },
    });
    const restoreHist = patch(licenseHistoryRepository, { record: async () => {} });
    await tenantLicenseService.suspendTenant(1, 'non-payment');
    assert(suspended && sessionsKilled, "suspendTenant suspends AND kills all active sessions — matches local.js:1570-1571 exactly");
    restoreLic(); restoreHist();
  }

  // ── getLicenseStatus ─────────────────────────────────────────────────
  {
    const restore = patch(tenantLicenseRepository, { touchLastVerified: async () => null });
    const result = await tenantLicenseService.getLicenseStatus(999);
    assert(result === null, 'getLicenseStatus fails open (returns null) for a tenant with no license row — matches local.js:461/475\'s fail-open pattern');
    restore();
  }
  {
    const restoreLic = patch(tenantLicenseRepository, {
      touchLastVerified: async () => ({
        status: 'ACTIVE', plan_code: 'PREMIUM', billing_cycle: 'yearly', device_limit: 5,
        expires_at: new Date(Date.now() + 10 * 86400000), license_key: 'SHOP-X', last_verified_at: new Date(),
        offline_grace_days: 15, requested_modules: '["billing"]', requested_devices_bucket: '3-5', requested_plan_code: 'PREMIUM',
      }),
      countActiveDevices: async () => 3,
    });
    const result = await tenantLicenseService.getLicenseStatus(1);
    assert(result.devicesUsed === 3, 'getLicenseStatus reports the real active-device count');
    assert(result.daysRemaining === 10, 'getLicenseStatus computes daysRemaining from expires_at exactly — matches local.js:1167');
    assert(Array.isArray(result.requestedModules) && result.requestedModules[0] === 'billing', 'getLicenseStatus parses requested_modules JSON correctly');
    restoreLic();
  }

  // ── runTransitionSweep ───────────────────────────────────────────────
  {
    const readOnlyMarked = [], suspendedMarked = [], archivedMarked = [], sessionsKilledFor = [];
    const restoreLic = patch(tenantLicenseRepository, {
      findExpiredActiveTenantIds: async () => [1, 2],
      findStaleReadOnlyTenantIds: async () => [3],
      findStaleSuspendedTenantIds: async () => [4],
      markReadOnly: async (id) => readOnlyMarked.push(id),
      markSuspendedFromReadOnly: async (id) => suspendedMarked.push(id),
      markArchivedFromSuspended: async (id) => archivedMarked.push(id),
      revokeAllSessionsForTenant: async (id) => sessionsKilledFor.push(id),
    });
    const restoreHist = patch(licenseHistoryRepository, { record: async () => {} });
    const result = await tenantLicenseService.runTransitionSweep();
    assert(readOnlyMarked.length === 2 && result.toReadOnly === 2, "runTransitionSweep transitions every expired ACTIVE tenant to READ_ONLY — matches local.js:567-576 exactly");
    assert(suspendedMarked.length === 1 && sessionsKilledFor.includes(3), "runTransitionSweep transitions stale READ_ONLY tenants to SUSPENDED and kills their sessions — matches local.js:578-588 exactly");
    assert(archivedMarked.length === 1, "runTransitionSweep transitions stale SUSPENDED tenants to ARCHIVED — matches local.js:590-599 exactly");
    restoreLic(); restoreHist();
  }

  // ── RC1 Sprint 2 additions: killSessions / addNote / addCallNote ──────
  {
    let historyRecorded = null;
    const restoreLic = patch(tenantLicenseRepository, { revokeAllSessionsForTenant: async () => 5 });
    const restoreHist = patch(licenseHistoryRepository, { record: async (d) => { historyRecorded = d; } });
    const result = await tenantLicenseService.killSessions(1);
    assert(result.revoked === 5, "killSessions returns the real revoked count — matches local.js:1587-1592 exactly");
    assert(historyRecorded.eventType === 'SESSIONS_KILLED' && historyRecorded.detail === '5 session(s) revoked', 'killSessions logs a SESSIONS_KILLED history event with the exact count, unlike suspendTenant it does NOT change status');
    restoreLic(); restoreHist();
  }
  await assertThrows(() => tenantLicenseService.addNote(1, ''), ValidationError, "addNote requires a non-empty note — matches local.js:1598 exactly");
  {
    let historyRecorded = null;
    const restore = patch(licenseHistoryRepository, { record: async (d) => { historyRecorded = d; } });
    await tenantLicenseService.addNote(1, 'Called about renewal');
    assert(historyRecorded.eventType === 'NOTE_ADDED' && historyRecorded.detail === 'Called about renewal', 'addNote logs a NOTE_ADDED history event with the exact text — matches local.js:1599 exactly');
    restore();
  }
  await assertThrows(() => tenantLicenseService.addCallNote(1, ''), ValidationError, 'addCallNote requires a non-empty note');
  {
    let historyRecorded = null;
    const restore = patch(licenseHistoryRepository, { record: async (d) => { historyRecorded = d; } });
    await tenantLicenseService.addCallNote(1, 'Discussed pricing');
    assert(historyRecorded.eventType === 'CALL_LOGGED' && historyRecorded.detail === 'Discussed pricing', "addCallNote logs a CALL_LOGGED history event — matches local.js:1609 exactly, distinct event type from addNote's NOTE_ADDED");
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
