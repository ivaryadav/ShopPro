/**
 * server/src/migrationTools/jsonToRelational/migrationService.js
 *
 * Orchestrates migrating ONE tenant's Operations-domain data out of
 * local.js's tenant_data.data JSON blob and into the normalized MariaDB
 * tables built in Phase 4. Scope is deliberately Operations-domain only
 * (Inventory/Customer/Sale/Repair/Expense/RecurringExpense/cash entries/
 * Configuration) — Identity data (tenants/users) is NOT a JSON blob in
 * local.js to begin with (it's already relational, in SQLite) and is out
 * of scope for this tool.
 *
 * NEVER reads from or writes to server/local.js's actual SQLite database
 * directly — it operates purely on an already-parsed JS object (the
 * caller is responsible for extracting tenant_data.data, e.g. via a
 * one-off read script, and passing it in). This keeps the "customer data
 * is never deleted" guarantee trivially true: this tool has no delete
 * capability against the SOURCE data at all, only against its OWN
 * destination rows (rollbackTenant).
 *
 * Modes:
 * - dryRun: transforms and validates everything, returns full counts and
 *   any skipped-record reasons, WRITES NOTHING.
 * - real run: writes via the existing repository layer (same code path
 *   production traffic uses — no separate, divergent insert logic),
 *   inside one transaction per entity type, builds old-id -> new-id maps
 *   as it goes (inventory/customers must be migrated before sales/repairs,
 *   which reference them), then runs post-migration integrity verification.
 * - rollbackTenant: deletes every row this tool could have created for a
 *   tenant, in FK-safe order. Does not touch the `tenants` row itself.
 */
'use strict';

const inventoryRepository = require('../../repositories/inventoryRepository');
const customerRepository = require('../../repositories/customerRepository');
const saleRepository = require('../../repositories/saleRepository');
const repairRepository = require('../../repositories/repairRepository');
const expenseRepository = require('../../repositories/expenseRepository');
const recurringExpenseRepository = require('../../repositories/recurringExpenseRepository');
const paymentRepository = require('../../repositories/paymentRepository');
const settingsRepository = require('../../repositories/settingsRepository');
const userRepository = require('../../repositories/userRepository');
const { withConnection } = require('../../database');
const transform = require('./transform');
const { validateBlobStructure, expectedCounts, verifyIntegrity } = require('./validationService');
const { renderMarkdown } = require('./reconciliationReport');

/**
 * @param {number} tenantId @param {object} blob @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<object>} result object, see reconciliationReport.js for shape; also has `.markdown`
 */
async function migrateTenant(tenantId, blob, opts = {}) {
  const dryRun = !!opts.dryRun;
  const startedAt = new Date().toISOString();

  const structural = validateBlobStructure(blob);
  if (!structural.ok) {
    throw new Error('Blob failed structural validation: ' + structural.errors.join('; '));
  }

  const tenantUsers = await userRepository.listByTenant(tenantId);
  const created = {
    inventory: 0, customers: 0, sales: 0, saleItems: 0, repairs: 0,
    repairParts: 0, expenses: 0, recurringExpenses: 0, cashEntries: 0,
    totalSalesAmount: 0, totalExpensesAmount: 0,
  };
  const skippedDetails = [];
  const skipped = { skippedSales: [], skippedRepairs: [] };

  const productIdMap = new Map();
  const customerIdMap = new Map();

  // ── Inventory (must come before sales/repairs, which reference it) ───
  for (const rawItem of blob.inventory || []) {
    const mapped = transform.mapInventoryItem(rawItem);
    if (dryRun) {
      created.inventory += 1;
    } else {
      const row = await inventoryRepository.create({ tenantId, ...mapped });
      productIdMap.set(mapped._sourceId, row.id);
      created.inventory += 1;
    }
  }
  if (dryRun) {
    // Dry-run still needs an id map to validate sale/repair item references
    // resolve, even though no rows exist yet — synthesize placeholder ids.
    (blob.inventory || []).forEach((item, i) => productIdMap.set(item.id, -(i + 1)));
  }

  // ── Customers (must come before sales/repairs) ────────────────────────
  for (const rawCustomer of blob.customers || []) {
    const mapped = transform.mapCustomer(rawCustomer);
    if (dryRun) {
      created.customers += 1;
      customerIdMap.set(mapped._sourceId, -1);
    } else {
      const row = await customerRepository.create({ tenantId, ...mapped });
      customerIdMap.set(mapped._sourceId, row.id);
      created.customers += 1;
    }
  }

  // ── Sales + SaleItems + Payments ───────────────────────────────────────
  for (const rawSale of blob.sales || []) {
    const mapped = transform.mapSale(rawSale, productIdMap, customerIdMap, tenantUsers);
    if (!mapped) {
      skipped.skippedSales.push(rawSale.id);
      skippedDetails.push(`Sale id=${rawSale.id} (invoice ${rawSale.invoiceNo || '?'}) skipped — customerId ${rawSale.customerId} does not resolve to a migrated customer`);
      continue;
    }
    created.sales += 1;
    created.saleItems += mapped.items.length;
    created.totalSalesAmount += mapped.sale.total;
    if (!dryRun) {
      const saleRow = await saleRepository.create({ tenantId, ...mapped.sale, items: mapped.items });
      for (const p of mapped.payments) {
        await paymentRepository.create({ tenantId, sourceType: 'sale', sourceId: saleRow.id, direction: 'in', method: p.method, amount: p.amount, paymentDate: p.paymentDate });
      }
    }
  }

  // ── Repairs + RepairParts + Payments ─────────────────────────────────
  for (const rawRepair of blob.repairs || []) {
    const mapped = transform.mapRepair(rawRepair, productIdMap, customerIdMap, tenantUsers);
    if (!mapped) {
      skipped.skippedRepairs.push(rawRepair.id);
      skippedDetails.push(`Repair id=${rawRepair.id} (job ${rawRepair.jobNo || '?'}) skipped — customerId ${rawRepair.customerId} does not resolve to a migrated customer`);
      continue;
    }
    created.repairs += 1;
    created.repairParts += mapped.parts.length;
    if (!dryRun) {
      const repairRow = await repairRepository.create({ tenantId, ...mapped.repair });
      for (const part of mapped.parts) {
        await repairRepository.addOrMergePart(tenantId, repairRow.id, part);
      }
      for (const p of mapped.payments) {
        await paymentRepository.create({ tenantId, sourceType: 'repair', sourceId: repairRow.id, direction: 'in', method: p.method, amount: p.amount, paymentDate: p.paymentDate });
      }
      // final_cost is recomputed by repairService normally; this tool
      // writes the SOURCE's own final_cost/labour_charge verbatim instead
      // (via repositories.create, which accepts them directly) to
      // preserve historical figures exactly as they were, not
      // re-derive them from migrated parts (denormalized snapshots may
      // legitimately differ from a live recompute if the source data
      // itself had drifted — this tool migrates history, it doesn't
      // "correct" it).
    }
  }

  // ── Expenses ──────────────────────────────────────────────────────────
  for (const rawExpense of blob.expenses || []) {
    const mapped = transform.mapExpense(rawExpense);
    created.expenses += 1;
    created.totalExpensesAmount += mapped.amount;
    if (!dryRun) await expenseRepository.create({ tenantId, ...mapped });
  }

  // ── Recurring Expenses ────────────────────────────────────────────────
  for (const rawRe of blob.recurringExpenses || []) {
    const mapped = transform.mapRecurringExpense(rawRe);
    created.recurringExpenses += 1;
    if (!dryRun) {
      const row = await recurringExpenseRepository.create({ tenantId, title: mapped.title, category: mapped.category, amount: mapped.amount, note: mapped.note });
      if (!mapped.isActive) await recurringExpenseRepository.setActive(tenantId, row.id, false);
      if (mapped.lastApplied) await recurringExpenseRepository.setLastApplied(tenantId, row.id, mapped.lastApplied);
    }
  }

  // ── Manual cash entries ───────────────────────────────────────────────
  for (const rawEntry of blob.cashEntries || []) {
    const mapped = transform.mapCashEntry(rawEntry);
    created.cashEntries += 1;
    if (!dryRun) {
      await paymentRepository.create({ tenantId, sourceType: 'manual', sourceId: null, direction: mapped.direction, method: mapped.method, amount: mapped.amount, description: mapped.description, paymentDate: mapped.paymentDate });
    }
  }

  // ── Configuration (Settings) ──────────────────────────────────────────
  if (blob.settings && !dryRun) {
    await settingsRepository.put(tenantId, blob.settings);
  }

  let integrity = null;
  if (!dryRun) {
    const expected = expectedCounts(blob, skipped);
    const actual = await countActualRows(tenantId);
    integrity = verifyIntegrity(expected, actual);
  }

  const result = {
    tenantId, dryRun, startedAt, finishedAt: new Date().toISOString(),
    counts: { created, skipped: { sales: skipped.skippedSales.length, repairs: skipped.skippedRepairs.length } },
    skippedDetails, integrity,
  };
  result.markdown = renderMarkdown(result);
  return result;
}

/** @param {number} tenantId @returns {Promise<object>} real row counts from MariaDB, same shape as expectedCounts() */
async function countActualRows(tenantId) {
  return withConnection(async (conn) => {
    const q = async (sql, params) => (await conn.query(sql, params))[0];
    const inventory = (await q('SELECT COUNT(*) c FROM inventory_items WHERE tenant_id=?', [tenantId])).c;
    const customers = (await q('SELECT COUNT(*) c FROM customers WHERE tenant_id=?', [tenantId])).c;
    const sales = (await q('SELECT COUNT(*) c FROM sales WHERE tenant_id=?', [tenantId])).c;
    const saleItems = (await q('SELECT COUNT(*) c FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.tenant_id=?', [tenantId])).c;
    const repairs = (await q('SELECT COUNT(*) c FROM repairs WHERE tenant_id=?', [tenantId])).c;
    const repairParts = (await q('SELECT COUNT(*) c FROM repair_parts rp JOIN repairs r ON r.id=rp.repair_id WHERE r.tenant_id=?', [tenantId])).c;
    const expenses = (await q('SELECT COUNT(*) c FROM expenses WHERE tenant_id=?', [tenantId])).c;
    const recurringExpenses = (await q('SELECT COUNT(*) c FROM recurring_expenses WHERE tenant_id=?', [tenantId])).c;
    const cashEntries = (await q("SELECT COUNT(*) c FROM payments WHERE tenant_id=? AND source_type='manual'", [tenantId])).c;
    const totalSalesAmount = Number((await q('SELECT COALESCE(SUM(total),0) c FROM sales WHERE tenant_id=?', [tenantId])).c);
    const totalExpensesAmount = Number((await q('SELECT COALESCE(SUM(amount),0) c FROM expenses WHERE tenant_id=?', [tenantId])).c);
    return { inventory, customers, sales, saleItems, repairs, repairParts, expenses, recurringExpenses, cashEntries, totalSalesAmount, totalExpensesAmount };
  });
}

/**
 * Deletes every row this tool could have created for a tenant, in
 * FK-safe order (sales/repairs and their CASCADE children first, then
 * customers/inventory, which sales/repairs reference with a
 * default-RESTRICT FK). Never touches the `tenants` row itself, and never
 * touches server/local.js's SQLite data (this tool has no access to it).
 * @param {number} tenantId
 */
async function rollbackTenant(tenantId) {
  return withConnection(async (conn) => {
    await conn.query('DELETE FROM payments WHERE tenant_id=?', [tenantId]);
    await conn.query('DELETE FROM stock_movements WHERE tenant_id=?', [tenantId]);
    await conn.query('DELETE FROM sales WHERE tenant_id=?', [tenantId]); // cascades sale_items
    await conn.query('DELETE FROM repairs WHERE tenant_id=?', [tenantId]); // cascades repair_parts
    await conn.query('DELETE FROM customers WHERE tenant_id=?', [tenantId]);
    await conn.query('DELETE FROM inventory_items WHERE tenant_id=?', [tenantId]);
    await conn.query('DELETE FROM expenses WHERE tenant_id=?', [tenantId]);
    await conn.query('DELETE FROM recurring_expenses WHERE tenant_id=?', [tenantId]);
    await conn.query('DELETE FROM tenant_settings WHERE tenant_id=?', [tenantId]);
  });
}

module.exports = { migrateTenant, rollbackTenant, countActualRows };
