/**
 * Phase 2 test — services/userService.js. Verifies addStaff/resetPin/
 * setActive match local.js exactly (local.js:1084-1112, 1333-1348,
 * 1351-1370), INCLUDING the real, pre-existing PIN-format inconsistency
 * between addStaff (4-6 digits) and resetPin (exactly 6) — preserved, not
 * "fixed". No live database needed — repositories are monkey-patched.
 *
 * Usage: node server/src/tests/userService.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const userService = require('../services/userService');
const { ValidationError, ConflictError, BusinessRuleError, NotFoundError } = require('../errors');

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
  console.log('Phase 2: userService.js tests');
  console.log('');

  // ── addStaff ────────────────────────────────────────────────────────────
  {
    const restore = patch(userRepository, {
      findAnyByMobile: async () => null,
      create: async (data) => ({ id: 5, display_name: data.displayName || data.mobile, role: 'staff' }),
    });
    const restoreRole = patch(roleRepository, { findByCode: async (code) => ({ id: 2, code, label: code }) });
    const result = await userService.addStaff({ tenantId: 1, mobile: '9876543210', pin: '1234', displayName: 'New Staff' });
    assert(result.id === 5 && result.role === 'staff', 'addStaff succeeds with valid input, matching local.js:1105\'s response shape');
    restore(); restoreRole();
  }

  await assertThrows(
    () => userService.addStaff({ tenantId: 1, mobile: '', pin: '1234' }), ValidationError,
    'addStaff rejects a missing mobile number'
  );
  await assertThrows(
    () => userService.addStaff({ tenantId: 1, mobile: '9876543210', pin: '123' }), ValidationError,
    "addStaff rejects a 3-digit PIN (must be 4-6 digits, matching local.js:1093's /^\\d{4,6}$/)"
  );
  {
    const restore = patch(userRepository, {
      findAnyByMobile: async () => null,
    });
    // 7 digits should also be rejected (still testing addStaff's 4-6 rule)
    await assertThrows(
      () => userService.addStaff({ tenantId: 1, mobile: '9876543210', pin: '1234567' }), ValidationError,
      'addStaff rejects a 7-digit PIN'
    );
    restore();
  }
  {
    const restore = patch(userRepository, { findAnyByMobile: async () => ({ id: 99 }) });
    await assertThrows(
      () => userService.addStaff({ tenantId: 1, mobile: '9876543210', pin: '1234' }), ConflictError,
      "addStaff rejects an already-registered mobile number — matches local.js:1098's 409, and NOTE: this check is NOT scoped to is_active (matching local.js's own duplicate check exactly)"
    );
    restore();
  }

  // ── resetPin — deliberately DIFFERENT PIN rule than addStaff (exactly 6 digits) ──
  await assertThrows(
    () => userService.resetPin(1, '1234'), ValidationError,
    "resetPin rejects a 4-digit PIN — local.js:1336's /^\\d{6}$/ requires EXACTLY 6, unlike addStaff's 4-6 range. This inconsistency is real and preserved, not fixed."
  );
  {
    let savedHash = null;
    const restore = patch(userRepository, { updatePasswordHash: async (id, hash) => { savedHash = hash; } });
    await userService.resetPin(1, '123456');
    assert(savedHash && bcrypt.compareSync('123456', savedHash), 'resetPin accepts exactly 6 digits and stores a real bcrypt hash of it');
    restore();
  }

  // ── setActive — last-active-owner protection ──────────────────────────────
  {
    const restore = patch(userRepository, {
      findById: async () => ({ id: 1, tenant_id: 1, role: 'owner' }),
      countActiveOwners: async () => 1,
      setActive: async () => { throw new Error('should not be called — must be blocked before this'); },
    });
    await assertThrows(
      () => userService.setActive(1, false), BusinessRuleError,
      'setActive refuses to deactivate the ONLY active owner of a tenant — matches local.js:1357-1360 exactly'
    );
    restore();
  }
  {
    const restore = patch(userRepository, {
      findById: async () => ({ id: 1, tenant_id: 1, role: 'owner' }),
      countActiveOwners: async () => 2,
      setActive: async () => {},
    });
    await userService.setActive(1, false);
    passed++; console.log('  \x1b[32m✓\x1b[0m setActive allows deactivating an owner when a second active owner still exists');
    restore();
  }
  {
    const restore = patch(userRepository, { findById: async () => null });
    await assertThrows(() => userService.setActive(999, false), NotFoundError, 'setActive throws NotFoundError for a nonexistent user');
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
