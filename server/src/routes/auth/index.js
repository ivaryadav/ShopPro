/**
 * server/src/routes/auth/index.js
 *
 * Wires routes -> middleware -> controllers. Paths match server/local.js
 * exactly ("API compatibility preserved where possible" — Phase 2 mission).
 *
 * NOT wired in this phase: POST /api/auth/register, POST /api/auth/signup
 * (both create a tenant_licenses row as an integral part of registration —
 * Licensing domain, out of scope), POST /api/auth/renew-license (pure
 * Licensing). See docs/database/MigrationNotes.md.
 */
'use strict';

const express = require('express');
const authController = require('../../controllers/authController');
const sessionController = require('../../controllers/sessionController');
const userController = require('../../controllers/userController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');
const { requirePermission } = require('../../middleware/requirePermission');
const { rateLimit } = require('../../middleware/rateLimit');

/**
 * @param {{jwtSecret: string}} deps
 * @returns {import('express').Router}
 */
function createAuthRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = requireAuth(jwtSecret);

  router.post('/login', rateLimit(10, 5 * 60 * 1000), authController.login(jwtSecret));
  router.post('/refresh', rateLimit(30, 5 * 60 * 1000), authController.refresh(jwtSecret));
  router.post('/logout', auth, authController.logout);
  router.post('/heartbeat', auth, authController.heartbeat);

  router.get(
    '/sessions',
    auth, requireActive, requirePermission('sessions:view', 'Only the owner can view active sessions'),
    sessionController.list
  );
  router.post('/sessions/:sessionId/revoke', auth, requirePermission('sessions:revoke', 'Only the owner can revoke a session'), sessionController.revoke);

  router.post(
    '/add-staff',
    auth, requireActive, requirePermission('staff:add', 'Only the owner can add staff'),
    userController.addStaff
  );

  return router;
}

module.exports = { createAuthRouter };
