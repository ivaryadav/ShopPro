/**
 * server/src/routes/inventory/index.js
 *
 * REST endpoints for InventoryItem. local.js has no per-entity endpoints
 * for Operations data at all (everything goes through the single
 * GET/PUT /api/data whole-blob path) — real per-entity endpoints are a
 * necessary, approved consequence of ADR-0008's normalization decision,
 * not new scope invented by this phase.
 */
'use strict';

const express = require('express');
const inventoryController = require('../../controllers/inventoryController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createInventoryRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive];
  router.get('/', ...auth, inventoryController.list);
  router.get('/:id', ...auth, inventoryController.getOne);
  router.post('/', ...auth, inventoryController.create);
  router.put('/:id', ...auth, inventoryController.update);
  router.post('/:id/adjust-stock', ...auth, inventoryController.adjustStock);
  router.delete('/:id', ...auth, inventoryController.remove);
  return router;
}

module.exports = { createInventoryRouter };
