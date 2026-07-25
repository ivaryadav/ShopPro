/**
 * RC1 Sprint 2 test — services/adminUserService.js. Verifies User
 * Administration matches local.js exactly (local.js:1332-1370), reusing
 * Phase 2's unmodified userService.resetPin/setActive.
 *
 * Usage: node server/src/tests/adminUserService.test.js
 */
'use strict';

const userRepository = require('../repositories/userRepository');
const userService = require('../services/userService');
const adminUserService = require('../services/adminUserService');
const { ValidationError, NotFoundError, BusinessRuleError } = require('../errors');

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
  console.log('RC1 Sprint 2: adminUserService.js tests');
  console.log('');

  // ── resetUserPin ─────────────────────────────────────────────────────
  await assertThrows(() => adminUserService.resetUserPin(null, '123456'), ValidationError, "resetUserPin requires userId — matches local.js:1335's 400 exactly");
  await assertThrows(() => adminUserService.resetUserPin(1, ''), ValidationError, 'resetUserPin requires newPin');
  {
    const restore = patch(userRepository, { findById: async () => null });
    await assertThrows(() => adminUserService.resetUserPin(999, '123456'), NotFoundError, "resetUserPin throws NotFoundError for a nonexistent user — matches local.js:1339's 404 exactly");
    restore();
  }
  {
    let hashUpdated = false;
    const restoreRepo = patch(userRepository, { findById: async () => ({ id: 1, display_name: 'Ravi', mobile: '9999999999' }), updatePasswordHash: async () => { hashUpdated = true; } });
    const result = await adminUserService.resetUserPin(1, '123456');
    assert(hashUpdated, "resetUserPin delegates to Phase 2's unmodified userService.resetPin for hashing/persistence");
    assert(result.name === 'Ravi' && result.mobile === '9999999999', 'resetUserPin returns {userId, name, mobile} matching local.js:1343 exactly');
    restoreRepo();
  }
  {
    const restore = patch(userRepository, { findById: async () => ({ id: 1, display_name: null, mobile: '9999999999' }), updatePasswordHash: async () => {} });
    const result = await adminUserService.resetUserPin(1, '123456');
    assert(result.name === '9999999999', "resetUserPin falls back to mobile when display_name is null — matches local.js:1343's `user.display_name || user.mobile` exactly");
    restore();
  }
  {
    const restore = patch(userRepository, { findById: async () => ({ id: 1, display_name: 'Ravi', mobile: '9999999999' }) });
    await assertThrows(() => adminUserService.resetUserPin(1, '1234'), ValidationError, "resetUserPin still enforces Phase 2's exact-6-digit PIN rule (unmodified userService.resetPin) — a 4-digit PIN is rejected");
    restore();
  }

  // ── toggleUser ───────────────────────────────────────────────────────
  await assertThrows(() => adminUserService.toggleUser(undefined, true), ValidationError, 'toggleUser requires userId');
  await assertThrows(() => adminUserService.toggleUser(1, undefined), ValidationError, 'toggleUser requires active');
  {
    const restore = patch(userRepository, { findById: async () => null });
    await assertThrows(() => adminUserService.toggleUser(999, false), NotFoundError, 'toggleUser throws NotFoundError for a nonexistent user');
    restore();
  }
  {
    const restoreRepo = patch(userRepository, {
      findById: async () => ({ id: 1, tenant_id: 1, display_name: 'Owner', mobile: '9999999999', role: 'owner' }),
      countActiveOwners: async () => 1,
    });
    await assertThrows(() => adminUserService.toggleUser(1, false), BusinessRuleError, "toggleUser still enforces Phase 2's unmodified last-active-owner protection exactly");
    restoreRepo();
  }
  {
    const restore = patch(userRepository, {
      findById: async () => ({ id: 1, tenant_id: 1, display_name: 'Staff Member', mobile: '8888888888', role: 'staff' }),
      setActive: async () => {},
    });
    const result = await adminUserService.toggleUser(1, false);
    assert(result.name === 'Staff Member' && result.isActive === false, 'toggleUser returns {userId, name, isActive} matching local.js:1365 exactly');
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
