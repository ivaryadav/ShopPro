/**
 * platform/src/services/businessService.js — Phase 5E Business Dashboard
 * and Renewal Center. Pure composition over existing services/repositories
 * (licenseService, billingService, reportService, adapters) — no new
 * state of its own.
 */
'use strict';

const { getDb } = require('../database/connection');
const licenseService = require('./licenseService');
const billingService = require('./billingService');
const reportService = require('./reportService');
const licenseHistoryRepository = require('../repositories/platformLicenseHistoryRepository');
const { listConfiguredAdapters } = require('../adapters');

async function getDashboard() {
  const db = getDb();
  const [buckets, billing, growth] = await Promise.all([licenseService.getExpirationDashboard(), billingService.getDashboard(), reportService.customerGrowth()]);

  let activeCustomers = db.prepare("SELECT COUNT(DISTINCT organization_id) c FROM platform_licenses WHERE status = 'ACTIVE'").get().c;
  let trialCustomers = db.prepare("SELECT COUNT(DISTINCT organization_id) c FROM platform_licenses WHERE status = 'TRIAL'").get().c;
  for (const { adapter } of listConfiguredAdapters()) {
    const d = await adapter.getDashboardStats();
    activeCustomers += d.activeLicenses || 0;
  }

  const monthlyRevenueLatest = billing.monthlyRevenue.length ? billing.monthlyRevenue[billing.monthlyRevenue.length - 1].total : 0;
  const activeProducts = db.prepare("SELECT COUNT(*) c FROM platform_products WHERE status = 'active'").get().c;

  return {
    monthlyRevenue: monthlyRevenueLatest,
    activeCustomers, trialCustomers,
    expiringLicenses: buckets.expiringSoon.length + buckets.expiring30.length,
    renewalsDue: buckets.expiringSoon.length,
    inGrace: buckets.inGrace.length,
    outstandingPayments: billing.outstanding,
    activeProducts,
    growthMetrics: growth,
  };
}

/** Renewal Center — Business > Renewals. Finer-grained day buckets than the general Expiration Dashboard, matching the mission's exact "Due Today/This Week/This Month/Grace/Expired" vocabulary. */
async function getRenewalCenter() {
  const db = getDb();
  const buckets = { dueToday: [], dueThisWeek: [], dueThisMonth: [], grace: [], expired: [] };
  const bucketFor = (days, status) => {
    if (status === 'READ_ONLY') return 'grace';
    if (status === 'SUSPENDED' || status === 'ARCHIVED') return 'expired';
    if (days <= 0) return 'dueToday';
    if (days <= 7) return 'dueThisWeek';
    if (days <= 30) return 'dueThisMonth';
    return null;
  };

  const local = db.prepare(`
    SELECT l.*, o.business_name, p.name AS product_name FROM platform_licenses l
    JOIN organizations o ON o.id = l.organization_id JOIN platform_products p ON p.id = l.product_id
    WHERE l.status IN ('ACTIVE','READ_ONLY','SUSPENDED')
  `).all();
  for (const l of local) {
    const entry = { organizationId: String(l.organization_id), productId: l.product_id, businessName: l.business_name, productName: l.product_name, planCode: l.plan_code, status: l.status, expiresAt: l.expires_at, graceDaysRemaining: licenseService.getGraceCountdown(l) };
    const days = l.expires_at ? Math.ceil((new Date(l.expires_at).getTime() - Date.now()) / 86400000) : null;
    const bucket = bucketFor(days, l.status);
    if (bucket) buckets[bucket].push({ ...entry, daysRemaining: days });
  }

  for (const { slug, adapter } of listConfiguredAdapters()) {
    const result = await adapter.listOrganizations({ page: 1, pageSize: 500 });
    for (const o of result.organizations || []) {
      if (!o.license) continue;
      const days = o.license.expiresAt ? Math.ceil((new Date(o.license.expiresAt).getTime() - Date.now()) / 86400000) : null;
      const bucket = bucketFor(days, o.license.status);
      if (!bucket) continue;
      buckets[bucket].push({ organizationId: o.id, productId: null, businessName: o.businessName, productName: slug, planCode: o.license.planCode, status: o.license.status, expiresAt: o.license.expiresAt, daysRemaining: days, graceDaysRemaining: null });
    }
  }

  const renewalHistory = licenseHistoryRepository.listRecent(50).filter((h) => h.event_type === 'RENEWED');
  return { ...buckets, renewalHistory };
}

module.exports = { getDashboard, getRenewalCenter };
