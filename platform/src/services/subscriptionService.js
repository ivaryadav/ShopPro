/**
 * platform/src/services/subscriptionService.js — Phase 5E Subscription
 * Center. A commercial-lens VIEW composed on top of the existing License
 * Center (platform_licenses stays the sole source of entitlement truth —
 * no parallel "subscriptions" table, no dual state) plus the new Plan
 * Catalog for device/user/storage limits and features. Lifecycle actions
 * (upgrade/downgrade/renew/suspend/resume/cancel) are thin wrappers over
 * licenseService, which already handles the local-vs-adapter dispatch.
 */
'use strict';

const licenseRepository = require('../repositories/platformLicenseRepository');
const planRepository = require('../repositories/platformSubscriptionPlanRepository');
const organizationDeviceRepository = require('../repositories/organizationDeviceRepository');
const organizationUserRepository = require('../repositories/organizationUserRepository');
const licenseService = require('../services/licenseService');
const orgRef = require('./orgRef');
const { listConfiguredAdapters } = require('../adapters');
const { NotFoundError: NF } = require('../errors');

function withPlan(lic) {
  const plan = lic.plan_code ? planRepository.findByCode(lic.plan_code) : null;
  return {
    organizationId: String(lic.organization_id), businessName: lic.business_name, productId: lic.product_id, productName: lic.product_name,
    planCode: lic.plan_code, status: lic.status, startsAt: lic.starts_at, expiresAt: lic.expires_at,
    gracePeriodDays: lic.grace_period_days, graceDaysRemaining: licenseService.getGraceCountdown(lic),
    licenseKey: lic.license_key, cancelledAt: lic.cancelled_at,
    plan: plan ? { name: plan.name, billingCycle: plan.billing_cycle, deviceLimit: plan.device_limit, userLimit: plan.user_limit, storageLimitMb: plan.storage_limit_mb, priceAmount: plan.price_amount, priceCurrency: plan.price_currency, features: JSON.parse(plan.features || '[]') } : null,
  };
}

/** Subscription Center — every subscription, local + every configured adapter, for the main list view. */
async function listSubscriptions({ status, planCode, page = 1, pageSize = 25 } = {}) {
  const db = require('../database/connection').getDb();
  const where = [];
  const params = [];
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (planCode) { where.push('l.plan_code = ?'); params.push(planCode); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const localRows = db.prepare(`
    SELECT l.*, o.business_name, p.name AS product_name FROM platform_licenses l
    JOIN organizations o ON o.id = l.organization_id JOIN platform_products p ON p.id = l.product_id
    ${whereSql} ORDER BY l.updated_at DESC
  `).all(...params);
  let subscriptions = localRows.map(withPlan);

  for (const { slug, adapter } of listConfiguredAdapters()) {
    const result = await adapter.listOrganizations({ page: 1, pageSize: 500 });
    for (const o of result.organizations || []) {
      if (!o.license) continue;
      if (status && o.license.status !== status) continue;
      if (planCode && o.license.planCode !== planCode) continue;
      const plan = o.license.planCode ? planRepository.findByCode(o.license.planCode) : null;
      subscriptions.push({
        organizationId: o.id, businessName: o.businessName, productId: null, productName: slug,
        planCode: o.license.planCode, status: o.license.status, startsAt: null, expiresAt: o.license.expiresAt,
        gracePeriodDays: null, graceDaysRemaining: null, licenseKey: o.license.licenseKey, cancelledAt: null,
        plan: plan ? { name: plan.name, billingCycle: plan.billing_cycle, deviceLimit: plan.device_limit, userLimit: plan.user_limit, storageLimitMb: plan.storage_limit_mb, priceAmount: plan.price_amount, priceCurrency: plan.price_currency, features: JSON.parse(plan.features || '[]') } : null,
      });
    }
  }

  const total = subscriptions.length;
  const start = (page - 1) * pageSize;
  return { subscriptions: subscriptions.slice(start, start + pageSize), total, page, pageSize };
}

async function getSubscription(rawOrgId, productId) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    const d = await ref.adapter.getOrganization(ref.sourceId);
    if (!d.license) throw new NF('No license found for this organization');
    const plan = d.license.planCode ? planRepository.findByCode(d.license.planCode) : null;
    return {
      organizationId: rawOrgId, planCode: d.license.planCode, status: d.license.status, expiresAt: d.license.expiresAt,
      licenseKey: d.license.licenseKey, plan: plan ? { name: plan.name, billingCycle: plan.billing_cycle, deviceLimit: plan.device_limit, userLimit: plan.user_limit, storageLimitMb: plan.storage_limit_mb } : null,
    };
  }
  const lic = licenseRepository.find(ref.localId, productId);
  if (!lic) throw new NF('No license found for this organization/product');
  const org = require('../repositories/organizationRepository').findById(ref.localId);
  const product = require('../repositories/platformProductRepository').findById(productId);
  return withPlan({ ...lic, business_name: org && org.business_name, product_name: product && product.name });
}

/** Usage — devices/users in use vs the plan's limits. Storage usage has no real metering source anywhere in this codebase yet — reported as unavailable rather than fabricated. */
async function getUsage(rawOrgId) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    const d = await ref.adapter.getOrganization(ref.sourceId);
    const plan = d.license && d.license.planCode ? planRepository.findByCode(d.license.planCode) : null;
    return {
      devicesUsed: (d.devices || []).filter((dev) => dev.isActive).length,
      deviceLimit: plan ? plan.device_limit : null,
      usersActive: (d.activity && d.activity.users && d.activity.users.length) || null,
      userLimit: plan ? plan.user_limit : null,
      storageUsedMb: null, storageLimitMb: plan ? plan.storage_limit_mb : null,
    };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.listForOrganization(organizationId)[0];
  const plan = lic && lic.plan_code ? planRepository.findByCode(lic.plan_code) : null;
  return {
    devicesUsed: organizationDeviceRepository.count(organizationId),
    deviceLimit: plan ? plan.device_limit : null,
    usersActive: organizationUserRepository.listForOrganization(organizationId).filter((u) => u.is_active).length,
    userLimit: plan ? plan.user_limit : null,
    storageUsedMb: null, storageLimitMb: plan ? plan.storage_limit_mb : null,
  };
}

module.exports = {
  listSubscriptions, getSubscription, getUsage,
  upgrade: (rawOrgId, productId, planCode, actor) => licenseService.changePlan(rawOrgId, productId, planCode, 'upgrade', actor),
  downgrade: (rawOrgId, productId, planCode, actor) => licenseService.changePlan(rawOrgId, productId, planCode, 'downgrade', actor),
  renew: (rawOrgId, productId, days, actor) => licenseService.renew(rawOrgId, productId, { days }, actor),
  suspend: (rawOrgId, productId, reason, actor) => licenseService.suspend(rawOrgId, productId, reason, actor),
  resume: (rawOrgId, productId, actor) => licenseService.resume(rawOrgId, productId, actor),
  cancel: (rawOrgId, productId, reason, actor) => licenseService.cancel(rawOrgId, productId, reason, actor),
};
