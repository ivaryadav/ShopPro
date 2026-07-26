/**
 * platform/src/adapters/shoperpAdapter.js
 *
 * The ONLY file in this whole platform that knows anything about ShopERP
 * specifically. Everything else in Z-SUPERADMIN (organizationService,
 * licenseService, dashboardController, etc.) is product-agnostic — it
 * calls this adapter's generic-shaped functions without knowing or caring
 * that "shoperp" means SQLite/local.js/tenant_licenses under the hood.
 *
 * "Reuse existing services, don't rebuild" (Z-SUPERADMIN migration mission):
 * every function below is a thin HTTP client wrapping an ALREADY-BUILT
 * ShopERP admin endpoint (built across RC1 Sprint 2 and the Super Admin
 * Portal work) — no ShopERP business logic is reimplemented here, only
 * called. ShopERP's own /api/admin/* routes are completely unaware that
 * Z-SUPERADMIN exists; they authenticate this adapter exactly the same
 * way they'd authenticate a human operator typing the admin password in
 * — via the real POST /api/admin/login endpoint, unmodified.
 *
 * A future ZLAB/ZHospital/etc. adapter would follow this exact shape:
 * one file, own base URL + credential, same generic function signatures.
 */
'use strict';

const { loadEnv } = require('../config/env');

let _tokenCache = { token: null, expiresAt: 0 };

function getConfig(source) {
  const env = loadEnv(source);
  return { baseUrl: env.SHOPERP_BASE_URL, password: env.SHOPERP_ADMIN_PASSWORD };
}

function isConfigured(source) {
  const { baseUrl, password } = getConfig(source);
  return !!(baseUrl && password);
}

async function getToken(source) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const { baseUrl, password } = getConfig(source);
  if (!baseUrl || !password) throw new Error('ShopERP adapter is not configured (SHOPERP_BASE_URL/SHOPERP_ADMIN_PASSWORD missing)');
  const res = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }).then((r) => r.json());
  if (!res.adminToken) throw new Error('ShopERP admin login failed: ' + (res.error || 'unknown error'));
  // ShopERP's admin sessions last 12h — refresh a little early to avoid a
  // request racing against the exact expiry instant.
  _tokenCache = { token: res.adminToken, expiresAt: Date.now() + 11.5 * 60 * 60 * 1000 };
  return _tokenCache.token;
}

/** Calls a ShopERP admin endpoint, retrying once with a fresh token on 401. */
async function call(method, path, body, source) {
  const { baseUrl } = getConfig(source);
  let token = await getToken(source);
  const doFetch = (tok) => fetch(baseUrl + path, {
    method, headers: Object.assign({ 'X-Admin-Key': tok }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch(token);
  if (res.status === 401) {
    _tokenCache = { token: null, expiresAt: 0 };
    token = await getToken(source);
    res = await doFetch(token);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && (data.error.message || data.error)) || 'ShopERP request failed'); e.status = res.status; throw e; }
  return data;
}

// ── Mapping helpers: ShopERP's tenant shape -> Z-SUPERADMIN's generic Organization/License shape ──
function mapCustomerToOrganization(c) {
  return {
    source: 'shoperp', sourceId: c.tenantId,
    id: 'shoperp:' + c.tenantId, // synthetic, stable, product-prefixed ID for cross-product uniqueness
    businessName: c.shopName, ownerName: c.ownerName, email: c.email, phone: c.mobile,
    gstNumber: c.gstNumber, status: c.status, createdAt: c.createdAt,
    license: { licenseKey: c.licenseKey, planCode: c.planCode, status: c.status, expiresAt: c.expiresAt },
    devicesUsed: c.devicesUsed, deviceLimit: c.deviceLimit, lastLogin: c.lastLogin,
  };
}

async function getDashboardStats(source) {
  const d = await call('GET', '/api/admin/dashboard-stats', undefined, source);
  return {
    totalOrganizations: d.totalShops, pendingRegistrations: d.pendingRegistrations,
    activeLicenses: d.activeLicenses, expiredLicenses: d.expiredLicenses, suspendedLicenses: d.suspendedLicenses,
    expiringWithin30Days: d.expiringWithin30Days, totalDevices: d.totalDevices, onlineToday: d.onlineShopsToday,
    recentOrganizations: (d.recentRegistrations || []).map((r) => ({
      id: 'shoperp:' + r.tenantId, sourceId: r.tenantId, source: 'shoperp',
      businessName: r.shopName, ownerName: r.ownerName, email: r.email, createdAt: r.createdAt,
    })),
  };
}

async function listOrganizations(query, source) {
  const qs = new URLSearchParams();
  if (query.q) qs.set('q', query.q);
  if (query.status) qs.set('status', query.status);
  if (query.plan) qs.set('plan', query.plan);
  if (query.page) qs.set('page', query.page);
  if (query.pageSize) qs.set('pageSize', query.pageSize);
  if (query.sort) qs.set('sort', query.sort);
  if (query.dir) qs.set('dir', query.dir);
  const d = await call('GET', '/api/admin/customers?' + qs.toString(), undefined, source);
  return { organizations: (d.customers || []).map(mapCustomerToOrganization), total: d.total, page: d.page, pageSize: d.pageSize };
}

async function getOrganization(tenantId, source) {
  const d = await call('GET', `/api/admin/customers/${tenantId}`, undefined, source);
  return {
    business: {
      businessName: d.business.shopName, ownerName: d.business.ownerName, email: d.business.email,
      phone: d.business.phone, address: d.business.address, gstNumber: d.business.gstNumber, createdAt: d.business.createdAt,
    },
    license: d.license ? { licenseKey: d.license.licenseKey, planCode: d.license.planCode, billingCycle: d.license.billingCycle, status: d.license.status, activatedAt: d.license.activatedAt, expiresAt: d.license.expiresAt, daysRemaining: d.license.daysRemaining } : null,
    devices: (d.devices || []).map((dev) => ({ id: dev.id, deviceId: dev.deviceId, deviceName: dev.deviceName, browser: dev.browser, os: dev.os, lastSeen: dev.lastSeen, isActive: dev.isActive })),
    activity: d.activity,
    history: (d.history || []).map((h) => ({ eventType: h.event_type, oldValue: h.from_status, newValue: h.to_status, detail: h.detail, actor: h.actor, timestamp: h.created_at })),
  };
}

async function approveRegistration(tenantId, source) { return call('POST', `/api/admin/registrations/${tenantId}/approve`, {}, source); }
async function rejectRegistration(tenantId, reason, source) { return call('POST', `/api/admin/registrations/${tenantId}/reject`, { reason }, source); }
async function extendLicense(tenantId, days, source) { return call('POST', `/api/admin/tenant-licenses/${tenantId}/extend`, { days }, source); }
async function suspendTenant(tenantId, reason, source) { return call('POST', `/api/admin/tenant-licenses/${tenantId}/suspend`, { reason }, source); }
async function reactivateTenant(tenantId, source) { return call('POST', `/api/admin/tenant-licenses/${tenantId}/reactivate`, {}, source); }
async function killSessions(tenantId, source) { return call('POST', `/api/admin/tenant-licenses/${tenantId}/kill-sessions`, {}, source); }
async function assignPlan(tenantId, planCode, billingCycle, source) { return call('POST', `/api/admin/tenant-licenses/${tenantId}/assign-plan`, { planCode, billingCycle }, source); }

async function unlockAccount(tenantId, source) { return call('POST', `/api/admin/customers/${tenantId}/unlock`, {}, source); }
async function forcePasswordReset(tenantId, source) { return call('POST', `/api/admin/customers/${tenantId}/force-password-reset`, {}, source); }
async function getLoginHistory(tenantId, source) { const d = await call('GET', `/api/admin/customers/${tenantId}/login-history`, undefined, source); return d.logins || []; }
async function getFailedLogins(tenantId, source) { const d = await call('GET', `/api/admin/customers/${tenantId}/failed-logins`, undefined, source); return d.failedLogins || []; }
async function renameDevice(tenantId, deviceRowId, deviceName, source) { return call('POST', `/api/admin/customers/${tenantId}/devices/${deviceRowId}/rename`, { deviceName }, source); }
async function revokeDevice(tenantId, deviceRowId, source) { return call('POST', `/api/admin/tenant-licenses/${tenantId}/devices/${deviceRowId}/remove`, {}, source); }
async function sendEmail(tenantId, type, extra, source) { return call('POST', `/api/admin/customers/${tenantId}/email/${type}`, extra || {}, source); }

async function getAuditLog(query, source) {
  const qs = new URLSearchParams();
  if (query.tenantId) qs.set('tenantId', query.tenantId);
  if (query.eventType) qs.set('eventType', query.eventType);
  if (query.page) qs.set('page', query.page);
  if (query.pageSize) qs.set('pageSize', query.pageSize);
  const d = await call('GET', '/api/admin/audit-log?' + qs.toString(), undefined, source);
  return {
    entries: (d.entries || []).map((e) => ({
      id: e.id, organizationId: 'shoperp:' + e.tenantId, sourceId: e.tenantId, organization: e.shopName,
      admin: e.admin, action: e.eventType, oldValue: e.oldValue, newValue: e.newValue, detail: e.detail, timestamp: e.timestamp,
    })),
    total: d.total, page: d.page, pageSize: d.pageSize,
  };
}

async function search(q, source) {
  const d = await call('GET', '/api/admin/search?q=' + encodeURIComponent(q), undefined, source);
  return (d.results || []).map((r) => ({
    organizationId: 'shoperp:' + r.tenantId, sourceId: r.tenantId, source: 'shoperp',
    businessName: r.shopName, ownerName: r.ownerName, email: r.email, phone: r.mobile, status: r.status,
  }));
}

module.exports = {
  isConfigured, getDashboardStats, listOrganizations, getOrganization,
  approveRegistration, rejectRegistration, extendLicense, suspendTenant, reactivateTenant, killSessions, assignPlan,
  unlockAccount, forcePasswordReset, getLoginHistory, getFailedLogins, renameDevice, revokeDevice, sendEmail,
  getAuditLog, search,
  _resetTokenCacheForTests() { _tokenCache = { token: null, expiresAt: 0 }; },
};
