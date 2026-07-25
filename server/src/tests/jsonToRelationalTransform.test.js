/**
 * Phase 6 test — migrationTools/jsonToRelational/transform.js and
 * validationService.js. Pure functions, no database needed.
 *
 * Usage: node server/src/tests/jsonToRelationalTransform.test.js
 */
'use strict';

const transform = require('../migrationTools/jsonToRelational/transform');
const { validateBlobStructure, expectedCounts, verifyIntegrity } = require('../migrationTools/jsonToRelational/validationService');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function main() {
  console.log('Phase 6: jsonToRelational transform/validation tests');
  console.log('');

  // ── mapInventoryItem ────────────────────────────────────────────────
  {
    const m = transform.mapInventoryItem({ id: 5, name: 'Phone', costPrice: 100, sellPrice: 200, stock: 3, minStock: 1, unit: 'pcs' });
    assert(m.costPrice === 100 && m.sellPrice === 200 && m.stock === 3, 'mapInventoryItem maps price/stock fields correctly');
  }
  {
    const m = transform.mapInventoryItem({ id: 6, name: 'Blank Item' });
    assert(m.costPrice === 0 && m.minStock === 2 && m.unit === 'pcs', 'mapInventoryItem applies sane defaults for missing optional fields');
  }

  // ── mapCustomer — dead fields dropped ──────────────────────────────
  {
    const m = transform.mapCustomer({ id: 1, name: 'Alice', phone: '9876543210', balance: 500, loyaltyPoints: 10 });
    assert(m.balance === undefined && m.loyaltyPoints === undefined, 'mapCustomer drops dead balance/loyaltyPoints fields, not carrying them into the normalized schema');
  }

  // ── mapSale — unresolvable customer is reported, not silently guessed ──
  {
    const productMap = new Map([[1, 101]]);
    const customerMap = new Map(); // empty — customer 5 doesn't resolve
    const result = transform.mapSale({ id: 1, customerId: 5, items: [{ productId: 1, name: 'X', qty: 2, price: 50 }], total: 100 }, productMap, customerMap, []);
    assert(result === null, 'mapSale returns null (not a fabricated row) when its customerId does not resolve');
  }
  {
    const productMap = new Map([[1, 101]]);
    const customerMap = new Map([[5, 501]]);
    const result = transform.mapSale({ id: 1, customerId: 5, invoiceNo: 'INV-001', items: [{ productId: 1, name: 'X', qty: 2, price: 50 }], discount: 10, payments: [{ method: 'Cash', amount: 90, date: '2026-01-01' }] }, productMap, customerMap, []);
    assert(result.sale.customerId === 501 && result.sale.subtotal === 100 && result.sale.total === 90, 'mapSale resolves customer id, recomputes subtotal from items, applies discount');
    assert(result.payments.length === 1 && result.payments[0].amount === 90, 'mapSale carries forward real payment entries');
  }

  // ── mapRepair — advance payment synthesized, not lost ──────────────
  {
    const customerMap = new Map([[1, 101]]);
    const result = transform.mapRepair({
      id: 1, customerId: 1, device: 'Phone', issue: 'Screen', status: 'Delivered',
      advanceAmount: 500, advanceMethod: 'UPI', received: '2026-01-01',
      payments: [{ method: 'Cash', amount: 300, date: '2026-01-05' }],
    }, new Map(), customerMap, []);
    assert(result.payments.length === 2, "mapRepair synthesizes the advance payment IN ADDITION to real payments[] entries — local.js's own saveJob never pushes the advance into r.payments, so a naive migration would silently lose it");
    assert(result.payments[0].method === 'UPI' && result.payments[0].amount === 500, 'the synthesized advance payment carries the correct method/amount');
  }
  {
    const customerMap = new Map(); // unresolvable
    const result = transform.mapRepair({ id: 2, customerId: 99, device: 'X', issue: 'Y', received: '2026-01-01' }, new Map(), customerMap, []);
    assert(result === null, 'mapRepair returns null when its customerId does not resolve');
  }

  // ── resolveCreatedBy ────────────────────────────────────────────────
  {
    const users = [{ id: 7, display_name: 'Ravi Kumar', username: '9999999999' }];
    assert(transform.resolveCreatedBy('Ravi Kumar', users) === 7, 'resolveCreatedBy matches by display_name');
    assert(transform.resolveCreatedBy('Someone Else', users) === null, 'resolveCreatedBy returns null (not a guess) when no user matches');
    assert(transform.resolveCreatedBy(null, users) === null, 'resolveCreatedBy returns null for a missing name');
  }

  // ── validateBlobStructure ───────────────────────────────────────────
  {
    const bad = validateBlobStructure({ inventory: 'not-an-array' });
    assert(!bad.ok && bad.errors.length > 0, 'validateBlobStructure rejects a non-array inventory field');
  }
  {
    const good = validateBlobStructure({ inventory: [], customers: [], sales: [{ id: 1, items: [] }], repairs: [] });
    assert(good.ok, 'validateBlobStructure accepts a well-formed (if minimal) blob');
  }

  // ── expectedCounts / verifyIntegrity ────────────────────────────────
  {
    const blob = { sales: [{ id: 1, total: 100 }, { id: 2, total: 50 }], expenses: [{ amount: 30 }] };
    const counts = expectedCounts(blob, { skippedSales: [2], skippedRepairs: [] });
    assert(counts.sales === 1 && counts.totalSalesAmount === 100, 'expectedCounts excludes skipped sales from both the row count and the total-amount reconciliation figure');
  }
  {
    const check = verifyIntegrity({ inventory: 5, totalSalesAmount: 100.001 }, { inventory: 5, totalSalesAmount: 100.0009 });
    assert(check.ok, 'verifyIntegrity tolerates sub-cent floating-point drift on amount fields');
  }
  {
    const check = verifyIntegrity({ inventory: 5 }, { inventory: 4 });
    assert(!check.ok && check.mismatches.length === 1, 'verifyIntegrity reports a real count mismatch');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main();
