/**
 * Phase 4 test — services/paymentService.js. Verifies the per-context
 * method restriction (buildPaymentUI ~line 7714 vs. addCashEntry ~line
 * 16747) and manual cash-entry validation (saveCashEntry ~line 16752-16764).
 *
 * Usage: node server/src/tests/paymentService.test.js
 */
'use strict';

const paymentRepository = require('../repositories/paymentRepository');
const paymentService = require('../services/paymentService');
const { ValidationError } = require('../errors');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function assertThrowsSync(fn, ErrorClass, label) {
  try {
    fn();
    failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label + ' (did not throw)');
  } catch (e) {
    if (e instanceof ErrorClass) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
    else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${label} (got ${e.constructor.name}: ${e.message})`); }
  }
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
  console.log('Phase 4: paymentService.js tests');
  console.log('');

  assertThrowsSync(
    () => paymentService.validateCollectionPayments([{ method: 'Bank Transfer', amount: 100 }], 100), ValidationError,
    "validateCollectionPayments rejects Bank Transfer — sale/repair collection only allows Cash/UPI/Card (buildPaymentUI:7714)"
  );
  assertThrowsSync(
    () => paymentService.validateCollectionPayments([{ method: 'Cash', amount: 150 }], 100), ValidationError,
    'validateCollectionPayments rejects a payment sum exceeding the total (documented simplification, not local.js\'s silent full-cash fallback)'
  );
  {
    const filtered = paymentService.validateCollectionPayments([{ method: 'Cash', amount: 60 }, { method: 'UPI', amount: 0 }], 100);
    assert(filtered.length === 1 && filtered[0].method === 'Cash', 'validateCollectionPayments filters out zero-amount entries');
  }

  await assertThrows(() => paymentService.createManualEntry({ tenantId: 1, amount: 0, description: 'x', method: 'Cash' }), ValidationError, "createManualEntry rejects amount 0 — matches saveCashEntry:16755 exactly");
  await assertThrows(() => paymentService.createManualEntry({ tenantId: 1, amount: 100, description: '', method: 'Cash' }), ValidationError, 'createManualEntry rejects a missing description');
  {
    const restore = patch(paymentRepository, { create: async (data) => data });
    const entry = await paymentService.createManualEntry({ tenantId: 1, amount: 500, description: 'Owner deposit', method: 'Bank Transfer', direction: 'in', paymentDate: '2026-01-01' });
    assert(entry.method === 'Bank Transfer', "createManualEntry allows Bank Transfer for manual entries — matches addCashEntry:16747's 4th method exactly");
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
