/**
 * platform/src/controllers/healthController.js — System Health (Phase 5A,
 * job status wired to the real Job Runner in Phase 5C).
 *
 * The authenticated, detailed view an operator uses to answer "is the
 * platform up, is the database reachable, is each product's adapter
 * reachable, are the background jobs actually running" at a glance — the
 * same question every mature console (AWS Service Health, GitHub
 * Enterprise site admin, Azure Monitor) answers on one screen.
 * Unauthenticated liveness lives at GET /healthz (platform/src/app.js)
 * for load-balancer/uptime-monitor probes.
 */
'use strict';

const { getDb } = require('../database/connection');
const { REGISTRY, listConfiguredAdapters } = require('../adapters');
const jobRunnerService = require('../services/jobRunnerService');
const pkg = require('../../package.json');

const SYNC_STALE_THRESHOLD_MINUTES = 30; // matches maintenanceSyncMonitorJob's own threshold

/**
 * Phase 5D — reuses two signals that already exist rather than adding new
 * tracking: the Maintenance Synchronization Job's own persisted success/
 * failure counts (Sync Success Rate), and the MAINTENANCE_SYNC_PULLED
 * audit trail every product pull already writes (Last Sync, Products
 * Connected, per-product Cache Status) — Z-SUPERADMIN never calls out to
 * a product, so this is the only way it can observe sync health at all.
 */
function maintenanceHealth() {
  const db = getDb();
  const lastPublish = db.prepare("SELECT created_at FROM platform_maintenance_history WHERE action = 'PUBLISHED' ORDER BY created_at DESC LIMIT 1").get();
  const lastSyncRow = db.prepare("SELECT created_at, detail FROM platform_audit_logs WHERE action = 'MAINTENANCE_SYNC_PULLED' ORDER BY created_at DESC LIMIT 1").get();
  const activeAnywhere = db.prepare("SELECT COUNT(*) c FROM platform_maintenance_windows WHERE status = 'active'").get().c;

  const monitorStatus = jobRunnerService.getStatus('maintenance-sync-monitor');
  const totalRuns = monitorStatus ? monitorStatus.successCount + monitorStatus.failureCount : 0;
  const syncSuccessRate = totalRuns > 0 ? Math.round((monitorStatus.successCount / totalRuns) * 100) : null;

  const products = listConfiguredAdapters().map(({ slug }) => {
    const recent = db.prepare(`
      SELECT created_at FROM platform_audit_logs
      WHERE action = 'MAINTENANCE_SYNC_PULLED' AND detail = ? AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(slug, `-${SYNC_STALE_THRESHOLD_MINUTES} minutes`);
    return { slug, connected: !!recent, cacheStatus: recent ? 'fresh' : 'stale-or-never-synced', lastSyncedAt: recent ? recent.created_at : null };
  });

  return {
    maintenanceActiveAnywhere: activeAnywhere > 0,
    lastPublishAt: lastPublish ? lastPublish.created_at : null,
    lastSyncAt: lastSyncRow ? lastSyncRow.created_at : null,
    syncSuccessRate,
    productsConnected: products.filter((p) => p.connected).length,
    productsTotal: products.length,
    products,
  };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

async function health(req, res, next) {
  try {
    let dbStatus = 'ok';
    try { getDb().prepare('SELECT 1').get(); } catch (e) { dbStatus = 'error'; }

    const services = [];
    for (const [slug, adapter] of Object.entries(REGISTRY)) {
      const configured = adapter.isConfigured();
      let reachable = null;
      let checkedAt = new Date().toISOString();
      if (configured) {
        try { await withTimeout(adapter.getDashboardStats(), 3000); reachable = true; }
        catch (e) { reachable = false; }
      }
      services.push({ slug, configured, reachable, checkedAt });
    }

    const jobStatuses = jobRunnerService.listStatuses();
    res.json({
      platformStatus: dbStatus === 'ok' ? 'operational' : 'degraded',
      database: { status: dbStatus },
      services,
      jobs: {
        count: jobStatuses.length,
        running: jobStatuses.filter((j) => j.isRunning).length,
        failing: jobStatuses.filter((j) => j.lastStatus === 'failure').length,
        jobs: jobStatuses,
      },
      maintenance: maintenanceHealth(),
      version: { platform: pkg.version, node: process.version, uptimeSeconds: Math.floor(process.uptime()) },
    });
  } catch (e) { next(e); }
}

module.exports = { health };
