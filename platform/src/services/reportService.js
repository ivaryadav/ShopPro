/**
 * platform/src/services/reportService.js — Reports & Trends (Phase 5A).
 *
 * Every number here is computed on demand from data that already exists
 * (organizations.created_at, platform_licenses.status, platform_audit_logs,
 * each adapter's own dashboard stats) — there is no metric-snapshot job
 * persisting daily history yet (scheduled job infrastructure is a later
 * milestone), so trends are real aggregates recomputed per request rather
 * than a stored time series. Documented as "future-ready architecture":
 * the shape returned here is exactly what a future snapshot job would
 * backfill into, without changing this service's contract.
 */
'use strict';

const { getDb } = require('../database/connection');
const { listConfiguredAdapters } = require('../adapters');

function mergeMonthly(seriesArrays) {
  const map = new Map();
  for (const series of seriesArrays) {
    for (const { month, count } of series) map.set(month, (map.get(month) || 0) + count);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count }));
}
function groupByMonth(dates) {
  const map = new Map();
  for (const d of dates) {
    if (!d) continue;
    const month = String(d).slice(0, 7);
    map.set(month, (map.get(month) || 0) + 1);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count }));
}

/** New organizations per month — this IS the registration-trend series; "growth" below is its cumulative sum. Kept as one real computation rather than two independent (and redundant) queries. */
async function registrationTrends() {
  const local = getDb().prepare("SELECT strftime('%Y-%m', created_at) month, COUNT(*) count FROM organizations GROUP BY month ORDER BY month").all();
  const adapterSeries = [];
  for (const { adapter } of listConfiguredAdapters()) {
    const d = await adapter.listOrganizations({ page: 1, pageSize: 500 });
    adapterSeries.push(groupByMonth((d.organizations || []).map((o) => o.createdAt)));
  }
  return mergeMonthly([local, ...adapterSeries]);
}

async function customerGrowth() {
  const perMonth = await registrationTrends();
  let running = 0;
  return perMonth.map((m) => { running += m.count; return { month: m.month, total: running }; });
}

async function licenseTrends() {
  const localByStatus = getDb().prepare('SELECT status, COUNT(*) count FROM platform_licenses GROUP BY status').all();
  const byStatus = {};
  for (const r of localByStatus) byStatus[r.status] = (byStatus[r.status] || 0) + r.count;
  for (const { adapter } of listConfiguredAdapters()) {
    const d = await adapter.getDashboardStats();
    byStatus.ACTIVE = (byStatus.ACTIVE || 0) + (d.activeLicenses || 0);
    byStatus.READ_ONLY = (byStatus.READ_ONLY || 0) + (d.expiredLicenses || 0);
    if (d.suspendedLicenses) byStatus.SUSPENDED = (byStatus.SUSPENDED || 0) + d.suspendedLicenses;
  }
  return byStatus;
}

async function productUsage() {
  const local = getDb().prepare(`
    SELECT p.name, COUNT(DISTINCT op.organization_id) count
    FROM organization_products op JOIN platform_products p ON p.id = op.product_id
    GROUP BY p.id
  `).all();
  const usage = local.map((r) => ({ product: r.name, organizations: r.count }));
  for (const { slug, adapter } of listConfiguredAdapters()) {
    const d = await adapter.getDashboardStats();
    usage.push({ product: slug, organizations: d.totalOrganizations || 0 });
  }
  return usage;
}

function activityMetrics() {
  return getDb().prepare(`
    SELECT date(created_at) day, COUNT(*) count FROM platform_audit_logs
    WHERE created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day
  `).all();
}

async function getTrends() {
  const [growth, registrations, licenses, products] = await Promise.all([
    customerGrowth(), registrationTrends(), licenseTrends(), productUsage(),
  ]);
  return { customerGrowth: growth, registrationTrends: registrations, licenseTrends: licenses, productUsage: products, activityMetrics: activityMetrics() };
}

module.exports = { getTrends, customerGrowth, registrationTrends, licenseTrends, productUsage, activityMetrics };
