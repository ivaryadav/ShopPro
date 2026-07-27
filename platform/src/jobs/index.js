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
const licenseExpiryJob = require('./licenseExpiryJob');
const gracePeriodJob = require('./gracePeriodJob');
const renewalReminderJob = require('./renewalReminderJob');
const webhookRetryJob = require('./webhookRetryJob');
const deadLetterCleanupJob = require('./deadLetterCleanupJob');
const eventRetentionJob = require('./eventRetentionJob');

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
  // Phase 5E: Business Operations runtime jobs.
  jobRunnerService.registerJob('license-expiry', 1 * HOUR, licenseExpiryJob.run);
  jobRunnerService.registerJob('grace-period', 1 * HOUR, gracePeriodJob.run);
  jobRunnerService.registerJob('renewal-reminder', 24 * HOUR, renewalReminderJob.run);
  // Phase 5F: Integration Platform runtime jobs.
  jobRunnerService.registerJob('webhook-retry', 1 * MINUTE, webhookRetryJob.run);
  jobRunnerService.registerJob('dead-letter-cleanup', 24 * HOUR, deadLetterCleanupJob.run);
  jobRunnerService.registerJob('event-retention', 24 * HOUR, eventRetentionJob.run);
}

/** Runs every job once immediately (fire-and-forget) so a fresh boot doesn't wait a full interval for its first data point — then starts the normal recurring schedule. */
function bootAllJobs() {
  registerAllJobs();
  jobRunnerService.runNow('metric-snapshot').catch(() => {});
  jobRunnerService.runNow('session-cleanup').catch(() => {});
  jobRunnerService.runNow('login-failure-retention').catch(() => {});
  jobRunnerService.runNow('maintenance-publish').catch(() => {});
  jobRunnerService.runNow('maintenance-expiry').catch(() => {});
  jobRunnerService.runNow('license-expiry').catch(() => {});
  jobRunnerService.runNow('grace-period').catch(() => {});
  jobRunnerService.runNow('webhook-retry').catch(() => {});
  jobRunnerService.runNow('dead-letter-cleanup').catch(() => {});
  jobRunnerService.runNow('event-retention').catch(() => {});
  jobRunnerService.startAll();
}

module.exports = { registerAllJobs, bootAllJobs };
