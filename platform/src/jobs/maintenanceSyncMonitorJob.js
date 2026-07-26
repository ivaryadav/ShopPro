/**
 * platform/src/jobs/maintenanceSyncMonitorJob.js — Phase 5D Maintenance
 * Synchronization Job. Z-SUPERADMIN never calls OUT to a product (that
 * would be exactly the runtime dependency this whole feature is designed
 * to avoid) — so this job only WATCHES inbound pull activity, reusing the
 * existing audit log rather than a new table ("create only the required
 * tables" — platform_maintenance_windows/_history are the only new ones).
 * Every GET /maintenance/effective?product=X call is audited as
 * MAINTENANCE_SYNC_PULLED with detail=X (see maintenanceController);
 * this job checks each configured adapter product had one recently.
 *
 * A product that has NEVER synced (fresh install, or misconfigured
 * maintenanceSync.js) is reported as a genuine job FAILURE, not silently
 * ignored — that is real, actionable information for an operator, and
 * surfaces directly in the existing Job Runner history/health UI with no
 * new monitoring surface needed.
 */
'use strict';

const { getDb } = require('../database/connection');
const { listConfiguredAdapters } = require('../adapters');

const STALE_THRESHOLD_MINUTES = 30; // generous relative to ShopERP's ~2-minute poll interval

async function run() {
  const adapters = listConfiguredAdapters();
  if (!adapters.length) return { itemsProcessed: 0 };
  const db = getDb();
  const stale = [];
  for (const { slug } of adapters) {
    const recent = db.prepare(`
      SELECT 1 FROM platform_audit_logs
      WHERE action = 'MAINTENANCE_SYNC_PULLED' AND detail = ? AND created_at >= datetime('now', ?)
      LIMIT 1
    `).get(slug, `-${STALE_THRESHOLD_MINUTES} minutes`);
    if (!recent) stale.push(slug);
  }
  if (stale.length) throw new Error(`Product(s) have not synced maintenance policy in the last ${STALE_THRESHOLD_MINUTES} minutes: ${stale.join(', ')}`);
  return { itemsProcessed: adapters.length };
}

module.exports = { run };
