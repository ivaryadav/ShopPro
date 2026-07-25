/**
 * Phase 4 test — services/customerService.js. Verifies createCustomer/
 * updateCustomer match saveCustomer/doEditCustomer exactly (~line
 * 11766-11833), INCLUDING the real, pre-existing warn-vs-block phone-
 * duplicate inconsistency reproduced via the explicit `allowDuplicate` param.
 *
 * Usage: node server/src/tests/customerService.test.js
 */
'use strict';

const customerRepository = require('../repositories/customerRepository');
const customerService = require('../services/customerService');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');

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
  console.log('Phase 4: customerService.js tests');
  console.log('');

  await assertThrows(() => customerService.createCustomer({ tenantId: 1, name: '', phone: '9876543210' }), ValidationError, 'createCustomer rejects a missing name');
  await assertThrows(() => customerService.createCustomer({ tenantId: 1, name: 'A', phone: '123' }), ValidationError, "createCustomer rejects a non-10-digit phone — matches validatePhone exactly");
  await assertThrows(() => customerService.createCustomer({ tenantId: 1, name: 'A', phone: '9876543210', email: 'not-an-email' }), ValidationError, 'createCustomer rejects an invalid email');

  {
    const restore = patch(customerRepository, { findByPhone: async () => ({ id: 5, name: 'Existing' }) });
    await assertThrows(
      () => customerService.createCustomer({ tenantId: 1, name: 'A', phone: '9876543210' }), ConflictError,
      "createCustomer hard-blocks a duplicate phone by default — matches quick-add's isPhoneDuplicate hard block (~line 10166-10168)"
    );
    restore();
  }
  {
    const restore = patch(customerRepository, {
      findByPhone: async () => ({ id: 5, name: 'Existing' }),
      create: async (data) => ({ id: 10, ...data }),
    });
    const customer = await customerService.createCustomer({ tenantId: 1, name: 'A', phone: '9876543210', allowDuplicate: true });
    assert(customer.id === 10, "createCustomer allows a duplicate phone when allowDuplicate=true — reproduces saveCustomer's confirm()-then-proceed path (~line 11772)");
    restore();
  }

  // ── updateCustomer ─────────────────────────────────────────────────────
  {
    const restore = patch(customerRepository, { findById: async () => null });
    await assertThrows(() => customerService.updateCustomer(1, 999, { name: 'A', phone: '9876543210' }), NotFoundError, 'updateCustomer throws NotFoundError for a nonexistent customer');
    restore();
  }
  {
    const restore = patch(customerRepository, {
      findById: async () => ({ id: 3, name: 'Old', phone: '9876543210' }),
      findByPhone: async () => null,
      update: async (t, id, data) => ({ id, ...data }),
    });
    const customer = await customerService.updateCustomer(1, 3, { name: 'New Name', phone: '9876543210' });
    assert(customer.name === 'New Name', 'updateCustomer succeeds with valid input');
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
