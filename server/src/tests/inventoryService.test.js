/**
 * Phase 4 test — services/inventoryService.js. Verifies createProduct/
 * updateProduct/adjustStock/deleteProduct match app/ShopERP_Pro_v8.html's
 * saveProduct/updateProduct/doAdjustStock/deleteProduct exactly (~line
 * 9057-9161). No live database needed — repositories are monkey-patched.
 *
 * Usage: node server/src/tests/inventoryService.test.js
 */
'use strict';

const inventoryRepository = require('../repositories/inventoryRepository');
const stockMovementRepository = require('../repositories/stockMovementRepository');
const inventoryService = require('../services/inventoryService');
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
  console.log('Phase 4: inventoryService.js tests');
  console.log('');

  await assertThrows(
    () => inventoryService.createProduct({ tenantId: 1, name: '', sellPrice: 100 }), ValidationError,
    'createProduct rejects a missing name'
  );
  await assertThrows(
    () => inventoryService.createProduct({ tenantId: 1, name: 'Phone', costPrice: 200, sellPrice: 100 }), ValidationError,
    "createProduct rejects sellPrice < costPrice — matches saveProduct's check exactly (~line 9065)"
  );
  await assertThrows(
    () => inventoryService.createProduct({ tenantId: 1, name: 'Phone', sellPrice: 100, imei: '12345' }), ValidationError,
    'createProduct rejects a non-15-digit IMEI'
  );
  {
    const restore = patch(inventoryRepository, { findByImei: async () => ({ id: 9, name: 'Existing Phone' }) });
    await assertThrows(
      () => inventoryService.createProduct({ tenantId: 1, name: 'Phone', sellPrice: 100, imei: '123456789012345' }), ConflictError,
      "createProduct rejects a duplicate IMEI — matches saveProduct:9069 exactly"
    );
    restore();
  }
  {
    const restore = patch(inventoryRepository, {
      findByImei: async () => null,
      create: async (data) => ({ id: 7, sku: data.sku || null, ...data }),
      setSku: async (t, id, sku) => ({ id, sku }),
    });
    const product = await inventoryService.createProduct({ tenantId: 1, name: 'Phone', sellPrice: 100 });
    assert(product.sku === 'PRD-007', "createProduct auto-generates SKU 'PRD-XXX' when blank, matching saveProduct:9073's fallback shape");
    restore();
  }

  // ── updateProduct ──────────────────────────────────────────────────────
  {
    const restore = patch(inventoryRepository, {
      findById: async () => ({ id: 3, name: 'Old', category: 'Accessory', sku: 'PRD-003', imei: null, cost_price: 50, sell_price: 100, stock: 10, min_stock: 2 }),
      findByImei: async () => null,
      update: async (t, id, data) => ({ id, ...data }),
    });
    await assertThrows(
      () => inventoryService.updateProduct(1, 3, { sellPrice: 40 }), ValidationError,
      "updateProduct rejects sellPrice < costPrice — matches updateProduct:9114 exactly"
    );
    restore();
  }

  // ── adjustStock ────────────────────────────────────────────────────────
  await assertThrows(() => inventoryService.adjustStock(1, 1, { type: 'add', qty: 0 }), ValidationError, 'adjustStock rejects qty <= 0');
  {
    const restore = patch(inventoryRepository, {
      findById: async () => ({ id: 1, stock: 10, name: 'X' }),
      setStock: async () => {},
    });
    const restoreMovement = patch(stockMovementRepository, { record: async () => {} });
    const updated = await inventoryService.adjustStock(1, 1, { type: 'remove', qty: 15 });
    assert(updated.stock === 10, 'adjustStock clamps "remove" at 0 — matches doAdjustStock:9150 exactly (Math.max(0, prev-qty))');
    restore(); restoreMovement();
  }

  // ── deleteProduct ──────────────────────────────────────────────────────
  {
    const restore = patch(inventoryRepository, { findById: async () => null });
    await assertThrows(() => inventoryService.deleteProduct(1, 999), NotFoundError, 'deleteProduct throws NotFoundError for a nonexistent product');
    restore();
  }
  {
    let removed = false;
    const restore = patch(inventoryRepository, {
      findById: async () => ({ id: 1, stock: 5, name: 'X' }),
      remove: async () => { removed = true; },
    });
    const restoreMovement = patch(stockMovementRepository, { record: async () => {} });
    await inventoryService.deleteProduct(1, 1, 42);
    assert(removed, "deleteProduct hard-deletes unconditionally — matches deleteProduct:9160 exactly (no soft-delete, reversing Phase 3's unapproved is_deleted proposal)");
    restore(); restoreMovement();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
