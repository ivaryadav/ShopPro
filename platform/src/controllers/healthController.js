/**
 * platform/src/controllers/healthController.js — System Health (Phase 5A).
 *
 * The authenticated, detailed view an operator uses to answer "is the
 * platform up, is the database reachable, is each product's adapter
 * reachable" at a glance — the same question every mature console
 * (AWS Service Health, GitHub Enterprise site admin, Azure Monitor)
 * answers on one screen. Unauthenticated liveness lives at GET /healthz
 * (platform/src/app.js) for load-balancer/uptime-monitor probes.
 */
'use strict';

const { getDb } = require('../database/connection');
const { REGISTRY } = require('../adapters');
const pkg = require('../../package.json');

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

    res.json({
      platformStatus: dbStatus === 'ok' ? 'operational' : 'degraded',
      database: { status: dbStatus },
      services,
      // Scheduled job infrastructure is a later milestone (Phase 5B+) — no
      // jobs are configured today, reported honestly rather than faked.
      jobs: { count: 0, note: 'Scheduled job infrastructure is a later milestone' },
      version: { platform: pkg.version, node: process.version, uptimeSeconds: Math.floor(process.uptime()) },
    });
  } catch (e) { next(e); }
}

module.exports = { health };
