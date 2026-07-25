/**
 * server/src/routes/repairs/index.js — REST endpoints for Repair/RepairPart.
 *
 * Rate limiting (Phase 6): see routes/inventory/index.js's header for the
 * full rationale.
 */
'use strict';

const express = require('express');
const repairController = require('../../controllers/repairController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');
const { rateLimit } = require('../../middleware/rateLimit');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createRepairsRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive, rateLimit(120, 60 * 1000)];
  router.get('/', ...auth, repairController.list);
  router.get('/:id', ...auth, repairController.getOne);
  router.post('/', ...auth, repairController.create);
  router.post('/:id/parts', ...auth, repairController.addPart);
  router.delete('/:id/parts/:partId', ...auth, repairController.removePart);
  router.put('/:id/financials', ...auth, repairController.updateFinancials);
  router.put('/:id/status', ...auth, repairController.updateStatus);
  router.post('/:id/payments', ...auth, repairController.collectPayment);
  router.delete('/:id', ...auth, repairController.remove);
  return router;
}

module.exports = { createRepairsRouter };
