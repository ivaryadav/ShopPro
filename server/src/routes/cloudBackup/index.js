/**
 * server/src/routes/cloudBackup/index.js
 *
 * Matches local.js:1753-1784 exactly, including gating (requireAdminKey
 * equivalent — Sprint 2's requireAdminSession, reused unmodified per
 * this sprint's "Do NOT touch: Administration" honored via integration,
 * not modification) and the deliberate absence of any rate limit on
 * these 3 endpoints (a real, pre-existing local.js characteristic,
 * preserved as-is — see docs/architecture/Backup.md's Security Review
 * for why this was flagged, not silently fixed, in this sprint).
 */
'use strict';

const express = require('express');
const cloudBackupController = require('../../controllers/cloudBackupController');
const { requireAdminSession } = require('../../middleware/requireAdminSession');

/** @returns {import('express').Router} */
function createCloudBackupRouter() {
  const router = express.Router();
  router.post('/backup', requireAdminSession, cloudBackupController.createOrUpdate);
  router.get('/restore/:keyHash', requireAdminSession, cloudBackupController.restore);
  router.delete('/backup/:keyHash', requireAdminSession, cloudBackupController.remove);
  return router;
}

module.exports = { createCloudBackupRouter };
