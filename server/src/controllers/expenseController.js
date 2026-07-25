/**
 * server/src/controllers/expenseController.js — request/response only (ADR-0005).
 * Covers Expense, RecurringExpense, and manual cash-book entries (Payment
 * source_type='manual') — three small, related concerns grouped under
 * one controller/route pair rather than three near-empty files each.
 */
'use strict';

const expenseService = require('../services/expenseService');
const recurringExpenseService = require('../services/recurringExpenseService');
const paymentService = require('../services/paymentService');

/** @type {import('express').RequestHandler} */
async function list(req, res, next) {
  try {
    res.json({ expenses: await expenseService.listExpenses(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function create(req, res, next) {
  try {
    const expense = await expenseService.createExpense({ ...req.body, tenantId: req.user.tenantId });
    res.status(201).json({ expense });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function remove(req, res, next) {
  try {
    await expenseService.deleteExpense(req.user.tenantId, Number(req.params.id));
    res.json({ message: 'Expense deleted' });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function listRecurring(req, res, next) {
  try {
    res.json({ recurringExpenses: await recurringExpenseService.listRecurring(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function createRecurring(req, res, next) {
  try {
    const recurringExpense = await recurringExpenseService.createRecurring({ ...req.body, tenantId: req.user.tenantId });
    res.status(201).json({ recurringExpense });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function updateRecurring(req, res, next) {
  try {
    const recurringExpense = await recurringExpenseService.updateRecurring(req.user.tenantId, Number(req.params.id), req.body);
    res.json({ recurringExpense });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function setRecurringActive(req, res, next) {
  try {
    await recurringExpenseService.setActive(req.user.tenantId, Number(req.params.id), !!req.body.active);
    res.json({ message: 'Updated' });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function removeRecurring(req, res, next) {
  try {
    await recurringExpenseService.deleteRecurring(req.user.tenantId, Number(req.params.id));
    res.json({ message: 'Recurring expense deleted' });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function applyRecurring(req, res, next) {
  try {
    const applied = await recurringExpenseService.applyForMonth(req.user.tenantId);
    res.json({ applied });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function listCashEntries(req, res, next) {
  try {
    res.json({ cashEntries: await paymentService.listManualEntries(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function createCashEntry(req, res, next) {
  try {
    const entry = await paymentService.createManualEntry({ ...req.body, tenantId: req.user.tenantId });
    res.status(201).json({ entry });
  } catch (e) { next(e); }
}

module.exports = {
  list, create, remove, listRecurring, createRecurring, updateRecurring,
  setRecurringActive, removeRecurring, applyRecurring, listCashEntries, createCashEntry,
};
