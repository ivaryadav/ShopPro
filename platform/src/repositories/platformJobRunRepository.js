'use strict';

const { getDb } = require('../database/connection');

function record({ jobName, startedAt, finishedAt, status, detail, itemsProcessed, attempts, durationMs }) {
  getDb().prepare(`
    INSERT INTO platform_job_runs (job_name, started_at, finished_at, status, detail, items_processed, attempts, duration_ms)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(jobName, startedAt, finishedAt, status, detail || '', itemsProcessed === undefined ? null : itemsProcessed, attempts || 1, durationMs || 0);
}
function listForJob(jobName, limit) {
  return getDb().prepare('SELECT * FROM platform_job_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT ?').all(jobName, limit || 20);
}
function statsForJob(jobName) {
  return getDb().prepare(`
    SELECT
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failure_count
    FROM platform_job_runs WHERE job_name = ?
  `).get(jobName);
}

module.exports = { record, listForJob, statsForJob };
