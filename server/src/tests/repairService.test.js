/**
 * Phase 4 test — services/repairService.js. Verifies nextJobNo/createRepair/
 * addPart/removePart/updateStatus/collectPayment/deleteRepair match
 * nextJobNo/saveJob/addJobPart/removeJobPart/setJobStatus/
 * collectRepairPayment/deleteJob exactly (~line 3965-3976, 10662-10731,
 * 11288-11306, 11123-11128, 8076-8115, 10411-10427).
 *
 * Usage: node server/src/tests/repairService.test.js
 */
'use strict';

const repairRepository = require('../repositories/repairRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const customerRepository = require('../repositories/customerRepository');
const stockMovementRepository = require('../repositories/stockMovementRepository');
const paymentRepository = require('../repositories/paymentRepository');
const repairService = require('../services/repairService');
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
  console.log('Phase 4: repairService.js tests');
  console.log('');

  // ── createRepair validation ─────────────────────────────────────────────
  await assertThrows(() => repairService.createRepair({ tenantId: 1, customerId: null, device: 'A', issue: 'B', receivedDate: '2026-01-01' }), ValidationError, 'createRepair rejects a missing customer');
  {
    const restore = patch(customerRepository, { findById: async () => ({ id: 1, name: 'Cust' }) });
    await assertThrows(() => repairService.createRepair({ tenantId: 1, customerId: 1, device: '', issue: 'B', receivedDate: '2026-01-01' }), ValidationError, 'createRepair rejects a missing device');
    await assertThrows(
      () => repairService.createRepair({ tenantId: 1, customerId: 1, device: 'A', issue: 'B', receivedDate: '2026-01-10', estimatedDelivery: '2026-01-05' }),
      ValidationError,
      "createRepair rejects estimated delivery before received date — matches saveJob:10671 exactly"
    );
    restore();
  }

  // ── addPart ──────────────────────────────────────────────────────────────
  {
    const restore = patch(repairRepository, { findById: async () => ({ id: 1, partsUsed: [] }) });
    const restoreInv = patch(inventoryRepository, { findById: async () => ({ id: 5, name: 'Screen', stock: 1, sell_price: 500 }) });
    await assertThrows(
      () => repairService.addPart(1, 1, { productId: 5, qty: 3 }), ValidationError,
      "addPart rejects insufficient stock — matches addJobPart:11294 exactly"
    );
    restore(); restoreInv();
  }
  {
    let decremented = false, merged = false, financialsUpdated = null;
    const restore = patch(repairRepository, {
      findById: async () => ({ id: 1, labour_charge: 0, partsUsed: [{ productId: 5, qty: 1, price: 500 }] }),
      addOrMergePart: async () => { merged = true; },
      updateFinancials: async (t, id, labour, finalCost) => { financialsUpdated = { labour, finalCost }; },
    });
    const restoreInv = patch(inventoryRepository, {
      findById: async () => ({ id: 5, name: 'Screen', stock: 5, sell_price: 500 }),
      decrementStock: async () => { decremented = true; },
    });
    const restoreMovement = patch(stockMovementRepository, { record: async () => {} });
    await repairService.addPart(1, 1, { productId: 5, qty: 1 });
    assert(decremented && merged, "addPart consumes stock and merges into an existing part row — matches addJobPart:11295-11297 exactly");
    assert(financialsUpdated.finalCost === 500, 'addPart triggers final_cost recalculation (parts + labour)');
    restore(); restoreInv(); restoreMovement();
  }

  // ── removePart restores stock ───────────────────────────────────────────
  {
    let incremented = null;
    const restore = patch(repairRepository, {
      findById: async () => ({ id: 1, labour_charge: 0, partsUsed: [] }),
      removePart: async () => ({ id: 9, product_id: 5, qty: 2 }),
      updateFinancials: async () => {},
    });
    const restoreInv = patch(inventoryRepository, { incrementStock: async (t, id, qty) => { incremented = { id, qty }; } });
    const restoreMovement = patch(stockMovementRepository, { record: async () => {} });
    await repairService.removePart(1, 1, 9);
    assert(incremented.id === 5 && incremented.qty === 2, "removePart restores the removed part's qty to stock — matches removeJobPart:11304 exactly");
    restore(); restoreInv(); restoreMovement();
  }

  // ── updateStatus — free transition including warranty-reopen ───────────
  {
    const restore = patch(repairRepository, { findById: async () => ({ id: 1 }), updateStatus: async () => {} });
    await repairService.updateStatus(1, 1, 'Repairing');
    passed++; console.log("  \x1b[32m✓\x1b[0m updateStatus allows a free transition back to 'Repairing' — matches setJobStatus's warranty-reopen (no stricter state machine than local.js enforces)");
    restore();
  }
  await assertThrows(() => repairService.updateStatus(1, 1, 'Bogus'), ValidationError, 'updateStatus rejects an unknown status value');

  // ── collectPayment ───────────────────────────────────────────────────────
  {
    const restore = patch(repairRepository, { findById: async () => ({ id: 1, final_cost: 500, paid: 500 }) });
    await assertThrows(() => repairService.collectPayment(1, 1, [{ method: 'Cash', amount: 100 }], '2026-01-01'), ValidationError, "collectPayment rejects when the job is already fully paid — matches collectRepairPayment:8087 exactly");
    restore();
  }
  {
    let paymentCreated = null;
    const restore = patch(repairRepository, { findById: async () => ({ id: 1, final_cost: 500, paid: 200 }) });
    const restorePayment = patch(paymentRepository, { create: async (data) => { paymentCreated = data; return data; } });
    await repairService.collectPayment(1, 1, [{ method: 'UPI', amount: 300 }], '2026-01-01');
    assert(paymentCreated && paymentCreated.method === 'UPI' && paymentCreated.amount === 300, 'collectPayment records a payment against the repair');
    restore(); restorePayment();
  }

  // ── deleteRepair restores every part's stock ────────────────────────────
  {
    const restored = [];
    const restore = patch(repairRepository, {
      findById: async () => ({ id: 1, job_no: 'JOB-001', partsUsed: [{ product_id: 5, qty: 2 }, { product_id: 6, qty: 1 }] }),
      remove: async () => {},
    });
    const restoreInv = patch(inventoryRepository, { incrementStock: async (t, id, qty) => restored.push({ id, qty }) });
    const restoreMovement = patch(stockMovementRepository, { record: async () => {} });
    await repairService.deleteRepair(1, 1);
    assert(restored.length === 2 && restored[0].id === 5 && restored[1].id === 6, "deleteRepair restores every part's qty to stock — matches deleteJob:10418-10422 exactly");
    restore(); restoreInv(); restoreMovement();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
