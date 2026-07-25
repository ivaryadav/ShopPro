/**
 * server/src/services/tenantLicenseService.js
 *
 * Mirrors local.js's Licensing business rules exactly (RC1 Sprint 1
 * mission: License, Subscription, Activation, Renewal, Expiry, Grace
 * Period, Device Limits). Every function below cites the exact local.js
 * line range it reproduces — see docs/architecture/Licensing.md for the
 * consolidated narrative and every deliberate, disclosed deviation.
 *
 * Explicitly NOT touched by this sprint, per its own mission: Inventory/
 * Sales/Repairs/Expenses (Operations), the frontend, Administration
 * (admin_credentials/admin sessions — so no route here is gated the way
 * local.js's `requireAdminKey` gates the equivalent endpoints; these
 * remain service-layer-only, same precedent as Phase 2's resetPin/
 * setActive), Cloud Backup, and Authentication (trusted_devices' own
 * table/repository/service are untouched — see
 * tenantLicenseRepository.js's header for the one necessary exception,
 * a session-kill query, and why it doesn't count as "touching" that domain).
 */
'use strict';

const crypto = require('crypto');
const tenantLicenseRepository = require('../repositories/tenantLicenseRepository');
const subscriptionPlanRepository = require('../repositories/subscriptionPlanRepository');
const licenseHistoryRepository = require('../repositories/licenseHistoryRepository');
const { ValidationError, NotFoundError, ConflictError, BusinessRuleError } = require('../errors');

// billing_cycle -> duration in days; 'lifetime' never expires (expires_at = null).
// Matches local.js:344 exactly.
const BILLING_CYCLE_DAYS = { trial: 14, monthly: 30, halfyearly: 180, yearly: 365, lifetime: null };
const LICENSE_KEY_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // matches local.js:323 exactly (no 0/O/1/I)
const DEVICE_BUCKETS = ['1-2', '3-5', '5+']; // matches local.js:845

/** Matches generateHostedLicenseKey exactly (local.js:324-336). @returns {Promise<string>} */
async function generateLicenseKey() {
  const group = () => {
    const b = crypto.randomBytes(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += LICENSE_KEY_CHARSET[b[i] % LICENSE_KEY_CHARSET.length];
    return s;
  };
  for (let i = 0; i < 20; i++) {
    const key = 'SHOP-' + group() + '-' + group() + '-' + group();
    if (!(await tenantLicenseRepository.licenseKeyExists(key))) return key;
  }
  throw new Error('Could not generate a unique license key after 20 attempts');
}

/**
 * The Licensing-only half of /api/auth/signup (local.js:842-846, 871-875)
 * — creating the tenant/user/tenant_data rows is Identity-domain, out of
 * scope here. A future Identity-domain phase composing the full signup
 * flow must wrap this call together with tenant/user creation in one
 * transaction, exactly as local.js's own `db.transaction(...)` does,
 * since the whole point of that transaction (TenantStatusConsistency.md,
 * Blocker 3) is that a tenant is never left without a tenant_licenses row.
 * @param {{tenantId:number,requestedPlan?:string,requestedDevicesBucket?:string,requestedModules?:string[]}} params
 */
async function createPendingLicense(params) {
  const requested = await subscriptionPlanRepository.findActiveByCode(String(params.requestedPlan || 'TRIAL').toUpperCase());
  const plan = requested || (await subscriptionPlanRepository.findActiveByCode('TRIAL'));
  const devicesBucket = DEVICE_BUCKETS.includes(params.requestedDevicesBucket) ? params.requestedDevicesBucket : null;
  const modules = Array.isArray(params.requestedModules) ? params.requestedModules.filter((m) => typeof m === 'string').slice(0, 20) : [];

  const license = await tenantLicenseRepository.createPending({
    tenantId: params.tenantId, planCode: plan.code, requestedPlanCode: plan.code,
    deviceLimit: plan.device_limit, requestedDevicesBucket: devicesBucket, requestedModules: modules,
  });
  await licenseHistoryRepository.record({
    tenantId: params.tenantId, eventType: 'REGISTERED', toStatus: 'PENDING_APPROVAL', detail: `requested plan ${plan.code}`,
  });
  return license;
}

/**
 * Matches assignPlanToTenant exactly (local.js:348-362) — shared by
 * assignPlan/startTrial/the approve auto-default, same as local.js.
 * @param {number} tenantId @param {string} planCode @param {string} billingCycle @param {number} [deviceLimitOverride]
 */
async function assignPlanToTenant(tenantId, planCode, billingCycle, deviceLimitOverride) {
  const plan = await subscriptionPlanRepository.findActiveByCode(String(planCode || '').toUpperCase());
  if (!plan) throw new ValidationError('Unknown plan code');
  if (!Object.prototype.hasOwnProperty.call(BILLING_CYCLE_DAYS, billingCycle)) {
    throw new ValidationError('billingCycle must be one of: ' + Object.keys(BILLING_CYCLE_DAYS).join(', '));
  }
  const days = BILLING_CYCLE_DAYS[billingCycle];
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400000);
  const deviceLimit = (typeof deviceLimitOverride === 'number' && deviceLimitOverride > 0) ? deviceLimitOverride : plan.device_limit;
  await tenantLicenseRepository.assignPlan(tenantId, { planCode: plan.code, billingCycle, deviceLimit, expiresAt });
  return { planCode: plan.code, billingCycle, deviceLimit, expiresAt };
}

/**
 * Matches the assign-plan ADMIN ACTION exactly (local.js:1490-1501) — a
 * thin wrapper around assignPlanToTenant above that additionally requires
 * an existing tenant_licenses row and logs a PLAN_ASSIGNED history event.
 * Distinct from assignPlanToTenant itself, which is the shared, non-
 * logging helper local.js's own code also uses internally from
 * startTrial/approveRegistration (each of which logs its own, different
 * event type instead — TRIAL_STARTED / APPROVED).
 * @param {number} tenantId @param {string} planCode @param {string} billingCycle @param {number} [deviceLimitOverride]
 */
async function assignPlan(tenantId, planCode, billingCycle, deviceLimitOverride) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  const result = await assignPlanToTenant(tenantId, planCode, billingCycle, deviceLimitOverride);
  await licenseHistoryRepository.record({ tenantId, eventType: 'PLAN_ASSIGNED', detail: `${result.planCode}/${result.billingCycle}, device_limit=${result.deviceLimit}`, actor: 'admin' });
  return result;
}

/** Matches the start-trial endpoint exactly (local.js:1504-1515). @param {number} tenantId */
async function startTrial(tenantId) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  const result = await assignPlanToTenant(tenantId, 'TRIAL', 'trial');
  await licenseHistoryRepository.record({ tenantId, eventType: 'TRIAL_STARTED', detail: `expires ${result.expiresAt}` });
  return result;
}

/**
 * Matches the approve endpoint exactly (local.js:1401-1433), MINUS the
 * owner-email-verification gate (local.js:1408-1411): that check reads
 * users.email_verified_at, a column that only exists in local.js's SQLite
 * schema as part of the signup/email-verification flow — Identity-domain,
 * out of scope for this sprint (Phase 2's users table, migrations/001,
 * has no email-verification columns at all). Documented here, not
 * silently dropped: a future phase that ports email verification to
 * Identity domain must add this gate back before this function is relied
 * on for a real approval flow.
 * @param {number} tenantId
 */
async function approveRegistration(tenantId) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  if (lic.status !== 'PENDING_APPROVAL') {
    throw new BusinessRuleError(`This registration is not pending approval (current status: ${lic.status})`, 'NOT_PENDING_APPROVAL');
  }
  let planResult = null;
  if (!lic.starts_at) {
    planResult = await assignPlanToTenant(tenantId, 'TRIAL', 'trial');
  }
  if (!lic.license_key) {
    const key = await generateLicenseKey();
    await tenantLicenseRepository.setLicenseKey(tenantId, key);
  }
  await tenantLicenseRepository.markActive(tenantId);
  await licenseHistoryRepository.record({
    tenantId, eventType: 'APPROVED', fromStatus: 'PENDING_APPROVAL', toStatus: 'ACTIVE',
    detail: planResult ? `auto-defaulted to ${planResult.planCode}/${planResult.billingCycle}` : '', actor: 'admin',
  });
  return { status: 'ACTIVE' };
}

/** Matches the reject endpoint exactly (local.js:1436-1449). @param {number} tenantId @param {string} [reason] */
async function rejectRegistration(tenantId, reason) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  if (lic.status !== 'PENDING_APPROVAL') {
    throw new BusinessRuleError(`This registration is not pending approval (current status: ${lic.status})`, 'NOT_PENDING_APPROVAL');
  }
  await tenantLicenseRepository.markArchived(tenantId);
  await licenseHistoryRepository.record({ tenantId, eventType: 'REJECTED', fromStatus: 'PENDING_APPROVAL', toStatus: 'ARCHIVED', detail: reason || '', actor: 'admin' });
  return { status: 'ARCHIVED' };
}

/** Matches the generate-license endpoint exactly (local.js:1518-1535). @param {number} tenantId @param {{regenerate?:boolean}} [opts] */
async function generateLicenseForTenant(tenantId, { regenerate } = {}) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  if (lic.license_key && !regenerate) {
    throw new ConflictError('A license key already exists for this tenant. Pass regenerate:true to replace it.');
  }
  const key = await generateLicenseKey();
  await tenantLicenseRepository.setLicenseKey(tenantId, key);
  await licenseHistoryRepository.record({ tenantId, eventType: lic.license_key ? 'KEY_REGENERATED' : 'KEY_GENERATED', detail: key, actor: 'admin' });
  return { licenseKey: key };
}

/** Matches the extend endpoint exactly (local.js:1537-1562). @param {number} tenantId @param {{days?:number,newExpiresAt?:string}} params */
async function extendLicense(tenantId, { days, newExpiresAt } = {}) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  if (lic.status === 'PENDING_APPROVAL') throw new BusinessRuleError('Approve this registration before extending the subscription.', 'NOT_APPROVED');
  if (lic.status === 'ARCHIVED') throw new BusinessRuleError('This account is archived. Reactivate it first.', 'ARCHIVED');

  let expiresAt;
  if (newExpiresAt) {
    expiresAt = new Date(newExpiresAt);
  } else if (typeof days === 'number' && days > 0) {
    const base = (lic.expires_at && new Date(lic.expires_at).getTime() > Date.now()) ? new Date(lic.expires_at) : new Date();
    expiresAt = new Date(base.getTime() + days * 86400000);
  } else {
    throw new ValidationError('Provide either days (number) or newExpiresAt (date string)');
  }
  const reactivated = lic.status === 'READ_ONLY' || lic.status === 'SUSPENDED';
  await tenantLicenseRepository.extend(tenantId, expiresAt);
  await licenseHistoryRepository.record({ tenantId, eventType: 'EXTENDED', fromStatus: lic.status, toStatus: 'ACTIVE', detail: `expires_at -> ${expiresAt.toISOString()}` });
  return { expiresAt, reactivated };
}

/** Matches the manual-suspend endpoint exactly (local.js:1565-1574). @param {number} tenantId @param {string} [reason] */
async function suspendTenant(tenantId, reason) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  await tenantLicenseRepository.suspend(tenantId);
  await tenantLicenseRepository.revokeAllSessionsForTenant(tenantId);
  await licenseHistoryRepository.record({ tenantId, eventType: 'STATUS_CHANGED', fromStatus: lic.status, toStatus: 'SUSPENDED', detail: reason || 'manual admin suspend', actor: 'admin' });
}

/** Matches the reactivate endpoint exactly (local.js:1577-1584). @param {number} tenantId */
async function reactivateTenant(tenantId) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  await tenantLicenseRepository.reactivate(tenantId);
  await licenseHistoryRepository.record({ tenantId, eventType: 'STATUS_CHANGED', fromStatus: lic.status, toStatus: 'ACTIVE', detail: 'manual admin reactivate', actor: 'admin' });
}

/** Matches the devices/limit endpoint exactly (local.js:1644-1652), minus its trusted_devices-touching siblings (remove/reset-all — Authentication domain, out of scope). */
async function setDeviceLimit(tenantId, deviceLimit) {
  if (typeof deviceLimit !== 'number' || deviceLimit < 1) throw new ValidationError('deviceLimit must be a positive number');
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) throw new NotFoundError('Tenant license not found');
  await tenantLicenseRepository.setDeviceLimit(tenantId, deviceLimit);
  await licenseHistoryRepository.record({ tenantId, eventType: 'DEVICE_LIMIT_CHANGED', detail: `${lic.device_limit} -> ${deviceLimit}`, actor: 'admin' });
}

/**
 * Matches GET /api/license/status exactly (local.js:1152-1189), for the
 * tenant_licenses-sourced `license` object only — NOT the outer legacy
 * `{status, reason, licenseExpiry, licensePlan}` fields, which read
 * `tenants.status/suspend_reason/license_expiry/license_plan` columns
 * that don't exist on server/src/'s `tenants` table (migrations/001,
 * Phase 2 deliberately excluded them as Licensing-domain columns living
 * on that table historically — see docs/architecture/Licensing.md).
 * @param {number} tenantId @returns {Promise<object|null>} null if the tenant has no license row (fail-open, matches local.js)
 */
async function getLicenseStatus(tenantId) {
  const lic = await tenantLicenseRepository.touchLastVerified(tenantId);
  if (!lic) return null;
  const devicesUsed = await tenantLicenseRepository.countActiveDevices(tenantId);
  const daysRemaining = lic.expires_at ? Math.ceil((new Date(lic.expires_at).getTime() - Date.now()) / 86400000) : null;
  return {
    status: lic.status, planCode: lic.plan_code, billingCycle: lic.billing_cycle,
    deviceLimit: lic.device_limit, devicesUsed, expiresAt: lic.expires_at, daysRemaining,
    licenseKey: lic.license_key, lastVerifiedAt: lic.last_verified_at, offlineGraceDays: lic.offline_grace_days,
    requestedModules: typeof lic.requested_modules === 'string' ? JSON.parse(lic.requested_modules || '[]') : (lic.requested_modules || []),
    requestedDevicesBucket: lic.requested_devices_bucket, requestedPlanCode: lic.requested_plan_code,
  };
}

/**
 * Matches runLicenseTransitionSweep exactly (local.js:565-605): three
 * independent transitions, each writing a license_history row; the
 * READ_ONLY->SUSPENDED step also kills sessions, matching local.js.
 * @returns {Promise<{toReadOnly:number,toSuspended:number,toArchived:number}>}
 */
async function runTransitionSweep() {
  const toReadOnly = await tenantLicenseRepository.findExpiredActiveTenantIds();
  for (const tenantId of toReadOnly) {
    await tenantLicenseRepository.markReadOnly(tenantId);
    await licenseHistoryRepository.record({ tenantId, eventType: 'STATUS_CHANGED', fromStatus: 'ACTIVE', toStatus: 'READ_ONLY', detail: 'expires_at passed (sweep)' });
  }

  const toSuspended = await tenantLicenseRepository.findStaleReadOnlyTenantIds();
  for (const tenantId of toSuspended) {
    await tenantLicenseRepository.markSuspendedFromReadOnly(tenantId);
    await tenantLicenseRepository.revokeAllSessionsForTenant(tenantId);
    await licenseHistoryRepository.record({ tenantId, eventType: 'STATUS_CHANGED', fromStatus: 'READ_ONLY', toStatus: 'SUSPENDED', detail: '30 days in READ_ONLY (sweep)' });
  }

  const toArchived = await tenantLicenseRepository.findStaleSuspendedTenantIds();
  for (const tenantId of toArchived) {
    await tenantLicenseRepository.markArchivedFromSuspended(tenantId);
    await licenseHistoryRepository.record({ tenantId, eventType: 'STATUS_CHANGED', fromStatus: 'SUSPENDED', toStatus: 'ARCHIVED', detail: '365 days in SUSPENDED, non-payment (sweep)' });
  }

  return { toReadOnly: toReadOnly.length, toSuspended: toSuspended.length, toArchived: toArchived.length };
}

/** Matches GET /api/admin/tenant-licenses exactly (local.js:1452-1480), minus devices_used/last_login (Authentication-domain joins, out of scope). */
async function listTenantLicenses() {
  const rows = await tenantLicenseRepository.listAll();
  const now = Date.now();
  return rows.map((r) => ({
    tenantId: r.tenant_id, shopName: r.shop_name, registeredAt: r.registered_at,
    status: r.status, planCode: r.plan_code, billingCycle: r.billing_cycle,
    deviceLimit: r.device_limit, expiresAt: r.expires_at,
    daysRemaining: r.expires_at ? Math.ceil((new Date(r.expires_at).getTime() - now) / 86400000) : null,
    requestedModules: typeof r.requested_modules === 'string' ? JSON.parse(r.requested_modules || '[]') : (r.requested_modules || []),
    licenseKey: r.license_key,
  }));
}

/** Matches GET /api/admin/registrations exactly (local.js:1373-1398). */
async function listPendingRegistrations() {
  const rows = await tenantLicenseRepository.listPendingRegistrations();
  return rows.map((r) => ({
    tenantId: r.tenant_id, shopName: r.shop_name, address: r.address, gstNumber: r.gst_number,
    registeredAt: r.registered_at, ownerName: r.owner_name, mobile: r.mobile, email: r.email,
    emailVerified: !!r.email_verified_at,
    requestedPlan: r.requested_plan_code, requestedDevicesBucket: r.requested_devices_bucket,
    requestedModules: typeof r.requested_modules === 'string' ? JSON.parse(r.requested_modules || '[]') : (r.requested_modules || []),
  }));
}

/** Matches GET /api/admin/tenant-licenses/:tenantId/history exactly (local.js:1483-1487). @param {number} tenantId */
async function getHistory(tenantId) {
  return licenseHistoryRepository.listForTenant(tenantId);
}

module.exports = {
  generateLicenseKey, createPendingLicense, assignPlanToTenant, assignPlan, startTrial,
  approveRegistration, rejectRegistration, generateLicenseForTenant, extendLicense,
  suspendTenant, reactivateTenant, setDeviceLimit, getLicenseStatus, runTransitionSweep,
  listTenantLicenses, listPendingRegistrations, getHistory, BILLING_CYCLE_DAYS,
};
