/**
 * Phase 6 integration test — the full JSON-to-Relational migration tool
 * (migrationService.migrateTenant, dry-run and real, plus rollbackTenant)
 * against a REAL MariaDB instance, using a synthetic sample blob shaped
 * exactly like local.js's tenant_data.data (NOT real production data —
 * this tool is tested here, not run against any actual tenant's data;
 * running it "for real" against production is a future, separately
 * approved cutover step, explicitly out of scope for this phase).
 *
 * Same honest-skip pattern as every other integration test.
 * Config is env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME).
 *
 * Usage: node server/src/tests/jsonToRelationalMigration.integration.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests } = require('../database');
const tenantRepository = require('../repositories/tenantRepository');
const roleRepository = require('../repositories/roleRepository');
const userRepository = require('../repositories/userRepository');
const { migrateTenant, rollbackTenant, countActualRows } = require('../migrationTools/jsonToRelational/migrationService');

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

/** A synthetic sample blob shaped exactly like local.js's DB object — not real tenant data. */
function sampleBlob() {
  return {
    inventory: [
      { id: 1, name: 'Sample Phone', category: 'New Phone', sku: 'SP-001', costPrice: 8000, sellPrice: 10000, stock: 10, minStock: 2, unit: 'pcs' },
      { id: 2, name: 'Sample Screen Part', category: 'Spare Part', costPrice: 500, sellPrice: 800, stock: 20, minStock: 5, unit: 'pcs' },
    ],
    customers: [
      { id: 1, name: 'Sample Customer', phone: '9000000001', email: '', address: 'Test City', type: 'Regular', note: '', balance: 999, loyaltyPoints: 5 },
    ],
    sales: [
      { id: 1, invoiceNo: 'INV-001', customerId: 1, items: [{ productId: 1, name: 'Sample Phone', qty: 1, price: 10000 }], total: 10000, discount: 0, date: '2026-01-01', note: '', createdBy: 'Sample Owner', payments: [{ method: 'Cash', amount: 10000, date: '2026-01-01' }] },
      { id: 2, invoiceNo: 'INV-002', customerId: 999, items: [{ productId: 1, name: 'Sample Phone', qty: 1, price: 10000 }], total: 10000, date: '2026-01-02' }, // unresolvable customer — must be skipped, not fabricated
    ],
    repairs: [
      {
        id: 1, jobNo: 'JOB-001', customerId: 1, device: 'Sample Device', issue: 'Screen cracked', status: 'Delivered',
        estimatedCost: 800, finalCost: 800, labourCharge: 300, partsUsed: [{ productId: 2, name: 'Sample Screen Part', qty: 1, price: 500 }],
        received: '2026-01-01', delivered: '2026-01-03', warranty: 30, createdBy: 'Sample Owner',
        advanceAmount: 200, advanceMethod: 'UPI', // never in payments[] by local.js's own design
        payments: [{ method: 'Cash', amount: 600, date: '2026-01-03' }],
      },
    ],
    expenses: [{ id: 1, title: 'Sample Rent', category: 'Rent', amount: 5000, date: '2026-01-01' }],
    recurringExpenses: [{ id: 1, title: 'Sample Recurring Rent', category: 'Rent', amount: 5000, active: true, lastApplied: null }],
    cashEntries: [{ type: 'in', amount: 1000, description: 'Owner deposit', method: 'Bank Transfer', date: '2026-01-01' }],
    settings: { shopName: 'Sample Migrated Shop', currency: '₹' },
  };
}

async function main() {
  console.log('Phase 6 integration test: JSON-to-Relational migration tool against real MariaDB');
  console.log('');

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);
  if (!health.ok) {
    for (const label of [
      'dry-run reports correct expected counts and writes nothing',
      'real run creates every resolvable row and skips the unresolvable sale',
      'post-migration integrity verification passes',
      'rollbackTenant removes everything the migration created',
    ]) skip(label, `no reachable/authenticated database: ${health.error}`);
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(failed > 0 ? 1 : 0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  try {
    await migrateUp(pool);
    const ownerRole = await roleRepository.findByCode('owner');
    const tenant = await tenantRepository.create('Migration Tool Test Shop ' + Date.now());
    await userRepository.create({
      tenantId: tenant.id, mobile: '93000' + String(Date.now()).slice(-5),
      displayName: 'Sample Owner', passwordHash: bcrypt.hashSync('123456', 10), roleId: ownerRole.id,
    });

    const blob = sampleBlob();

    // ── Dry run: writes nothing ──────────────────────────────────────
    const dryResult = await migrateTenant(tenant.id, blob, { dryRun: true });
    assert(dryResult.counts.created.inventory === 2 && dryResult.counts.created.customers === 1, 'dry-run reports correct expected counts');
    assert(dryResult.counts.skipped.sales === 1, 'dry-run correctly identifies the unresolvable-customer sale as skipped, even without writing anything');
    const preRowCounts = await countActualRows(tenant.id);
    assert(preRowCounts.inventory === 0 && preRowCounts.customers === 0, 'dry-run writes ZERO rows to the real database');

    // ── Real run ──────────────────────────────────────────────────────
    const realResult = await migrateTenant(tenant.id, blob, { dryRun: false });
    assert(realResult.counts.created.inventory === 2, 'real run creates both inventory items');
    assert(realResult.counts.created.sales === 1, 'real run creates only the 1 resolvable sale, skipping the unresolvable one');
    assert(realResult.skippedDetails.some((d) => d.includes('customerId 999')), 'the skip reason names the specific unresolvable customerId, not a generic failure');
    assert(realResult.counts.created.repairs === 1 && realResult.counts.created.repairParts === 1, 'real run creates the repair and its part');

    const actual = await countActualRows(tenant.id);
    assert(actual.inventory === 2 && actual.customers === 1 && actual.sales === 1 && actual.repairs === 1, 'real row counts in MariaDB match what the migration reported creating');

    // Advance-payment synthesis verified via the payments table directly.
    // NOTE: DECIMAL columns come back from the `mariadb` driver as STRINGS
    // by default (only INT columns are auto-numeric) — a real
    // characteristic this test caught directly. Number(p.amount) is used
    // here, matching the same defensive coercion every service already
    // applies (repairService.collectPayment etc. use Number(...) rather
    // than strict ===) — not a bug in this codebase, but worth this
    // explicit note since a naive `p.amount === 200` would silently fail.
    const paymentRepository = require('../repositories/paymentRepository');
    const repairs = await require('../services/repairService').listRepairs(tenant.id);
    const repairPayments = await paymentRepository.listForSource(tenant.id, 'repair', repairs[0].id);
    assert(repairPayments.length === 2 && repairPayments.some((p) => Number(p.amount) === 200 && p.method === 'UPI'), "the repair's advance payment (never in local.js's payments[] array) was correctly synthesized as a real payment row");

    assert(realResult.integrity.ok, 'post-migration integrity verification passes (row counts and financial totals reconcile exactly)');

    // ── Rollback ──────────────────────────────────────────────────────
    await rollbackTenant(tenant.id);
    const afterRollback = await countActualRows(tenant.id);
    const allZero = Object.entries(afterRollback).every(([k, v]) => k.startsWith('total') ? v === 0 : v === 0);
    assert(allZero, 'rollbackTenant removes every row this migration created, restoring a clean pre-migration state');

    const tenantStillExists = await tenantRepository.findById(tenant.id);
    assert(!!tenantStillExists, 'rollbackTenant never deletes the tenant row itself, only the Operations-domain rows it created');
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
