/**
 * server/src/routes/license/index.js
 *
 * GET /api/license/status only — matches local.js:1152 exactly:
 * requireAuth ONLY, deliberately no requireActive/requireLicenseRead gate,
 * since this is the one endpoint that must stay reachable even for a
 * suspended/archived tenant (it's how the client finds out it's suspended
 * in the first place). No rate limit either, matching local.js exactly.
 */
'use strict';

const express = require('express');
const licenseController = require('../../controllers/licenseController');
const { requireAuth } = require('../../middleware/requireAuth');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createLicenseRouter({ jwtSecret }) {
  const router = express.Router();
  router.get('/status', requireAuth(jwtSecret), licenseController.getStatus);
  return router;
}

module.exports = { createLicenseRouter };
