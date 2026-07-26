/**
 * platform/src/services/jobRunnerService.js — Phase 5C: the reusable
 * background-job scheduler every future platform capability runs on top
 * of. A future job is exactly one registerJob() call — this file is
 * never modified to add one (the "core stays generic" principle this
 * whole platform already follows for products/adapters).
 *
 * Each registered job tracks its own timer, in-flight state, and
 * scheduling info in memory (process-lifetime, correctly reset on
 * restart — "next run" only means something relative to when THIS
 * process started scheduling). Success/failure counts and full history
 * are read from platform_job_runs instead, since those need to survive a
 * restart to stay meaningful ("47 failures" shouldn't reset to 0 just
 * because the process bounced).
 */
'use strict';

const jobRunRepository = require('../repositories/platformJobRunRepository');

const REGISTRY = new Map();

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * @param {string} name unique job name
 * @param {number} intervalMs how often start() schedules a run
 * @param {() => Promise<{itemsProcessed?: number}|void>} fn
 * @param {{maxRetries?: number, retryDelayMs?: number}} [opts]
 */
function registerJob(name, intervalMs, fn, opts) {
  if (REGISTRY.has(name)) throw new Error(`Job "${name}" is already registered`);
  opts = opts || {};
  REGISTRY.set(name, {
    name, intervalMs, fn, timer: null, isRunning: false,
    maxRetries: opts.maxRetries != null ? opts.maxRetries : 2,
    retryDelayMs: opts.retryDelayMs != null ? opts.retryDelayMs : 2000,
    lastRunAt: null, lastFinishedAt: null, lastStatus: null, lastDurationMs: null, lastError: null, nextRunAt: null,
  });
}
function unregisterJob(name) {
  stop(name);
  return REGISTRY.delete(name);
}

async function executeJob(job) {
  if (job.isRunning) return; // never overlap two runs of the SAME job
  job.isRunning = true;
  const startedAt = new Date();
  let attemptsMade = 0;
  let lastErr = null;
  let itemsProcessed = null;
  let succeeded = false;
  while (attemptsMade < job.maxRetries + 1 && !succeeded) {
    attemptsMade++;
    try {
      const result = await job.fn();
      itemsProcessed = (result && typeof result.itemsProcessed === 'number') ? result.itemsProcessed : null;
      succeeded = true;
    } catch (e) {
      lastErr = e;
      if (attemptsMade <= job.maxRetries) await sleep(job.retryDelayMs);
    }
  }
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  job.isRunning = false;
  job.lastRunAt = startedAt.toISOString();
  job.lastFinishedAt = finishedAt.toISOString();
  job.lastDurationMs = durationMs;
  job.lastStatus = succeeded ? 'success' : 'failure';
  job.lastError = succeeded ? null : (lastErr ? lastErr.message : 'unknown error');
  job.nextRunAt = job.timer ? new Date(Date.now() + job.intervalMs).toISOString() : null;
  jobRunRepository.record({
    jobName: job.name, startedAt: job.lastRunAt, finishedAt: job.lastFinishedAt,
    status: job.lastStatus, detail: job.lastError || '', itemsProcessed, attempts: attemptsMade, durationMs,
  });
}

function start(name) {
  const job = REGISTRY.get(name);
  if (!job) throw new Error(`Job "${name}" is not registered`);
  if (job.timer) return;
  job.nextRunAt = new Date(Date.now() + job.intervalMs).toISOString();
  job.timer = setInterval(() => { executeJob(job); }, job.intervalMs);
  // Never let a scheduled job alone keep the process alive — graceful
  // shutdown (and test teardown) must not have to race a live timer.
  if (job.timer.unref) job.timer.unref();
}
function stop(name) {
  const job = REGISTRY.get(name);
  if (!job || !job.timer) return;
  clearInterval(job.timer);
  job.timer = null;
  job.nextRunAt = null;
}
function startAll() { for (const name of REGISTRY.keys()) start(name); }
function stopAll() { for (const name of REGISTRY.keys()) stop(name); }

/** Runs a job immediately, outside its normal schedule — used by the manual "Run Now" UI action and by tests, which never wait on a real interval. */
async function runNow(name) {
  const job = REGISTRY.get(name);
  if (!job) throw new Error(`Job "${name}" is not registered`);
  await executeJob(job);
  return getStatus(name);
}

function getStatus(name) {
  const job = REGISTRY.get(name);
  if (!job) return null;
  const stats = jobRunRepository.statsForJob(name);
  return {
    name: job.name, intervalMs: job.intervalMs, isRunning: job.isRunning, isScheduled: !!job.timer,
    lastRunAt: job.lastRunAt, lastFinishedAt: job.lastFinishedAt, nextRunAt: job.nextRunAt,
    lastStatus: job.lastStatus, lastDurationMs: job.lastDurationMs, lastError: job.lastError,
    successCount: stats.success_count || 0, failureCount: stats.failure_count || 0,
  };
}
function listStatuses() { return Array.from(REGISTRY.keys()).map(getStatus); }
function getHistory(name, limit) { return jobRunRepository.listForJob(name, limit); }

/** Test-only — mirrors database/connection.js's _resetForTests() so a fresh disposable server never collides with a previous one's registrations in the same process. */
function _resetForTests() {
  stopAll();
  REGISTRY.clear();
}

module.exports = { registerJob, unregisterJob, start, stop, startAll, stopAll, runNow, getStatus, listStatuses, getHistory, _resetForTests };
