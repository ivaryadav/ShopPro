'use strict';

const { getDb } = require('../database/connection');

/** Idempotent by date — re-running the job twice on the same day overwrites, not duplicates, today's snapshot. */
function upsert({ snapshotDate, totalOrganizations, activeLicenses, expiredLicenses, activeSessions }) {
  getDb().prepare(`
    INSERT INTO platform_metric_snapshots (snapshot_date, total_organizations, active_licenses, expired_licenses, active_sessions)
    VALUES (?,?,?,?,?)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      total_organizations = excluded.total_organizations, active_licenses = excluded.active_licenses,
      expired_licenses = excluded.expired_licenses, active_sessions = excluded.active_sessions
  `).run(snapshotDate, totalOrganizations, activeLicenses, expiredLicenses, activeSessions);
}
function listRecent(days) {
  return getDb().prepare("SELECT * FROM platform_metric_snapshots WHERE snapshot_date >= date('now', ?) ORDER BY snapshot_date ASC").all(`-${days} days`);
}

module.exports = { upsert, listRecent };
