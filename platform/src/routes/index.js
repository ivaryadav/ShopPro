/**
 * platform/src/routes/index.js — every /api/platform/* route in one place.
 * Everything except /auth/login requires requirePlatformAuth; mutating
 * actions additionally require a specific permission via requirePermission.
 */
'use strict';

const express = require('express');
const { requirePlatformAuth } = require('../middleware/requirePlatformAuth');
const { requirePermission } = require('../middleware/requirePermission');
const { rateLimit } = require('../middleware/rateLimit');

const authController = require('../controllers/authController');
const dashboardController = require('../controllers/dashboardController');
const productController = require('../controllers/productController');
const organizationController = require('../controllers/organizationController');
const licenseController = require('../controllers/licenseController');
const customerController = require('../controllers/customerController');
const auditController = require('../controllers/auditController');
const platformUserController = require('../controllers/platformUserController');
const healthController = require('../controllers/healthController');
const alertController = require('../controllers/alertController');
const reportController = require('../controllers/reportController');

function createPlatformRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = requirePlatformAuth(jwtSecret);

  router.post('/auth/login', rateLimit(10, 5 * 60 * 1000), authController.login(jwtSecret));
  router.get('/auth/me', auth, authController.me);

  router.get('/dashboard/stats', auth, requirePermission('view_only'), dashboardController.stats);

  router.get('/products', auth, requirePermission('view_only'), productController.list);
  router.get('/products/:id', auth, requirePermission('view_only'), productController.getOne);
  router.post('/products', auth, requirePermission('manage_products'), rateLimit(30, 60 * 1000), productController.create);
  router.put('/products/:id', auth, requirePermission('manage_products'), rateLimit(30, 60 * 1000), productController.update);

  router.get('/organizations', auth, requirePermission('view_only'), organizationController.list);
  router.post('/organizations', auth, requirePermission('manage_organizations'), rateLimit(30, 60 * 1000), organizationController.create);
  router.get('/organizations/:id', auth, requirePermission('view_only'), organizationController.getOne);
  router.post('/organizations/:id/products', auth, requirePermission('manage_organizations'), rateLimit(30, 60 * 1000), organizationController.attachProduct);
  router.post('/organizations/:id/approve', auth, requirePermission('support_actions'), rateLimit(30, 60 * 1000), organizationController.approve);
  router.post('/organizations/:id/suspend', auth, requirePermission('support_actions'), rateLimit(30, 60 * 1000), organizationController.suspend);
  router.get('/organizations/:id/devices', auth, requirePermission('view_only'), organizationController.deviceList);
  router.post('/organizations/:id/devices/:deviceId/revoke', auth, requirePermission('support_actions'), rateLimit(60, 60 * 1000), organizationController.deviceRevoke);
  router.post('/organizations/:id/devices/:deviceId/rename', auth, requirePermission('support_actions'), rateLimit(60, 60 * 1000), organizationController.deviceRename);
  router.post('/organizations/:id/email', auth, requirePermission('support_actions'), rateLimit(20, 60 * 1000), organizationController.sendEmail);
  router.post('/organizations/:id/unlock', auth, requirePermission('support_actions'), rateLimit(30, 60 * 1000), organizationController.unlockAccount);
  router.post('/organizations/:id/force-password-reset', auth, requirePermission('support_actions'), rateLimit(30, 60 * 1000), organizationController.forcePasswordReset);
  router.post('/organizations/:id/kill-sessions', auth, requirePermission('support_actions'), rateLimit(30, 60 * 1000), organizationController.killSessions);
  router.get('/organizations/:id/login-history', auth, requirePermission('view_only'), organizationController.loginHistory);
  router.get('/organizations/:id/failed-logins', auth, requirePermission('view_only'), organizationController.failedLogins);

  // ── Organization 360 Workspace (Phase 5A) ──────────────────────────────
  router.get('/organizations/:id/notes', auth, requirePermission('view_only'), organizationController.notesList);
  router.post('/organizations/:id/notes', auth, requirePermission('support_actions'), rateLimit(60, 60 * 1000), organizationController.notesAdd);
  router.get('/organizations/:id/renewals', auth, requirePermission('view_only'), organizationController.renewals);
  router.get('/organizations/:id/security', auth, requirePermission('view_only'), organizationController.security);
  router.get('/organizations/:id/activity', auth, requirePermission('view_only'), organizationController.activity);

  router.post('/organizations/:orgId/licenses/:productId/activate', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.activate);
  router.post('/organizations/:orgId/licenses/:productId/suspend', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.suspend);
  router.post('/organizations/:orgId/licenses/:productId/resume', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.resume);
  router.post('/organizations/:orgId/licenses/:productId/renew', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.renew);
  router.post('/organizations/:orgId/licenses/:productId/change-plan', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.changePlan);

  router.get('/customers/search', auth, requirePermission('view_only'), customerController.search);

  router.get('/audit-log', auth, requirePermission('view_audit_log'), auditController.list);

  // ── System Health (Phase 5A) ────────────────────────────────────────────
  router.get('/health', auth, requirePermission('view_only'), healthController.health);

  // ── Alerts & Notifications Center (Phase 5A) ───────────────────────────
  router.get('/alerts', auth, requirePermission('view_only'), alertController.list);
  router.post('/alerts/:key/read', auth, requirePermission('view_only'), rateLimit(120, 60 * 1000), alertController.markRead);
  router.post('/alerts/:key/dismiss', auth, requirePermission('view_only'), rateLimit(120, 60 * 1000), alertController.markDismissed);

  // ── Reports & Trends (Phase 5A) ─────────────────────────────────────────
  router.get('/reports/trends', auth, requirePermission('view_only'), reportController.trends);

  router.get('/platform-users', auth, requirePermission('manage_platform_users'), platformUserController.list);
  router.post('/platform-users', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.create);
  router.post('/platform-users/:id/reset-password', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.resetPassword);
  router.post('/platform-users/:id/unlock', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.unlock);
  router.post('/platform-users/:id/force-logout', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.forceLogout);
  router.get('/platform-users/:id/login-history', auth, requirePermission('manage_platform_users'), platformUserController.loginHistory);

  return router;
}

module.exports = { createPlatformRouter };
