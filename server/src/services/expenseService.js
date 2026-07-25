/**
 * server/src/services/expenseService.js
 *
 * Mirrors saveExpense/deleteExpense exactly (~line 12571-12586).
 */
'use strict';

const expenseRepository = require('../repositories/expenseRepository');
const { ValidationError, NotFoundError } = require('../errors');

async function listExpenses(tenantId) {
  return expenseRepository.listByTenant(tenantId);
}

/** Matches saveExpense's validation exactly (~line 12574-12577: title required, amount >= 0.01). */
async function createExpense(params) {
  const title = (params.title || '').trim();
  const amount = Number(params.amount);
  if (!title) throw new ValidationError('Title is required');
  if (!Number.isFinite(amount) || amount < 0.01) throw new ValidationError('Amount must be at least 0.01');
  return expenseRepository.create({
    tenantId: params.tenantId, title, category: params.category, amount, expenseDate: params.expenseDate, note: params.note,
  });
}

async function deleteExpense(tenantId, id) {
  const existing = await expenseRepository.findById(tenantId, id);
  if (!existing) throw new NotFoundError('Expense not found');
  await expenseRepository.remove(tenantId, id);
}

module.exports = { listExpenses, createExpense, deleteExpense };
