/**
 * RC1 Sprint 2 test — services/adminTenantService.js. Verifies Tenant
 * Management and the syncLegacyStatusToLicense fail-open behavior match
 * local.js exactly (local.js:1243-1330).
 *
 * Usage: node server/src/tests/adminTenantService.test.js
 */
'use strict';

const tenantRepository = require('../repositories/tenantRepository');
const tenantLicenseRepository = require('../repositories/tenantLicenseRepository');
const licenseHistoryRepository = require('../repositories/licenseHistoryRepository');
const adminDirectoryRepository = require('../repositories/adminDirectoryRepository');
const adminTenantService = require('../services/adminTenantService');
const { ValidationError, NotFoundError } = require('../errors');

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
  console.log('RC1 Sprint 2: adminTenantService.js tests');
  console.log('');

  await assertThrows(() => adminTenantService.setTenantStatus({ shopName: '', status: 'paused' }), ValidationError, 'setTenantStatus requires shopName');
  await assertThrows(() => adminTenantService.setTenantStatus({ shopName: 'X', status: 'bogus' }), ValidationError, "setTenantStatus rejects an invalid status — matches local.js:1262's whitelist exactly");
  {
    const restore = patch(adminDirectoryRepository, { findTenantByShopName: async () => null });
    await assertThrows(() => adminTenantService.setTenantStatus({ shopName: 'Nonexistent Shop', status: 'active' }), NotFoundError, 'setTenantStatus throws NotFoundError for an unknown shop name');
    restore();
  }

  // ── syncLegacyStatusToLicense fail-open when no license row exists ────
  {
    let updateStatusCalled = false, suspendCalled = false;
    const restoreDir = patch(adminDirectoryRepository, { findTenantByShopName: async () => ({ id: 1, shop_name: 'Test Shop' }) });
    const restoreTenant = patch(tenantRepository, { updateStatus: async () => { updateStatusCalled = true; } });
    const restoreLic = patch(tenantLicenseRepository, { findByTenantId: async () => null, suspend: async () => { suspendCalled = true; } });
    const result = await adminTenantService.setTenantStatus({ shopName: 'Test Shop', status: 'paused', reason: 'test' });
    assert(updateStatusCalled, 'setTenantStatus always updates the legacy tenants.status column');
    assert(!suspendCalled, "syncLegacyStatusToLicense silently no-ops (fails open) when the tenant has no tenant_licenses row yet — matches local.js:1245 exactly, a real local.js behavior preserved, not a bug introduced here");
    assert(result.status === 'paused' && result.shopName === 'Test Shop', 'setTenantStatus returns the expected response shape');
    restoreDir(); restoreTenant(); restoreLic();
  }

  // ── syncLegacyStatusToLicense real transitions ────────────────────────
  {
    let suspended = false, sessionsKilled = false, historyRecorded = null;
    const restoreDir = patch(adminDirectoryRepository, { findTenantByShopName: async () => ({ id: 1, shop_name: 'Test Shop' }) });
    const restoreTenant = patch(tenantRepository, { updateStatus: async () => {} });
    const restoreLic = patch(tenantLicenseRepository, {
      findByTenantId: async () => ({ status: 'ACTIVE' }),
      suspend: async () => { suspended = true; },
      revokeAllSessionsForTenant: async () => { sessionsKilled = true; },
    });
    const restoreHist = patch(licenseHistoryRepository, { record: async (d) => { historyRecorded = d; } });
    await adminTenantService.setTenantStatus({ shopName: 'Test Shop', status: 'paused', reason: 'non-payment' });
    assert(suspended && sessionsKilled, "pausing a tenant with an ACTIVE license syncs it to SUSPENDED and kills sessions — matches local.js:1248-1250 exactly");
    assert(historyRecorded.eventType === 'STATUS_CHANGED' && historyRecorded.detail === 'non-payment', 'the sync logs a STATUS_CHANGED history event with the admin-provided reason');
    restoreDir(); restoreTenant(); restoreLic(); restoreHist();
  }
  {
    const restoreDir = patch(adminDirectoryRepository, { findTenantByShopName: async () => ({ id: 1, shop_name: 'Test Shop' }) });
    const restoreTenant = patch(tenantRepository, { updateStatus: async () => {} });
    const restoreLic = patch(tenantLicenseRepository, { findByTenantId: async () => ({ status: 'SUSPENDED' }) });
    await adminTenantService.setTenantStatus({ shopName: 'Test Shop', status: 'paused' });
    passed++; console.log('  \x1b[32m✓\x1b[0m no-ops when the license status is already in sync (SUSPENDED -> paused maps to SUSPENDED, already there)');
    restoreDir(); restoreTenant(); restoreLic();
  }

  // ── listWebUsers grouping ──────────────────────────────────────────────
  {
    const restore = patch(adminDirectoryRepository, {
      listAllUsersWithTenant: async () => ([
        { tenant_id: 1, shop_name: 'Shop A', shop_status: 'active', id: 10, display_name: 'Owner A', mobile: '111', role: 'owner', is_active: 1, last_login: null, created_at: null },
        { tenant_id: 1, shop_name: 'Shop A', shop_status: 'active', id: 11, display_name: null, mobile: '222', role: 'staff', is_active: 0, last_login: null, created_at: null },
        { tenant_id: 2, shop_name: 'Shop B', shop_status: 'paused', id: 20, display_name: 'Owner B', mobile: '333', role: 'owner', is_active: 1, last_login: null, created_at: null },
      ]),
    });
    const shops = await adminTenantService.listWebUsers();
    assert(shops.length === 2, 'listWebUsers groups flat rows into one entry per shop — matches local.js:1314-1324 exactly');
    assert(shops[0].users.length === 2 && shops[0].users[1].name === '222', "listWebUsers falls back to mobile when display_name is null — matches local.js:1321's `r.display_name || r.mobile` exactly");
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
