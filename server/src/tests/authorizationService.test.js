/**
 * Phase 2 test — services/authorizationService.js. Verifies the
 * table-driven permission model reproduces local.js's 3 real
 * `role !== 'owner'` gates exactly (docs/adr/0006-table-driven-authorization.md)
 * — no live database needed; permissionRepository is monkey-patched with a
 * fake in-memory table (restored after each assertion group), a
 * dependency-free substitute for a mocking library, matching this
 * project's established "no new npm dependency for something this small"
 * convention (see server/src/config/env.js's header for the same posture).
 *
 * Usage: node server/src/tests/authorizationService.test.js
 */
'use strict';

const permissionRepository = require('../repositories/permissionRepository');
const authorizationService = require('../services/authorizationService');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Phase 2: authorizationService.js tests');
  console.log('');

  const original = permissionRepository.findPermissionCodesForRole;
  // Fake table matching migrations/001_identity_tenant_core.sql's seed
  // exactly: owner has all 3 in-scope gates, staff has none.
  const FAKE_TABLE = { owner: ['sessions:view', 'sessions:revoke', 'staff:add'], staff: [] };
  permissionRepository.findPermissionCodesForRole = async (roleCode) => FAKE_TABLE[roleCode] || [];

  try {
    assert(await authorizationService.hasPermission('owner', 'sessions:view') === true, "owner has 'sessions:view' — matches local.js:1069's `role !== 'owner'` outcome");
    assert(await authorizationService.hasPermission('owner', 'sessions:revoke') === true, "owner has 'sessions:revoke' — matches local.js:1075");
    assert(await authorizationService.hasPermission('owner', 'staff:add') === true, "owner has 'staff:add' — matches local.js:1085");
    assert(await authorizationService.hasPermission('staff', 'sessions:view') === false, "staff does NOT have 'sessions:view' — matches local.js's hardcoded rejection");
    assert(await authorizationService.hasPermission('staff', 'sessions:revoke') === false, "staff does NOT have 'sessions:revoke'");
    assert(await authorizationService.hasPermission('staff', 'staff:add') === false, "staff does NOT have 'staff:add'");
    assert(await authorizationService.hasPermission('staff', 'users:view') === false, "an unseeded permission code ('users:view' — GET /api/data/users has NO gate in local.js, so nothing is seeded for it) correctly returns false for everyone, not a crash");
    assert(await authorizationService.hasPermission('owner', 'users:view') === false, "same unseeded-permission check for owner — false is the safe default, not an accidental grant");
  } finally {
    permissionRepository.findPermissionCodesForRole = original;
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
