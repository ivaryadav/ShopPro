/**
 * server/src/services/paymentService.js
 *
 * Shared payment business rules for saleService/repairService (sale and
 * repair payment collection) and the manual cash-book entry endpoint.
 * Reproduces local.js's per-context method restriction: buildPaymentUI
 * (~line 7714) offers exactly Cash/UPI/Card for sale/repair collection;
 * addCashEntry (~line 16747) additionally offers Bank Transfer for manual
 * entries only. The `payments` table's `method` column is a single enum
 * spanning all 4 (migrations/002_operations_domain.sql) — this service is
 * where the context-specific restriction is actually enforced, per that
 * migration's own note and OperationsSchemaDesign.md's explicitly
 * unresolved flag.
 *
 * Deliberate simplification, documented not silently made (see
 * docs/database/MigrationNotes.md): local.js's own split-payment UI has an
 * edge-case quirk where a client-side rounding/typo causing the split sum
 * to exceed the invoice total silently falls back to charging the FULL
 * total in cash (saveSale ~line 10052-10056). That fallback is an artifact
 * of client-side split-tracking arithmetic, not a deliberate business
 * rule — this service instead rejects a payment set that exceeds the
 * total with a clear ValidationError.
 */
'use strict';

const paymentRepository = require('../repositories/paymentRepository');
const { ValidationError } = require('../errors');

const COLLECTION_METHODS = ['Cash', 'UPI', 'Card'];
const MANUAL_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer'];

/**
 * @param {Array<{method:string,amount:number}>} payments
 * @param {number} total
 * @returns {Array<{method:string,amount:number}>} filtered to amount > 0
 */
function validateCollectionPayments(payments, total) {
  const list = (payments || []).filter((p) => Number(p.amount) > 0);
  for (const p of list) {
    if (!COLLECTION_METHODS.includes(p.method)) {
      throw new ValidationError(`Payment method '${p.method}' is not valid for sale/repair collection`);
    }
  }
  const sum = list.reduce((a, p) => a + Number(p.amount), 0);
  if (sum > total + 0.001) {
    throw new ValidationError(`Payment total (₹${sum}) cannot exceed the amount due (₹${total})`);
  }
  return list;
}

/**
 * Records a sale/repair's payment rows, replacing any prior ones for that
 * source (matches local.js's full-array-replace semantics on edit).
 * @param {number} tenantId @param {'sale'|'repair'} sourceType @param {number} sourceId
 * @param {Array<{method:string,amount:number}>} payments @param {string} paymentDate
 * @returns {Promise<number>} total recorded
 */
async function replaceCollectionPayments(tenantId, sourceType, sourceId, payments, paymentDate) {
  await paymentRepository.deleteForSource(tenantId, sourceType, sourceId);
  let total = 0;
  for (const p of payments) {
    await paymentRepository.create({
      tenantId, sourceType, sourceId, direction: 'in', method: p.method, amount: p.amount, paymentDate,
    });
    total += Number(p.amount);
  }
  return total;
}

/** Matches saveCashEntry exactly (~line 16752-16764): type/direction, description required, all 4 methods allowed. */
async function createManualEntry(params) {
  const amount = Number(params.amount) || 0;
  const description = (params.description || '').trim();
  if (!amount || !description) throw new ValidationError('Amount and description required');
  if (!MANUAL_METHODS.includes(params.method)) throw new ValidationError(`Payment method '${params.method}' is not valid`);
  return paymentRepository.create({
    tenantId: params.tenantId, sourceType: 'manual', sourceId: null,
    direction: params.direction === 'out' ? 'out' : 'in', method: params.method,
    amount, description, paymentDate: params.paymentDate,
  });
}

async function listManualEntries(tenantId) {
  return paymentRepository.listManual(tenantId);
}

module.exports = { validateCollectionPayments, replaceCollectionPayments, createManualEntry, listManualEntries, COLLECTION_METHODS, MANUAL_METHODS };
