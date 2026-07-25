/**
 * Phase 4 integration test — the full Operations Domain stack (migration
 * -> repositories -> services) against a REAL MariaDB, end to end:
 * product creation, a sale that decrements stock, a repair job that
 * consumes and then restores a part, and a recurring expense application.
 *
 * Same honest-skip pattern as identityCore.integration.test.js (Phase 2) —
 * attempts a real connection first, skips with a clear message if none is
 * reachable/authenticated, never fakes a pass. Every business-logic claim
 * this would otherwise verify is already exercised, repository-mocked, in
 * the other server/src/tests/*Service.test.js files.
 *
 * Usage: node server/src/tests/operationsCore.integration.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests } = require('../database');
const tenantRepository = require('../repositories/tenantRepository');
const roleRepository = require('../repositories/roleRepository');
const userRepository = require('../repositories/userRepository');
const inventoryService = require('../services/inventoryService');
const customerService = require('../services/customerService');
const saleService = require('../services/saleService');
const repairService = require('../services/repairService');
const recurringExpenseService = require('../services/recurringExpenseService');
const settingsService = require('../services/settingsService');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function skip(label, reason) {
  skipped++;
  console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason);
}

// Phase 6: env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME) so this can
// run against a real, credentialed instance — same defaults as before
// (root/no-password/3306) when unset, preserving the honest-skip behavior.
const TEST_DB_CONFIG = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_phase4_test',
};

async function main() {
  console.log('Phase 4 integration test: full Operations Domain stack against real MariaDB');
  console.log('');

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);

  if (!health.ok) {
    for (const label of [
      'migrateUp() applies the operations-domain schema',
      'a product can be created, sold (stock decrements), and the invoice number is sequential',
      'a repair job can consume a part (stock decrements) and be deleted (stock restores)',
      'a recurring expense applies exactly once per month',
    ]) {
      skip(label, `no reachable/authenticated database: ${health.error}`);
    }
    console.log(
      '\n  Note: same honest-skip situation as Phase 2\'s identityCore.integration.test.js — a\n' +
      '  MySQL/MariaDB server is running on this machine but this session has no credentials\n' +
      '  to it and did not attempt to bypass another user\'s pre-existing database\n' +
      '  authentication. Re-run this file against a real, credentialed MariaDB instance\n' +
      '  before relying on this stack in production.'
    );
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(failed > 0 ? 1 : 0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  try {
    await migrateUp(pool);
    passed++; console.log('  \x1b[32m✓\x1b[0m migrateUp() applies both the identity-core and operations-domain schemas');

    const ownerRole = await roleRepository.findByCode('owner');
    const tenant = await tenantRepository.create('Ops Integration Shop ' + Date.now());
    const owner = await userRepository.create({
      tenantId: tenant.id, mobile: '91000' + String(Date.now()).slice(-5),
      displayName: 'Ops Owner', passwordHash: bcrypt.hashSync('123456', 10), roleId: ownerRole.id,
    });

    // ── Inventory + Sale ────────────────────────────────────────────────
    const product = await inventoryService.createProduct({ tenantId: tenant.id, name: 'Test Phone', sellPrice: 10000, costPrice: 8000, stock: 5 });
    const customer = await customerService.createCustomer({ tenantId: tenant.id, name: 'Test Customer', phone: '9000000000' });
    const sale1 = await saleService.createSale({
      tenantId: tenant.id, customerId: customer.id, items: [{ productId: product.id, qty: 2, price: 10000 }],
      saleDate: '2026-01-01', createdBy: owner.id, payments: [{ method: 'Cash', amount: 20000 }],
    });
    assert(sale1.invoice_no === 'INV-001', 'the first sale for a new tenant gets invoice number INV-001');
    const afterSale1 = await inventoryService.getProduct(tenant.id, product.id);
    assert(afterSale1.stock === 3, 'creating a sale decrements real inventory stock (5 - 2 = 3)');

    const sale2 = await saleService.createSale({
      tenantId: tenant.id, customerId: customer.id, items: [{ productId: product.id, qty: 1, price: 10000 }], saleDate: '2026-01-02',
    });
    assert(sale2.invoice_no === 'INV-002', 'invoice numbering is sequential per tenant against the real database');

    // ── Repair ────────────────────────────────────────────────────────────
    const repair = await repairService.createRepair({
      tenantId: tenant.id, customerId: customer.id, device: 'Test Device', issue: 'Screen cracked', receivedDate: '2026-01-01',
    });
    await repairService.addPart(tenant.id, repair.id, { productId: product.id, qty: 1 });
    const afterPart = await inventoryService.getProduct(tenant.id, product.id);
    assert(afterPart.stock === 1, 'adding a repair part decrements real inventory stock (2 - 1 = 1)');

    await repairService.deleteRepair(tenant.id, repair.id);
    const afterDelete = await inventoryService.getProduct(tenant.id, product.id);
    assert(afterDelete.stock === 2, 'deleting a repair job restores its consumed part back to real inventory stock (1 + 1 = 2)');

    // ── Recurring expense — idempotent per month ────────────────────────
    const recurring = await recurringExpenseService.createRecurring({ tenantId: tenant.id, title: 'Rent', amount: 5000 });
    const firstApply = await recurringExpenseService.applyForMonth(tenant.id, new Date('2026-01-15T00:00:00.000Z'));
    const secondApply = await recurringExpenseService.applyForMonth(tenant.id, new Date('2026-01-20T00:00:00.000Z'));
    assert(firstApply === 1 && secondApply === 0, 'applyForMonth applies a recurring expense exactly once per month against the real database');

    // ── Settings (Configuration, JSON) ───────────────────────────────────
    await settingsService.putSettings(tenant.id, { shopName: 'Ops Test Shop', currency: '₹' });
    const settings = await settingsService.getSettings(tenant.id);
    assert(settings.shopName === 'Ops Test Shop', 'Configuration round-trips correctly through the JSON column');
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
