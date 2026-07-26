/**
 * platform/src/jobs/index.js — Phase 5C. Registers every production job
 * with jobRunnerService. Adding a future job means one new file under
 * src/jobs/ (matching the shape of the three below: an async run()
 * optionally returning {itemsProcessed}) plus one registerJob() line
 * here — jobRunnerService itself never changes.
 */
'use strict';

const jobRunnerService = require('../services/jobRunnerService');
const metricSnapshotJob = require('./metricSnapshotJob');
const sessionCleanupJob = require('./sessionCleanupJob');
const loginFailureRetentionJob = require('./loginFailureRetentionJob');
const maintenancePublishJob = require('./maintenancePublishJob');
const maintenanceExpiryJob = require('./maintenanceExpiryJob');
const maintenanceSyncMonitorJob = require('./maintenanceSyncMonitorJob');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function registerAllJobs() {
  jobRunnerService.registerJob('metric-snapshot', 24 * HOUR, metricSnapshotJob.run);
  jobRunnerService.registerJob('session-cleanup', 15 * MINUTE, sessionCleanupJob.run);
  jobRunnerService.registerJob('login-failure-retention', 24 * HOUR, loginFailureRetentionJob.run);
  jobRunnerService.registerJob('maintenance-publish', 1 * MINUTE, maintenancePublishJob.run);
  jobRunnerService.registerJob('maintenance-expiry', 1 * MINUTE, maintenanceExpiryJob.run);
  // 30-minute interval matches its own staleness threshold; deliberately
  // NOT run immediately at boot (see bootAllJobs) — a fresh system hasn't
  // had a chance for any product to sync yet, so an immediate run would
  // report a false-negative failure before ShopERP's first poll can land.
  jobRunnerService.registerJob('maintenance-sync-monitor', 30 * MINUTE, maintenanceSyncMonitorJob.run);
}

/** Runs every job once immediately (fire-and-forget) so a fresh boot doesn't wait a full interval for its first data point — then starts the normal recurring schedule. */
function bootAllJobs() {
  registerAllJobs();
  jobRunnerService.runNow('metric-snapshot').catch(() => {});
  jobRunnerService.runNow('session-cleanup').catch(() => {});
  jobRunnerService.runNow('login-failure-retention').catch(() => {});
  jobRunnerService.runNow('maintenance-publish').catch(() => {});
  jobRunnerService.runNow('maintenance-expiry').catch(() => {});
  jobRunnerService.startAll();
}

module.exports = { registerAllJobs, bootAllJobs };
