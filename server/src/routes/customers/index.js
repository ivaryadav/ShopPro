/**
 * server/src/routes/customers/index.js — REST endpoints for Customer.
 *
 * Rate limiting (Phase 6): see routes/inventory/index.js's header for the
 * full rationale — a gap found during Phase 5's parity review, fixed
 * consistently across every Operations route group.
 */
'use strict';

const express = require('express');
const customerController = require('../../controllers/customerController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');
const { rateLimit } = require('../../middleware/rateLimit');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createCustomersRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive, rateLimit(120, 60 * 1000)];
  router.get('/', ...auth, customerController.list);
  router.get('/:id', ...auth, customerController.getOne);
  router.post('/', ...auth, customerController.create);
  router.put('/:id', ...auth, customerController.update);
  return router;
}

module.exports = { createCustomersRouter };
