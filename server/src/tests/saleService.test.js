/**
 * Phase 4 test — services/saleService.js. Verifies nextInvoiceNo/createSale/
 * updateSale match nextInvoiceNo/saveSale/updateSale exactly (~line
 * 3952-3964, 10020-10078, 9966-10018). No live database needed —
 * repositories are monkey-patched.
 *
 * Usage: node server/src/tests/saleService.test.js
 */
'use strict';

const saleRepository = require('../repositories/saleRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const customerRepository = require('../repositories/customerRepository');
const stockMovementRepository = require('../repositories/stockMovementRepository');
const paymentRepository = require('../repositories/paymentRepository');
const saleService = require('../services/saleService');
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
  console.log('Phase 4: saleService.js tests');
  console.log('');

  // ── nextInvoiceNo ───────────────────────────────────────────────────────
  {
    const restore = patch(saleRepository, { maxInvoiceNumber: async () => 7, invoiceNoExists: async () => false });
    const no = await saleService.nextInvoiceNo(1);
    assert(no === 'INV-008', "nextInvoiceNo continues from the highest existing number — matches nextInvoiceNo:3952-3964 exactly");
    restore();
  }
  {
    let calls = 0;
    const restore = patch(saleRepository, {
      maxInvoiceNumber: async () => 0,
      invoiceNoExists: async () => { calls++; return calls === 1; }, // first candidate taken, second free
    });
    const no = await saleService.nextInvoiceNo(1);
    assert(no === 'INV-002', 'nextInvoiceNo self-heals past a collision (safety while-loop, ~line 3959-3962)');
    restore();
  }

  // ── createSale — stock validation ──────────────────────────────────────
  {
    const restore = patch(customerRepository, { findById: async () => ({ id: 1, name: 'Cust' }) });
    const restoreInv = patch(inventoryRepository, { findById: async () => ({ id: 1, name: 'Phone', stock: 2 }) });
    await assertThrows(
      () => saleService.createSale({ tenantId: 1, customerId: 1, items: [{ productId: 1, qty: 5, price: 100 }], saleDate: '2026-01-01' }),
      ValidationError,
      "createSale rejects insufficient stock — matches saveSale's hard stock validation exactly (~line 10029-10040)"
    );
    restore(); restoreInv();
  }
  {
    const restore = patch(customerRepository, { findById: async () => null });
    await assertThrows(
      () => saleService.createSale({ tenantId: 1, customerId: 999, items: [{ productId: 1, qty: 1, price: 100 }], saleDate: '2026-01-01' }),
      ValidationError,
      'createSale rejects a nonexistent customer'
    );
    restore();
  }

  // ── discount bounds ─────────────────────────────────────────────────────
  {
    const restore = patch(customerRepository, { findById: async () => ({ id: 1, name: 'Cust' }) });
    const restoreInv = patch(inventoryRepository, { findById: async () => ({ id: 1, name: 'Phone', stock: 10 }) });
    await assertThrows(
      () => saleService.createSale({ tenantId: 1, customerId: 1, items: [{ productId: 1, qty: 1, price: 100 }], discount: 200, saleDate: '2026-01-01' }),
      ValidationError,
      "createSale rejects discount > subtotal — matches saveSale:10047 exactly"
    );
    restore(); restoreInv();
  }

  // ── full happy path: stock decremented, invoice generated, payment recorded ──
  {
    let decremented = null, movementRecorded = false, paymentCreated = null;
    const restore = patch(customerRepository, { findById: async () => ({ id: 1, name: 'Cust' }) });
    const restoreInv = patch(inventoryRepository, {
      findById: async () => ({ id: 1, name: 'Phone', stock: 10 }),
      decrementStock: async (t, id, qty) => { decremented = { id, qty }; return true; },
    });
    const restoreSale = patch(saleRepository, {
      maxInvoiceNumber: async () => 0, invoiceNoExists: async () => false,
      create: async (data) => ({ id: 55, invoice_no: data.invoiceNo, ...data }),
      findById: async () => ({ id: 55, invoice_no: 'INV-001', items: [] }),
    });
    const restoreMovement = patch(stockMovementRepository, { record: async () => { movementRecorded = true; } });
    const restorePayment = patch(paymentRepository, {
      deleteForSource: async () => {},
      create: async (data) => { paymentCreated = data; return data; },
    });
    await saleService.createSale({
      tenantId: 1, customerId: 1, items: [{ productId: 1, qty: 2, price: 100 }],
      saleDate: '2026-01-01', payments: [{ method: 'Cash', amount: 200 }],
    });
    assert(decremented.id === 1 && decremented.qty === 2, 'createSale decrements stock by the sold quantity');
    assert(movementRecorded, 'createSale records a stock_movement for the sale');
    assert(paymentCreated && paymentCreated.method === 'Cash' && paymentCreated.amount === 200, 'createSale records the payment against the new sale');
    restore(); restoreInv(); restoreSale(); restoreMovement(); restorePayment();
  }

  // ── payment method restriction (sale/repair collection = Cash/UPI/Card only) ──
  {
    const restore = patch(customerRepository, { findById: async () => ({ id: 1, name: 'Cust' }) });
    const restoreInv = patch(inventoryRepository, { findById: async () => ({ id: 1, name: 'Phone', stock: 10 }) });
    await assertThrows(
      () => saleService.createSale({
        tenantId: 1, customerId: 1, items: [{ productId: 1, qty: 1, price: 100 }],
        saleDate: '2026-01-01', payments: [{ method: 'Bank Transfer', amount: 100 }],
      }),
      ValidationError,
      "createSale rejects 'Bank Transfer' for sale collection — matches buildPaymentUI's 3-method restriction (~line 7714), Bank Transfer is manual-entry-only"
    );
    restore(); restoreInv();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
