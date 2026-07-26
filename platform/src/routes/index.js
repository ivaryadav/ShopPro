/**
 * platform/src/routes/index.js — every /api/platform/* route in one place.
 * Everything except /auth/login requires requirePlatformAuth; mutating
 * actions additionally require a specific permission via requirePermission.
 */
'use strict';

const express = require('express');
const { requirePlatformAuth } = require('../middleware/requirePlatformAuth');
const { requirePlatformAuthOrApiKey } = require('../middleware/requirePlatformAuthOrApiKey');
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
const securityController = require('../controllers/securityController');
const apiKeyController = require('../controllers/apiKeyController');
const jobController = require('../controllers/jobController');
const maintenanceController = require('../controllers/maintenanceController');
const subscriptionController = require('../controllers/subscriptionController');
const billingController = require('../controllers/billingController');
const businessController = require('../controllers/businessController');

function createPlatformRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = requirePlatformAuth(jwtSecret);
  // Reachable WHILE a role-forced MFA enrollment is still pending — every
  // other route 403s with MFA_SETUP_REQUIRED until setup completes.
  const authMfaExempt = requirePlatformAuth(jwtSecret, { allowMfaSetupPending: true });
  // Read-only, easily-automated endpoints proven reachable via a Platform
  // API Key (X-Platform-Api-Key) as well as a human session — demonstrates
  // the "future-ready for external integrations" mechanism end to end
  // without retrofitting every existing mutating route in this pass.
  const authOrApiKey = requirePlatformAuthOrApiKey(jwtSecret);

  router.post('/auth/login', rateLimit(10, 5 * 60 * 1000), authController.login(jwtSecret));
  router.post('/auth/mfa/challenge', rateLimit(10, 5 * 60 * 1000), authController.mfaChallenge(jwtSecret));
  router.get('/auth/me', authMfaExempt, authController.me);
  router.post('/auth/mfa/setup', authMfaExempt, rateLimit(10, 60 * 1000), authController.mfaSetup);
  router.post('/auth/mfa/verify', authMfaExempt, rateLimit(10, 60 * 1000), authController.mfaVerify);
  router.post('/auth/mfa/disable', auth, rateLimit(10, 60 * 1000), authController.mfaDisable);
  router.post('/auth/mfa/recovery-codes/regenerate', auth, rateLimit(10, 60 * 1000), authController.mfaRegenerateRecoveryCodes);
  router.post('/auth/change-password', authMfaExempt, rateLimit(10, 60 * 1000), authController.changePassword);

  router.get('/dashboard/stats', authOrApiKey, requirePermission('view_only'), dashboardController.stats);

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

  // ── Organization 360 Expansion (Phase 5E) ──────────────────────────────
  router.get('/organizations/:id/subscription', auth, requirePermission('view_only'), organizationController.subscription);
  router.get('/organizations/:id/usage', auth, requirePermission('view_only'), organizationController.usage);
  router.get('/organizations/:id/billing', auth, requirePermission('view_billing'), organizationController.billing);
  router.get('/organizations/:id/license-history', auth, requirePermission('view_only'), organizationController.licenseHistory);
  router.get('/organizations/:id/renewal-history', auth, requirePermission('view_only'), organizationController.renewalHistory);

  router.post('/organizations/:orgId/licenses/:productId/activate', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.activate);
  router.post('/organizations/:orgId/licenses/:productId/assign', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.assign);
  router.post('/organizations/:orgId/licenses/:productId/suspend', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.suspend);
  router.post('/organizations/:orgId/licenses/:productId/resume', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.resume);
  router.post('/organizations/:orgId/licenses/:productId/renew', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.renew);
  router.post('/organizations/:orgId/licenses/:productId/change-plan', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.changePlan);
  router.post('/organizations/:orgId/licenses/:productId/cancel', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), licenseController.cancel);

  // ── License Center extensions (Phase 5E) ───────────────────────────────
  router.get('/licenses/expiration-dashboard', auth, requirePermission('view_only'), licenseController.expirationDashboard);
  router.get('/subscription-plans', auth, requirePermission('view_only'), licenseController.listPlans);
  router.post('/subscription-plans', auth, requirePermission('manage_licenses'), rateLimit(20, 60 * 1000), licenseController.createPlan);
  router.put('/subscription-plans/:id', auth, requirePermission('manage_licenses'), rateLimit(20, 60 * 1000), licenseController.updatePlan);

  // ── Subscription Center (Phase 5E) ─────────────────────────────────────
  router.get('/subscriptions', auth, requirePermission('view_only'), subscriptionController.list);
  router.get('/subscriptions/:orgId/:productId', auth, requirePermission('view_only'), subscriptionController.getOne);
  router.post('/subscriptions/:orgId/:productId/upgrade', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), subscriptionController.upgrade);
  router.post('/subscriptions/:orgId/:productId/downgrade', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), subscriptionController.downgrade);
  router.post('/subscriptions/:orgId/:productId/renew', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), subscriptionController.renew);
  router.post('/subscriptions/:orgId/:productId/suspend', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), subscriptionController.suspend);
  router.post('/subscriptions/:orgId/:productId/resume', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), subscriptionController.resume);
  router.post('/subscriptions/:orgId/:productId/cancel', auth, requirePermission('manage_licenses'), rateLimit(30, 60 * 1000), subscriptionController.cancel);

  // ── Billing Ledger (Phase 5E) ───────────────────────────────────────────
  router.get('/billing/dashboard', auth, requirePermission('view_billing'), billingController.dashboard);
  router.get('/billing/invoices', auth, requirePermission('view_billing'), billingController.listInvoices);
  router.get('/billing/invoices/:id/timeline', auth, requirePermission('view_billing'), billingController.invoiceTimeline);
  router.post('/billing/invoices', auth, requirePermission('manage_billing'), rateLimit(30, 60 * 1000), billingController.createInvoice);
  router.post('/billing/invoices/:id/send', auth, requirePermission('manage_billing'), rateLimit(30, 60 * 1000), billingController.sendInvoice);
  router.post('/billing/invoices/:id/void', auth, requirePermission('manage_billing'), rateLimit(30, 60 * 1000), billingController.voidInvoice);
  router.post('/billing/payments', auth, requirePermission('manage_billing'), rateLimit(30, 60 * 1000), billingController.recordPayment);
  router.post('/billing/adjustments', auth, requirePermission('manage_billing'), rateLimit(30, 60 * 1000), billingController.recordAdjustment);

  // ── Business Dashboard, Renewal Center, Business Reports (Phase 5E) ────
  router.get('/business/dashboard', auth, requirePermission('view_only'), businessController.dashboard);
  router.get('/business/renewals', auth, requirePermission('view_only'), businessController.renewalCenter);
  router.get('/business/reports', auth, requirePermission('view_only'), businessController.reports);

  router.get('/customers/search', auth, requirePermission('view_only'), customerController.search);

  router.get('/audit-log', auth, requirePermission('view_audit_log'), auditController.list);

  // ── System Health (Phase 5A) ────────────────────────────────────────────
  router.get('/health', authOrApiKey, requirePermission('view_only'), healthController.health);

  // ── Alerts & Notifications Center (Phase 5A) ───────────────────────────
  router.get('/alerts', auth, requirePermission('view_only'), alertController.list);
  router.post('/alerts/:key/read', auth, requirePermission('view_only'), rateLimit(120, 60 * 1000), alertController.markRead);
  router.post('/alerts/:key/dismiss', auth, requirePermission('view_only'), rateLimit(120, 60 * 1000), alertController.markDismissed);

  // ── Reports & Trends (Phase 5A) ─────────────────────────────────────────
  router.get('/reports/trends', auth, requirePermission('view_only'), reportController.trends);

  // ── Scheduled Jobs (Phase 5C) ────────────────────────────────────────────
  router.get('/jobs', auth, requirePermission('view_only'), jobController.list);
  router.post('/jobs/:name/run', auth, requirePermission('manage_platform_users'), rateLimit(10, 60 * 1000), jobController.runNow);

  // ── Platform Maintenance & Business Continuity (Phase 5D) ───────────────
  // Product-facing bulk pull — a real product (ShopERP's maintenanceSync.js)
  // authenticates via Platform API Key, never a human session.
  router.get('/maintenance/effective', authOrApiKey, requirePermission('view_only'), maintenanceController.effectiveForProduct);
  // Operator-facing management.
  router.get('/maintenance/policies', auth, requirePermission('view_only'), maintenanceController.list);
  router.get('/maintenance/policies/:id', auth, requirePermission('view_only'), maintenanceController.getOne);
  router.post('/maintenance/policies', auth, requirePermission('manage_products'), rateLimit(20, 60 * 1000), maintenanceController.create);
  router.put('/maintenance/policies/:id', auth, requirePermission('manage_products'), rateLimit(20, 60 * 1000), maintenanceController.edit);
  router.post('/maintenance/policies/:id/activate', auth, requirePermission('manage_products'), rateLimit(20, 60 * 1000), maintenanceController.activate);
  router.post('/maintenance/policies/:id/deactivate', auth, requirePermission('manage_products'), rateLimit(20, 60 * 1000), maintenanceController.deactivate);
  router.post('/maintenance/policies/:id/cancel', auth, requirePermission('manage_products'), rateLimit(20, 60 * 1000), maintenanceController.cancel);
  router.get('/maintenance/history', auth, requirePermission('view_only'), maintenanceController.history);
  router.get('/maintenance/resolve', auth, requirePermission('view_only'), maintenanceController.resolve);

  router.get('/platform-users', auth, requirePermission('manage_platform_users'), platformUserController.list);
  router.post('/platform-users', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.create);
  router.post('/platform-users/:id/reset-password', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.resetPassword);
  router.post('/platform-users/:id/unlock', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.unlock);
  router.post('/platform-users/:id/force-logout', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), platformUserController.forceLogout);
  router.get('/platform-users/:id/login-history', auth, requirePermission('manage_platform_users'), platformUserController.loginHistory);

  // ── Platform Security Center (Phase 5B) ─────────────────────────────────
  router.get('/security/overview', auth, requirePermission('view_only'), securityController.overview);
  router.get('/security/logs', auth, requirePermission('view_audit_log'), securityController.logs);

  router.get('/security/sessions', auth, requirePermission('manage_platform_users'), securityController.listSessions);
  router.post('/security/sessions/:sessionId/revoke', auth, requirePermission('manage_platform_users'), rateLimit(30, 60 * 1000), securityController.revokeSession);
  router.post('/security/sessions/terminate-all', auth, requirePermission('manage_platform_users'), rateLimit(5, 60 * 1000), securityController.terminateAllSessions);

  router.get('/security/trusted-devices', auth, requirePermission('manage_platform_users'), securityController.listAllTrustedDevices);
  router.post('/security/trusted-devices/:id/revoke', auth, requirePermission('manage_platform_users'), rateLimit(30, 60 * 1000), securityController.revokeTrustedDevice);
  router.get('/security/my/trusted-devices', auth, securityController.myTrustedDevices);
  router.post('/security/my/trusted-devices/:id/revoke', auth, rateLimit(30, 60 * 1000), securityController.revokeMyTrustedDevice);

  router.get('/security/password-policy', auth, requirePermission('view_only'), securityController.getPasswordPolicy);
  router.put('/security/password-policy', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), securityController.updatePasswordPolicy);

  // ── Platform API Keys (Phase 5B) ────────────────────────────────────────
  router.get('/api-keys', auth, requirePermission('manage_platform_users'), apiKeyController.list);
  router.post('/api-keys', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), apiKeyController.create);
  router.post('/api-keys/:id/rotate', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), apiKeyController.rotate);
  router.post('/api-keys/:id/revoke', auth, requirePermission('manage_platform_users'), rateLimit(20, 60 * 1000), apiKeyController.revoke);

  return router;
}

module.exports = { createPlatformRouter };
