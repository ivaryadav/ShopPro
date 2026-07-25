/**
 * server/src/routes/inventory/index.js
 *
 * REST endpoints for InventoryItem. local.js has no per-entity endpoints
 * for Operations data at all (everything goes through the single
 * GET/PUT /api/data whole-blob path) — real per-entity endpoints are a
 * necessary, approved consequence of ADR-0008's normalization decision,
 * not new scope invented by this phase.
 *
 * Rate limiting (Phase 6): every Operations route group gets the same
 * rateLimit(120, 60s) applied right after auth — a gap found during
 * Phase 5's parity review (these 6 route groups were the only ones in
 * `server/src/` with no rate limit at all, unlike every auth-related
 * route in both this codebase and local.js). 120/min is a deliberately
 * generous, business-usage-appropriate limit (these are authenticated,
 * already-gated endpoints, not public/unauthenticated ones like login) —
 * it exists to catch a runaway client bug or a compromised account, not
 * to throttle normal POS usage.
 */
'use strict';

const express = require('express');
const inventoryController = require('../../controllers/inventoryController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');
const { rateLimit } = require('../../middleware/rateLimit');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createInventoryRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive, rateLimit(120, 60 * 1000)];
  router.get('/', ...auth, inventoryController.list);
  router.get('/:id', ...auth, inventoryController.getOne);
  router.post('/', ...auth, inventoryController.create);
  router.put('/:id', ...auth, inventoryController.update);
  router.post('/:id/adjust-stock', ...auth, inventoryController.adjustStock);
  router.delete('/:id', ...auth, inventoryController.remove);
  return router;
}

module.exports = { createInventoryRouter };
