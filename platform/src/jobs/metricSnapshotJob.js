/**
 * platform/src/jobs/metricSnapshotJob.js — Phase 5C. Writes one row per
 * calendar day of the platform's real headline metrics, merging local
 * organizations with every configured adapter's live stats — the exact
 * same "local + adapter" merge dashboardController/reportService already
 * use, kept self-contained here rather than imported so this job has no
 * dependency on a controller/service layer that could change shape.
 */
'use strict';

const { getDb } = require('../database/connection');
const { listConfiguredAdapters } = require('../adapters');
const metricSnapshotRepository = require('../repositories/platformMetricSnapshotRepository');
const sessionRepository = require('../repositories/platformSessionRepository');
const licenseRepository = require('../repositories/platformLicenseRepository');

async function run() {
  const db = getDb();
  const localTotal = db.prepare('SELECT COUNT(*) c FROM organizations').get().c;
  const localLicenseStats = licenseRepository.stats();

  let totalOrganizations = localTotal;
  let activeLicenses = localLicenseStats.active;
  let expiredLicenses = localLicenseStats.expired;
  for (const { adapter } of listConfiguredAdapters()) {
    const d = await adapter.getDashboardStats();
    totalOrganizations += d.totalOrganizations || 0;
    activeLicenses += d.activeLicenses || 0;
    expiredLicenses += d.expiredLicenses || 0;
  }

  const snapshotDate = new Date().toISOString().slice(0, 10);
  metricSnapshotRepository.upsert({
    snapshotDate, totalOrganizations, activeLicenses, expiredLicenses,
    activeSessions: sessionRepository.countActive(),
  });
  return { itemsProcessed: 1 };
}

module.exports = { run };
