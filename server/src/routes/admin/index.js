/**
 * server/src/routes/admin/index.js
 *
 * Administration domain (RC1 Sprint 2). Matches local.js's /api/admin/*
 * paths and rate limits exactly (local.js:1197-1652) — POST /login is the
 * only route without requireAdminSession, matching local.js's
 * requireAdminKey placement exactly (every other route requires it, login
 * is how you obtain it).
 */
'use strict';

const express = require('express');
const adminAuthController = require('../../controllers/adminAuthController');
const adminTenantController = require('../../controllers/adminTenantController');
const adminLicenseController = require('../../controllers/adminLicenseController');
const { requireAdminSession } = require('../../middleware/requireAdminSession');
const { rateLimit } = require('../../middleware/rateLimit');

/** @returns {import('express').Router} */
function createAdminRouter() {
  const router = express.Router();

  router.post('/login', rateLimit(10, 5 * 60 * 1000), adminAuthController.login);

  const auth = requireAdminSession;

  // ── Tenant Management / Admin Dashboard / User Administration ─────────
  router.post('/tenant/status', auth, rateLimit(30, 60 * 1000), adminTenantController.setTenantStatus);
  router.get('/tenants', auth, adminTenantController.listTenants);
  router.get('/web-users', auth, adminTenantController.listWebUsers);
  router.post('/reset-user-pin', auth, rateLimit(30, 60 * 1000), adminTenantController.resetUserPin);
  router.post('/toggle-user', auth, rateLimit(30, 60 * 1000), adminTenantController.toggleUser);

  // ── Registration Approval ──────────────────────────────────────────────
  router.get('/registrations', auth, adminLicenseController.listRegistrations);
  router.post('/registrations/:tenantId/approve', auth, rateLimit(30, 60 * 1000), adminLicenseController.approveRegistration);
  router.post('/registrations/:tenantId/reject', auth, rateLimit(30, 60 * 1000), adminLicenseController.rejectRegistration);

  // ── Subscription Administration / License Management ──────────────────
  router.get('/tenant-licenses', auth, adminLicenseController.listTenantLicenses);
  router.get('/tenant-licenses/:tenantId/history', auth, adminLicenseController.getHistory);
  router.post('/tenant-licenses/:tenantId/assign-plan', auth, rateLimit(30, 60 * 1000), adminLicenseController.assignPlan);
  router.post('/tenant-licenses/:tenantId/start-trial', auth, rateLimit(30, 60 * 1000), adminLicenseController.startTrial);
  router.post('/tenant-licenses/:tenantId/generate-license', auth, rateLimit(30, 60 * 1000), adminLicenseController.generateLicense);
  router.post('/tenant-licenses/:tenantId/extend', auth, rateLimit(30, 60 * 1000), adminLicenseController.extend);
  router.post('/tenant-licenses/:tenantId/suspend', auth, rateLimit(30, 60 * 1000), adminLicenseController.suspend);
  router.post('/tenant-licenses/:tenantId/reactivate', auth, rateLimit(30, 60 * 1000), adminLicenseController.reactivate);
  router.post('/tenant-licenses/:tenantId/kill-sessions', auth, rateLimit(30, 60 * 1000), adminLicenseController.killSessions);
  router.post('/tenant-licenses/:tenantId/notes', auth, rateLimit(60, 60 * 1000), adminLicenseController.addNote);
  router.post('/tenant-licenses/:tenantId/call-note', auth, rateLimit(60, 60 * 1000), adminLicenseController.addCallNote);

  // ── Device Management ───────────────────────────────────────────────────
  router.get('/tenant-licenses/:tenantId/devices', auth, adminLicenseController.listDevices);
  router.post('/tenant-licenses/:tenantId/devices/:rowId/remove', auth, rateLimit(60, 60 * 1000), adminLicenseController.removeDevice);
  router.post('/tenant-licenses/:tenantId/devices/reset-all', auth, rateLimit(30, 60 * 1000), adminLicenseController.resetAllDevices);
  router.post('/tenant-licenses/:tenantId/devices/limit', auth, rateLimit(30, 60 * 1000), adminLicenseController.setDeviceLimit);

  return router;
}

module.exports = { createAdminRouter };
