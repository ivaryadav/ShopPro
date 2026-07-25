/**
 * server/src/migrationTools/jsonToRelational/transform.js
 *
 * Phase 6 — pure field-mapping functions from local.js's tenant_data JSON
 * blob shape (the `DB` object the frontend maintains — DB.inventory,
 * DB.customers, DB.sales, DB.repairs, DB.expenses, DB.recurringExpenses,
 * DB.cashEntries, DB.settings) to the normalized MariaDB row shapes
 * `server/src/repositories/*` expect. No I/O here — every function takes
 * plain objects and returns plain objects, so this is trivially unit
 * testable without a database.
 *
 * Every transform is a genuine reproduction of the field names/semantics
 * confirmed directly against app/ShopERP_Pro_v8.html during Phase 4 (see
 * that phase's Operations.md for line-number citations) — nothing here
 * invents a new field or drops one silently; anything dropped is called
 * out below.
 *
 * One real edge case this file handles that a naive "just copy
 * payments[]" migration would miss: a repair job's advance payment
 * (`job.advanceAmount`/`job.advanceMethod`, set at job creation in
 * saveJob, ~line 10703-10707) is NOT pushed into `r.payments[]` — that
 * array only gets entries from later `doCollectRepairPayment` calls. A
 * repair that only ever received an advance (no further payment
 * collection) would silently lose that payment if only `payments[]` were
 * migrated. `mapRepairPayments()` below synthesizes one payment record
 * from `advanceAmount`/`advanceMethod` when present, in addition to
 * whatever's in `payments[]`.
 */
'use strict';

/** @param {string} category @param {string[]} known @returns {string} */
function safeCategory(category, fallback) {
  return (typeof category === 'string' && category.trim()) || fallback || 'Other';
}

/** @param {object} item @returns {object} inventoryRepository.create()-shaped data (tenantId injected by caller) */
function mapInventoryItem(item) {
  return {
    name: item.name || 'Unnamed Product',
    category: item.category || null,
    sku: item.sku || null,
    imei: item.imei || null,
    costPrice: Number(item.costPrice) || 0,
    sellPrice: Number(item.sellPrice) || 0,
    stock: parseInt(item.stock, 10) || 0,
    minStock: item.minStock !== undefined ? parseInt(item.minStock, 10) || 0 : 2,
    unit: item.unit || 'pcs',
    _sourceId: item.id, // retained for id-mapping only, not a DB column
  };
}

/** @param {object} item @returns {object} customerRepository.create()-shaped data */
function mapCustomer(item) {
  return {
    name: item.name || 'Unknown Customer',
    phone: (item.phone || '').replace(/\D/g, '') || '0000000000',
    email: item.email || null,
    address: item.address || null,
    type: ['Regular', 'VIP', 'Wholesale', 'Shopkeeper'].includes(item.type) ? item.type : 'Regular',
    note: item.note || null,
    _sourceId: item.id,
    // item.balance/loyaltyPoints/totalPurchase deliberately dropped — confirmed
    // dead fields (DomainModel.md), not carried into the normalized schema.
  };
}

/**
 * Resolves a `createdBy` name string (local.js only ever stores
 * `currentUser.name`) to a user_id by matching display_name/username
 * within the tenant's own user list. Returns null (not a guess) when no
 * match is found — a real, documented data-fidelity gap inherent to the
 * source data itself (a free-text name was never guaranteed unique or
 * even a database key), not something this tool can safely resolve.
 * @param {string} name @param {object[]} tenantUsers @returns {number|null}
 */
function resolveCreatedBy(name, tenantUsers) {
  if (!name) return null;
  const match = tenantUsers.find((u) => u.display_name === name || u.username === name);
  return match ? match.id : null;
}

/**
 * @param {object} sale @param {Map<number,number>} productIdMap old id -> new id
 * @param {Map<number,number>} customerIdMap @param {object[]} tenantUsers
 * @returns {{sale: object, items: object[], payments: object[]}|null} null if customer can't be resolved
 */
function mapSale(sale, productIdMap, customerIdMap, tenantUsers) {
  const newCustomerId = customerIdMap.get(sale.customerId);
  if (!newCustomerId) return null; // unresolvable — reported as skipped, not silently dropped
  const items = (sale.items || []).map((i) => ({
    productId: productIdMap.get(i.productId) || null,
    productName: i.name || 'Unknown Item',
    price: Number(i.price) || 0,
    qty: parseInt(i.qty, 10) || 0,
  }));
  const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
  const discount = Number(sale.discount) || 0;
  const total = sale.total !== undefined ? Number(sale.total) : Math.max(0, subtotal - discount);
  return {
    sale: {
      invoiceNo: sale.invoiceNo || `MIGRATED-${sale.id}`,
      customerId: newCustomerId,
      subtotal, discount, total,
      saleDate: sale.date || '1970-01-01',
      note: sale.note || null,
      createdBy: resolveCreatedBy(sale.createdBy, tenantUsers),
      _sourceId: sale.id,
    },
    items,
    payments: (sale.payments || []).map((p) => ({
      method: p.method || 'Cash', amount: Number(p.amount) || 0, paymentDate: p.date || sale.date || '1970-01-01',
    })).filter((p) => p.amount > 0),
  };
}

/**
 * @param {object} repair @param {Map<number,number>} productIdMap
 * @param {Map<number,number>} customerIdMap @param {object[]} tenantUsers
 * @returns {{repair: object, parts: object[], payments: object[]}|null}
 */
function mapRepair(repair, productIdMap, customerIdMap, tenantUsers) {
  const newCustomerId = customerIdMap.get(repair.customerId);
  if (!newCustomerId) return null;
  const parts = (repair.partsUsed || []).map((p) => ({
    productId: productIdMap.get(p.productId) || null,
    productName: p.name || 'Unknown Part',
    price: Number(p.price) || 0,
    qty: parseInt(p.qty, 10) || 0,
  }));

  // See file header: advanceAmount is never reflected in payments[] by
  // local.js itself — synthesized here so it isn't silently lost.
  const payments = (repair.payments || []).map((p) => ({
    method: p.method || 'Cash', amount: Number(p.amount) || 0, paymentDate: p.date || repair.received || '1970-01-01',
  })).filter((p) => p.amount > 0);
  if (Number(repair.advanceAmount) > 0) {
    payments.unshift({
      method: repair.advanceMethod || 'Cash', amount: Number(repair.advanceAmount),
      paymentDate: repair.received || '1970-01-01',
    });
  }

  return {
    repair: {
      jobNo: repair.jobNo || `MIGRATED-${repair.id}`,
      customerId: newCustomerId,
      device: repair.device || 'Unknown Device',
      issue: repair.issue || '',
      status: ['Received', 'Diagnosing', 'Repairing', 'Ready', 'Delivered'].includes(repair.status) ? repair.status : 'Received',
      estimatedCost: Number(repair.estimatedCost) || 0,
      finalCost: Number(repair.finalCost) || 0,
      labourCharge: Number(repair.labourCharge) || 0,
      receivedDate: repair.received || '1970-01-01',
      estimatedDelivery: repair.estimatedDelivery || null,
      deliveredDate: repair.delivered || null,
      warrantyDays: repair.warranty !== undefined ? parseInt(repair.warranty, 10) || 0 : 30,
      altWhatsapp: repair.altWa || null,
      note: repair.note || null,
      createdBy: resolveCreatedBy(repair.createdBy, tenantUsers),
      _sourceId: repair.id,
    },
    parts,
    payments,
  };
}

/** @param {object} expense @returns {object} expenseRepository.create()-shaped data */
function mapExpense(expense) {
  return {
    title: expense.title || 'Untitled Expense',
    category: safeCategory(expense.category),
    amount: Number(expense.amount) || 0,
    expenseDate: expense.date || '1970-01-01',
    note: expense.note || null,
    _sourceId: expense.id,
  };
}

/** @param {object} re @returns {object} recurringExpenseRepository-shaped data, plus isActive/lastApplied for post-create calls */
function mapRecurringExpense(re) {
  return {
    title: re.title || 'Untitled Recurring Expense',
    category: safeCategory(re.category),
    amount: Number(re.amount) || 0,
    note: re.note || null,
    isActive: !!re.active,
    lastApplied: re.lastApplied || null,
    _sourceId: re.id,
  };
}

/** @param {object} entry @returns {object} paymentService.createManualEntry()-shaped data */
function mapCashEntry(entry) {
  return {
    direction: entry.type === 'out' ? 'out' : 'in',
    amount: Number(entry.amount) || 0,
    description: entry.description || '(migrated cash entry)',
    method: ['Cash', 'UPI', 'Bank Transfer', 'Card'].includes(entry.method) ? entry.method : 'Cash',
    paymentDate: entry.date || '1970-01-01',
  };
}

module.exports = {
  mapInventoryItem, mapCustomer, mapSale, mapRepair, mapExpense,
  mapRecurringExpense, mapCashEntry, resolveCreatedBy,
};
