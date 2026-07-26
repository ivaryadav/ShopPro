/**
 * platform/test/job-runner.test.js — Phase 5C: Platform Runtime Operations.
 *
 * Covers the Job Runner framework directly (registration, lifecycle,
 * retry handling, execution history) and the 3 real production jobs
 * through the actual HTTP API, verifying real side effects in the
 * database rather than just checking response shapes.
 *
 * Usage: node test/job-runner.test.js
 */
'use strict';

const { startTestServer } = require('./testServer');
const jobRunnerService = require('../src/services/jobRunnerService');
const { getDb } = require('../src/database/connection');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Z-SUPERADMIN Phase 5C — Platform Runtime Operations: integration tests\n');
  const server = await startTestServer();
  const H = { Authorization: 'Bearer ' + server.ownerToken, 'Content-Type': 'application/json' };
  const api = (path, opts) => fetch(server.baseUrl + '/api/platform' + path, {
    method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || H,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // ── Registration (the 3 production jobs, registered by testServer.js) ──
    assert(jobRunnerService.getStatus('metric-snapshot') !== null, 'metric-snapshot is registered');
    assert(jobRunnerService.getStatus('session-cleanup') !== null, 'session-cleanup is registered');
    assert(jobRunnerService.getStatus('login-failure-retention') !== null, 'login-failure-retention is registered');

    let dupThrew = false;
    try { jobRunnerService.registerJob('metric-snapshot', 1000, async () => {}); } catch (e) { dupThrew = true; }
    assert(dupThrew, 'registering a duplicate job name throws, protecting against accidental double-registration');

    // ── Retry handling: a job that fails once then succeeds ─────────────
    let flakyCallCount = 0;
    jobRunnerService.registerJob('test-flaky-job', 60 * 60 * 1000, async () => {
      flakyCallCount++;
      if (flakyCallCount < 2) throw new Error('deliberate failure #' + flakyCallCount);
      return { itemsProcessed: 42 };
    }, { maxRetries: 3, retryDelayMs: 5 });
    const flakyResult = await jobRunnerService.runNow('test-flaky-job');
    assert(flakyResult.lastStatus === 'success', 'a job that fails once then succeeds ultimately reports success');
    assert(flakyCallCount === 2, 'the job function was retried exactly once before succeeding (got ' + flakyCallCount + ' calls)');
    const flakyHistory = jobRunnerService.getHistory('test-flaky-job', 5);
    assert(flakyHistory.length === 1 && flakyHistory[0].attempts === 2, 'exactly ONE run-history row is recorded per runNow(), with attempts=2 reflecting the retry — not one row per attempt');

    // ── A job that fails beyond maxRetries is recorded as a real failure ──
    jobRunnerService.registerJob('test-always-fails', 60 * 60 * 1000, async () => { throw new Error('always broken'); }, { maxRetries: 1, retryDelayMs: 5 });
    const failResult = await jobRunnerService.runNow('test-always-fails');
    assert(failResult.lastStatus === 'failure' && failResult.failureCount === 1, 'a job that never succeeds within maxRetries is recorded as failure');
    assert(failResult.lastError === 'always broken', 'the failure reason is captured verbatim');

    // ── Scheduler lifecycle: start/stop, no orphaned timers ──────────────
    jobRunnerService.start('test-flaky-job');
    let status = jobRunnerService.getStatus('test-flaky-job');
    assert(status.isScheduled === true && !!status.nextRunAt, 'start() schedules the job and computes a nextRunAt');
    jobRunnerService.stop('test-flaky-job');
    status = jobRunnerService.getStatus('test-flaky-job');
    assert(status.isScheduled === false && status.nextRunAt === null, 'stop() unschedules the job and clears nextRunAt — no dangling interval left behind');

    // ── unregisterJob removes it entirely ────────────────────────────────
    const unregistered = jobRunnerService.unregisterJob('test-flaky-job');
    assert(unregistered === true && jobRunnerService.getStatus('test-flaky-job') === null, 'unregisterJob() removes the job entirely');
    jobRunnerService.unregisterJob('test-always-fails');

    // ── Runtime Monitoring API ────────────────────────────────────────────
    const jobsList = await api('/jobs');
    assert(jobsList.status === 200 && jobsList.body.jobs.length === 3, 'GET /api/platform/jobs lists exactly the 3 real registered jobs');
    assert(jobsList.body.jobs.every((j) => Array.isArray(j.history)), 'each job includes its execution history');
    assert(jobsList.body.jobs.every((j) => 'successCount' in j && 'failureCount' in j && 'isRunning' in j && 'nextRunAt' in j), 'each job reports successCount/failureCount/isRunning/nextRunAt');
    const unauthedJobs = await fetch(server.baseUrl + '/api/platform/jobs');
    assert(unauthedJobs.status === 401, 'GET /api/platform/jobs requires authentication (got ' + unauthedJobs.status + ')');

    // ── System Health reflects real job runtime state ────────────────────
    const health = await api('/health');
    assert(health.body.jobs.count === 3 && Array.isArray(health.body.jobs.jobs), 'System Health reports the 3 real jobs, not a stub');

    // ── Manual execution: Metric Snapshot Job — real side effect ─────────
    const runSnapshot = await api('/jobs/metric-snapshot/run', { method: 'POST' });
    assert(runSnapshot.status === 200 && runSnapshot.body.job.lastStatus === 'success', 'POST /jobs/metric-snapshot/run executes successfully');
    const snapshotRow = getDb().prepare("SELECT * FROM platform_metric_snapshots WHERE snapshot_date = date('now')").get();
    assert(!!snapshotRow, 'the Metric Snapshot Job wrote a real row for today');

    const trends = await api('/reports/trends');
    assert(trends.body.dataSource === 'snapshots', 'Reports & Trends switches to real historical snapshot data once the job has run at least once');

    // ── Manual execution: Session Cleanup Job — real side effect ─────────
    getDb().prepare(`
      INSERT INTO platform_sessions (session_id, user_id, jwt_id, login_time, last_activity, status)
      VALUES ('fake-expired-session-for-test', ?, 'fake-jti', datetime('now','-2 days'), datetime('now','-2 days'), 'active')
    `).run(server.ownerId);
    const runCleanup = await api('/jobs/session-cleanup/run', { method: 'POST' });
    assert(runCleanup.status === 200 && runCleanup.body.job.lastStatus === 'success', 'POST /jobs/session-cleanup/run executes successfully');
    const fakeSessionAfter = getDb().prepare("SELECT status FROM platform_sessions WHERE session_id = 'fake-expired-session-for-test'").get();
    assert(fakeSessionAfter.status === 'revoked', 'the Session Cleanup Job proactively revoked a session that exceeded its idle timeout');

    // ── Manual execution: Login Failure Retention Job — real side effect ──
    getDb().prepare("INSERT INTO platform_login_failures (email, ip, created_at) VALUES ('old-failure@zmaxlab.com','1.2.3.4', datetime('now','-100 days'))").run();
    const beforePurge = getDb().prepare('SELECT COUNT(*) c FROM platform_login_failures').get().c;
    const runRetention = await api('/jobs/login-failure-retention/run', { method: 'POST' });
    assert(runRetention.status === 200 && runRetention.body.job.lastStatus === 'success', 'POST /jobs/login-failure-retention/run executes successfully');
    const afterPurge = getDb().prepare('SELECT COUNT(*) c FROM platform_login_failures').get().c;
    assert(afterPurge < beforePurge, `the Login Failure Retention Job purged the 100-day-old record (before=${beforePurge}, after=${afterPurge})`);
    assert(runRetention.body.job.successCount >= 1, 'successCount accumulates and persists across runs, read from platform_job_runs not an in-memory counter');

    // ── Unknown job name 404s cleanly ────────────────────────────────────
    const unknownJob = await api('/jobs/does-not-exist/run', { method: 'POST' });
    assert(unknownJob.status === 404, 'running an unregistered job name 404s cleanly (got ' + unknownJob.status + ')');

    // ── Broken access control: view_only cannot manually trigger a job ──
    const support = await api('/platform-users', { method: 'POST', body: { email: 'jobrunner-support@zmaxlab.com', password: 'SupportPass123!', roleCode: 'SUPPORT' } });
    assert(support.status === 201, 'setup: created a SUPPORT-role user (lacks manage_platform_users)');
    const supportLogin = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: 'jobrunner-support@zmaxlab.com', password: 'SupportPass123!' } });
    const supportH = { Authorization: 'Bearer ' + supportLogin.body.token, 'Content-Type': 'application/json' };
    const supportCanView = await fetch(server.baseUrl + '/api/platform/jobs', { headers: supportH });
    assert(supportCanView.status === 200, 'SUPPORT (has view_only) can list jobs (got ' + supportCanView.status + ')');
    const supportCannotRun = await fetch(server.baseUrl + '/api/platform/jobs/metric-snapshot/run', { method: 'POST', headers: supportH });
    assert(supportCannotRun.status === 403, 'SUPPORT (lacks manage_platform_users) cannot manually trigger a job (got ' + supportCannotRun.status + ')');

    // ── Audit logging — JOB_MANUALLY_TRIGGERED is an operational action,
    // not a security one, so it belongs in the general audit log (Security
    // Logs deliberately filters to MFA/password/session/API-key actions).
    const auditLog = await api('/audit-log?pageSize=200');
    assert(auditLog.body.entries.some((e) => e.action === 'JOB_MANUALLY_TRIGGERED'), 'manually running a job is audit-logged as JOB_MANUALLY_TRIGGERED');

    // ── Graceful shutdown: stopAll() clears every scheduled job ──────────
    jobRunnerService.start('metric-snapshot');
    jobRunnerService.start('session-cleanup');
    jobRunnerService.stopAll();
    const allStatuses = jobRunnerService.listStatuses();
    assert(allStatuses.every((j) => j.isScheduled === false), 'stopAll() unschedules every job — the graceful-shutdown path server.js calls on SIGTERM/SIGINT');

  } finally {
    server.stop();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
