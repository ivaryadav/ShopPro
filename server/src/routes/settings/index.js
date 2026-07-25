/**
 * server/src/routes/settings/index.js — REST endpoints for Configuration
 * (tenant_settings, kept as JSON per ADR-0008).
 *
 * Rate limiting (Phase 6): see routes/inventory/index.js's header for the
 * full rationale.
 */
'use strict';

const express = require('express');
const settingsController = require('../../controllers/settingsController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');
const { rateLimit } = require('../../middleware/rateLimit');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createSettingsRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive, rateLimit(120, 60 * 1000)];
  router.get('/', ...auth, settingsController.get);
  router.put('/', ...auth, settingsController.put);
  return router;
}

module.exports = { createSettingsRouter };
