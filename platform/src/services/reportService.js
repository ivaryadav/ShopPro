/**
 * platform/src/services/reportService.js — Reports & Trends (Phase 5A;
 * customerGrowth/licenseTrends upgraded to real historical snapshots in
 * Phase 5C, once the Metric Snapshot Job has run at least once).
 *
 * registrationTrends/productUsage/activityMetrics stay computed on
 * demand always — organizations.created_at never changes after the
 * fact, so recomputing them is already perfectly accurate; snapshotting
 * them would just be a redundant, staler copy. customerGrowth and
 * licenseTrends are different: active-session-style state changes
 * destructively, so a PAST point in time can only be known if something
 * recorded it at the time — that's what platform_metric_snapshots is
 * for. When no snapshot exists yet (job never ran), this falls back to
 * the original Phase 5A on-demand computation rather than returning
 * nothing.
 */
'use strict';

const { getDb } = require('../database/connection');
const { listConfiguredAdapters } = require('../adapters');
const metricSnapshotRepository = require('../repositories/platformMetricSnapshotRepository');

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
  const snapshots = metricSnapshotRepository.listRecent(90);
  const [registrations, products] = await Promise.all([registrationTrends(), productUsage()]);
  let growth, licenses, dataSource;
  if (snapshots.length) {
    growth = snapshots.map((s) => ({ month: s.snapshot_date, total: s.total_organizations }));
    const latest = snapshots[snapshots.length - 1];
    licenses = { ACTIVE: latest.active_licenses, READ_ONLY: latest.expired_licenses };
    dataSource = 'snapshots';
  } else {
    [growth, licenses] = await Promise.all([customerGrowth(), licenseTrends()]);
    dataSource = 'computed';
  }
  return { customerGrowth: growth, registrationTrends: registrations, licenseTrends: licenses, productUsage: products, activityMetrics: activityMetrics(), dataSource };
}

module.exports = { getTrends, customerGrowth, registrationTrends, licenseTrends, productUsage, activityMetrics };
