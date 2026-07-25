/**
 * server/src/services/recurringExpenseService.js
 *
 * Mirrors DB.recurringExpenses' CRUD and applyRecurringExpenses exactly
 * (~line 12291-12310). No scheduler — applyForMonth only ever runs when
 * explicitly called (matching the "▶ Apply This Month" button), exactly
 * as flagged out of scope for this phase in the mission and in
 * OperationsSchemaDesign.md.
 */
'use strict';

const recurringExpenseRepository = require('../repositories/recurringExpenseRepository');
const expenseRepository = require('../repositories/expenseRepository');
const { ValidationError, NotFoundError } = require('../errors');

async function listRecurring(tenantId) {
  return recurringExpenseRepository.listByTenant(tenantId);
}

async function createRecurring(params) {
  const title = (params.title || '').trim();
  const amount = Number(params.amount);
  if (!title) throw new ValidationError('Title is required');
  if (!Number.isFinite(amount) || amount < 0.01) throw new ValidationError('Amount must be at least 0.01');
  return recurringExpenseRepository.create({ tenantId: params.tenantId, title, category: params.category, amount, note: params.note });
}

async function updateRecurring(tenantId, id, params) {
  const existing = await recurringExpenseRepository.findById(tenantId, id);
  if (!existing) throw new NotFoundError('Recurring expense not found');
  const title = (params.title || '').trim() || existing.title;
  const amount = params.amount !== undefined ? Number(params.amount) : existing.amount;
  if (!Number.isFinite(amount) || amount < 0.01) throw new ValidationError('Amount must be at least 0.01');
  return recurringExpenseRepository.update(tenantId, id, { title, category: params.category || existing.category, amount, note: params.note });
}

/** Matches toggleRecurring's ON/OFF switch. */
async function setActive(tenantId, id, active) {
  const existing = await recurringExpenseRepository.findById(tenantId, id);
  if (!existing) throw new NotFoundError('Recurring expense not found');
  await recurringExpenseRepository.setActive(tenantId, id, active);
}

async function deleteRecurring(tenantId, id) {
  const existing = await recurringExpenseRepository.findById(tenantId, id);
  if (!existing) throw new NotFoundError('Recurring expense not found');
  await recurringExpenseRepository.remove(tenantId, id);
}

/**
 * Matches applyRecurringExpenses exactly (~line 12291-12310): for every
 * active recurring expense not yet applied this month, creates an
 * Expense row titled "<title> (Auto)" dated the 1st of the current month,
 * and stamps last_applied. Only ever invoked explicitly — no scheduler.
 * @param {number} tenantId @param {Date} [now] injectable for tests
 * @returns {Promise<number>} count applied
 */
async function applyForMonth(tenantId, now = new Date()) {
  const thisMonth = now.toISOString().slice(0, 7); // 'YYYY-MM'
  const firstOfMonth = thisMonth + '-01';
  const all = await recurringExpenseRepository.listByTenant(tenantId);
  let applied = 0;
  for (const re of all) {
    if (!re.is_active) continue;
    if (re.last_applied === thisMonth) continue;
    await expenseRepository.create({
      tenantId, title: `${re.title} (Auto)`, category: re.category, amount: re.amount,
      expenseDate: firstOfMonth, note: 'Auto-applied recurring expense',
    });
    await recurringExpenseRepository.setLastApplied(tenantId, re.id, thisMonth);
    applied += 1;
  }
  return applied;
}

module.exports = { listRecurring, createRecurring, updateRecurring, setActive, deleteRecurring, applyForMonth };
