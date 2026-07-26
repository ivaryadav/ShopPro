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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function registerAllJobs() {
  jobRunnerService.registerJob('metric-snapshot', 24 * HOUR, metricSnapshotJob.run);
  jobRunnerService.registerJob('session-cleanup', 15 * MINUTE, sessionCleanupJob.run);
  jobRunnerService.registerJob('login-failure-retention', 24 * HOUR, loginFailureRetentionJob.run);
}

/** Runs every job once immediately (fire-and-forget) so a fresh boot doesn't wait a full interval for its first data point — then starts the normal recurring schedule. */
function bootAllJobs() {
  registerAllJobs();
  jobRunnerService.runNow('metric-snapshot').catch(() => {});
  jobRunnerService.runNow('session-cleanup').catch(() => {});
  jobRunnerService.runNow('login-failure-retention').catch(() => {});
  jobRunnerService.startAll();
}

module.exports = { registerAllJobs, bootAllJobs };
