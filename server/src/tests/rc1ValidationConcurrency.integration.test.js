/**
 * RC1 End-to-End Product Validation — regression test for a real,
 * high-severity concurrency bug found and fixed during this validation
 * pass: two simultaneous sales (or repair-part additions) for the SAME
 * product could both pass a read-then-act stock check and both succeed,
 * overselling the last unit(s) of real inventory. Fixed by making
 * inventoryRepository.decrementStock an atomic, guarded
 * "UPDATE ... WHERE stock >= ?" that reports success/failure, checked by
 * every caller (saleService.createSale/updateSale, repairService.addPart).
 *
 * This file proves the fix against a REAL MariaDB instance under REAL
 * concurrent requests — not a mock, since the whole bug was invisible to
 * mocked tests (both callers "succeeded" against a stub that always
 * returns success, exactly like the real, unguarded SQL used to).
 *
 * Same honest-skip pattern as every other integration test in this
 * project. Config is env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME).
 *
 * Usage: node server/src/tests/rc1ValidationConcurrency.integration.test.js
 */
'use strict';

const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests } = require('../database');
const roleRepository = require('../repositories/roleRepository');
const tenantRepository = require('../repositories/tenantRepository');
const userRepository = require('../repositories/userRepository');
const inventoryService = require('../services/inventoryService');
const customerService = require('../services/customerService');
const saleService = require('../services/saleService');
const repairService = require('../services/repairService');
const bcrypt = require('bcryptjs');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function skip(label, reason) { skipped++; console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason); }

const TEST_DB_CONFIG = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_phase6_test',
};

async function main() {
  console.log('RC1 Validation regression: concurrent-oversell fix, against real MariaDB');
  console.log('');

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);
  if (!health.ok) {
    for (const label of [
      'two simultaneous sales for the last unit of stock: exactly one succeeds, one is cleanly rejected',
      'stock never goes negative and exactly ONE sale is recorded, not two',
      'the rejected attempt leaves inventory in the exact state it was before the race (revert-on-failure holds)',
      'the same race for repair-part consumption: exactly one addPart succeeds',
    ]) skip(label, `no reachable/authenticated database: ${health.error}`);
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  try {
    await migrateUp(pool);
    const ownerRole = await roleRepository.findByCode('owner');
    const tenant = await tenantRepository.create('RC1 Validation Concurrency Shop ' + Date.now());
    await userRepository.create({
      tenantId: tenant.id, mobile: '96000' + String(Date.now()).slice(-5),
      displayName: 'RC1 Val Owner', passwordHash: bcrypt.hashSync('123456', 10), roleId: ownerRole.id,
    });
    const customer = await customerService.createCustomer({ tenantId: tenant.id, name: 'Race Customer', phone: '9222222222' });

    // ── The exact race: last unit of stock, two simultaneous sales ──────
    const product = await inventoryService.createProduct({ tenantId: tenant.id, name: 'Last Unit Phone', sellPrice: 5000, costPrice: 4000, stock: 1 });
    const saleAttempt = (label) => saleService.createSale({
      tenantId: tenant.id, customerId: customer.id,
      items: [{ productId: product.id, qty: 1, price: 5000 }],
      saleDate: '2026-01-01', note: label,
    }).then((sale) => ({ ok: true, sale })).catch((e) => ({ ok: false, error: e }));

    const [resultA, resultB] = await Promise.all([saleAttempt('racer-A'), saleAttempt('racer-B')]);
    const successes = [resultA, resultB].filter((r) => r.ok);
    const failures = [resultA, resultB].filter((r) => !r.ok);
    assert(successes.length === 1 && failures.length === 1, `two simultaneous sales for the last unit of stock: exactly one succeeds and one is cleanly rejected (got ${successes.length} success, ${failures.length} failure)`);
    assert(failures.length === 1 && failures[0].error.statusCode === 409, "the rejected attempt fails with a real 409 Conflict, not a crash or a silent overselling success");

    const afterRace = await inventoryService.getProduct(tenant.id, product.id);
    assert(afterRace.stock === 0, `stock correctly lands at exactly 0 (one unit sold), never negative (got ${afterRace.stock})`);
    const allSales = await saleService.listSales(tenant.id);
    assert(allSales.length === 1, `exactly ONE sale is recorded for the one physical unit that existed — not two sales for one unit (got ${allSales.length})`);

    // ── Same race for repair-part consumption ────────────────────────────
    const repairProduct = await inventoryService.createProduct({ tenantId: tenant.id, name: 'Last Screen', sellPrice: 800, costPrice: 500, stock: 1 });
    const repair1 = await repairService.createRepair({ tenantId: tenant.id, customerId: customer.id, device: 'Phone A', issue: 'Screen crack', receivedDate: '2026-01-01' });
    const repair2 = await repairService.createRepair({ tenantId: tenant.id, customerId: customer.id, device: 'Phone B', issue: 'Screen crack', receivedDate: '2026-01-01' });
    const partAttempt = (repairId) => repairService.addPart(tenant.id, repairId, { productId: repairProduct.id, qty: 1 }).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e }));
    const [partA, partB] = await Promise.all([partAttempt(repair1.id), partAttempt(repair2.id)]);
    const partSuccesses = [partA, partB].filter((r) => r.ok);
    assert(partSuccesses.length === 1, `the same race for repair-part consumption: exactly one addPart succeeds for the last unit of stock (got ${partSuccesses.length})`);
    const afterPartRace = await inventoryService.getProduct(tenant.id, repairProduct.id);
    assert(afterPartRace.stock === 0, `repair-part stock also lands at exactly 0, never negative (got ${afterPartRace.stock})`);
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
