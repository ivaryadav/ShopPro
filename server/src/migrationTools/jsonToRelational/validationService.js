/**
 * server/src/migrationTools/jsonToRelational/validationService.js
 *
 * Pre-migration structural validation (is this blob even shaped like a
 * real tenant_data.data JSON object?) and post-migration integrity
 * verification (did every row that should exist actually get created,
 * and do the financial totals reconcile?). Pure functions — no I/O other
 * than the repository read calls passed in for post-migration checks.
 */
'use strict';

/**
 * @param {object} blob a tenant's parsed tenant_data.data JSON
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateBlobStructure(blob) {
  const errors = [];
  if (!blob || typeof blob !== 'object') {
    return { ok: false, errors: ['blob is not an object'] };
  }
  for (const key of ['inventory', 'customers', 'sales', 'repairs', 'expenses']) {
    if (blob[key] !== undefined && !Array.isArray(blob[key])) {
      errors.push(`blob.${key} exists but is not an array`);
    }
  }
  (blob.sales || []).forEach((s, i) => {
    if (!Array.isArray(s.items)) errors.push(`sales[${i}] (id=${s.id}) has no items array`);
  });
  (blob.repairs || []).forEach((r, i) => {
    if (r.partsUsed !== undefined && !Array.isArray(r.partsUsed)) errors.push(`repairs[${i}] (id=${r.id}) has a non-array partsUsed`);
  });
  return { ok: errors.length === 0, errors };
}

/**
 * @param {object} blob
 * @param {{skippedSales: number[], skippedRepairs: number[]}} skipped
 * @returns {object} counts of what SHOULD exist post-migration, per entity
 */
function expectedCounts(blob, skipped) {
  return {
    inventory: (blob.inventory || []).length,
    customers: (blob.customers || []).length,
    sales: (blob.sales || []).length - skipped.skippedSales.length,
    saleItems: (blob.sales || []).reduce((a, s, i) => skipped.skippedSales.includes(s.id) ? a : a + (s.items || []).length, 0),
    repairs: (blob.repairs || []).length - skipped.skippedRepairs.length,
    repairParts: (blob.repairs || []).reduce((a, r) => skipped.skippedRepairs.includes(r.id) ? a : a + (r.partsUsed || []).length, 0),
    expenses: (blob.expenses || []).length,
    recurringExpenses: (blob.recurringExpenses || []).length,
    cashEntries: (blob.cashEntries || []).length,
    totalSalesAmount: (blob.sales || []).reduce((a, s) => skipped.skippedSales.includes(s.id) ? a : a + (Number(s.total) || 0), 0),
    totalExpensesAmount: (blob.expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0),
  };
}

/**
 * @param {object} expected from expectedCounts()
 * @param {object} actual same shape, counted from the real destination rows
 * @returns {{ok: boolean, mismatches: string[]}}
 */
function verifyIntegrity(expected, actual) {
  const mismatches = [];
  for (const key of Object.keys(expected)) {
    const isAmount = key.startsWith('total');
    const e = expected[key], a = actual[key];
    const matches = isAmount ? Math.abs(e - a) < 0.01 : e === a;
    if (!matches) mismatches.push(`${key}: expected ${e}, got ${a}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

module.exports = { validateBlobStructure, expectedCounts, verifyIntegrity };
