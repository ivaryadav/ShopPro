/**
 * server/src/routes/users/index.js
 *
 * Matches local.js's GET /api/data/users exactly — same path (mounted at
 * /api/data by server/src/app.js), same middleware chain, same lack of a
 * role gate (any authenticated, active tenant user may list users; see
 * migrations/001_identity_tenant_core.sql's note on why no permission is
 * seeded for this route).
 */
'use strict';

const express = require('express');
const userController = require('../../controllers/userController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createUsersRouter({ jwtSecret }) {
  const router = express.Router();
  router.get('/users', requireAuth(jwtSecret), requireActive, userController.listUsers);
  return router;
}

module.exports = { createUsersRouter };
