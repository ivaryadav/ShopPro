/**
 * server/src/routes/expenses/index.js — REST endpoints for Expense,
 * RecurringExpense, and manual cash-book entries.
 *
 * Rate limiting (Phase 6): see routes/inventory/index.js's header for the
 * full rationale.
 */
'use strict';

const express = require('express');
const expenseController = require('../../controllers/expenseController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');
const { rateLimit } = require('../../middleware/rateLimit');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createExpensesRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive, rateLimit(120, 60 * 1000)];
  router.get('/', ...auth, expenseController.list);
  router.post('/', ...auth, expenseController.create);
  router.delete('/:id', ...auth, expenseController.remove);

  router.get('/recurring', ...auth, expenseController.listRecurring);
  router.post('/recurring', ...auth, expenseController.createRecurring);
  router.put('/recurring/:id', ...auth, expenseController.updateRecurring);
  router.put('/recurring/:id/active', ...auth, expenseController.setRecurringActive);
  router.delete('/recurring/:id', ...auth, expenseController.removeRecurring);
  router.post('/recurring/apply', ...auth, expenseController.applyRecurring);

  router.get('/cash-entries', ...auth, expenseController.listCashEntries);
  router.post('/cash-entries', ...auth, expenseController.createCashEntry);
  return router;
}

module.exports = { createExpensesRouter };
