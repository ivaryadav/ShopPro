/**
 * server/maintenanceSync.js — Phase 5D: Platform Maintenance & Business
 * Continuity. Z-SUPERADMIN is the single source of truth for maintenance
 * policy; this module is the ONLY place ShopERP ever calls out to it —
 * a periodic PULL, never a push, and every other part of the request
 * path (maintenanceGate, login) reads only the local cache, never this
 * module's network call directly. That is what "continues enforcing it
 * even if Z-SUPERADMIN becomes temporarily unavailable" means in practice
 * — a sync failure updates last_sync_status only; it never touches the
 * cached payload, so the last known-good policy keeps being enforced
 * exactly as before the failure.
 *
 * Fully optional, like every other cross-service integration in this
 * repo (see the ShopERP adapter's isConfigured() convention on the
 * platform/ side) — unset ZSUPERADMIN_BASE_URL/ZSUPERADMIN_API_KEY means
 * this is a complete no-op: no sync attempted, ShopERP behaves exactly
 * as it did before this feature existed.
 */
'use strict';

// Read lazily (inside functions), never cached at module-load time: local.js
// requires this module before it finishes parsing its own .env file, so any
// value captured here as a top-level const would permanently see an empty
// process.env regardless of what's actually configured.
function baseUrl() { return (process.env.ZSUPERADMIN_BASE_URL || '').replace(/\/$/, ''); }
function apiKey() { return process.env.ZSUPERADMIN_API_KEY || ''; }
function productSlug() { return process.env.ZMAX_PRODUCT_SLUG || 'shoperp'; }
function syncIntervalMs() { return Number(process.env.MAINTENANCE_SYNC_INTERVAL_MS) || 2 * 60 * 1000; }

function isConfigured() { return !!(baseUrl() && apiKey()); }

function ensureCacheRow(db) {
  db.prepare("INSERT OR IGNORE INTO maintenance_cache (id, payload, last_sync_status) VALUES (1, '{}', 'never')").run();
}

function getCache(db) {
  return db.prepare('SELECT * FROM maintenance_cache WHERE id = 1').get();
}

/** One sync attempt. Exported directly (not just via start()) so tests can trigger and await a single, deterministic sync without waiting on a real interval — same reasoning platform/'s Job Runner runNow() exists for. */
async function syncOnce(db, logger) {
  const log = logger || console;
  if (!isConfigured()) return { skipped: true };
  try {
    const res = await fetch(`${baseUrl()}/api/platform/maintenance/effective?product=${encodeURIComponent(productSlug())}`, {
      headers: { 'X-Platform-Api-Key': apiKey() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    db.prepare(`
      UPDATE maintenance_cache SET payload = ?, last_synced_at = datetime('now'),
        last_sync_status = 'success', last_sync_error = NULL, updated_at = datetime('now')
      WHERE id = 1
    `).run(JSON.stringify(payload));
    return { ok: true };
  } catch (e) {
    db.prepare(`
      UPDATE maintenance_cache SET last_sync_status = 'failure', last_sync_error = ?, updated_at = datetime('now')
      WHERE id = 1
    `).run(e.message);
    log.error('[Maintenance Sync] failed — continuing to enforce the last known-good cached policy', { error: e.message });
    return { ok: false, error: e.message };
  }
}

function start(db, logger) {
  ensureCacheRow(db);
  if (!isConfigured()) {
    (logger || console).warn('[Maintenance Sync] ZSUPERADMIN_BASE_URL/ZSUPERADMIN_API_KEY not set — maintenance sync disabled, no behavior change from before this feature existed.');
    return;
  }
  syncOnce(db, logger);
  setInterval(() => syncOnce(db, logger), syncIntervalMs());
}

module.exports = { start, syncOnce, isConfigured, ensureCacheRow, getCache, get PRODUCT_SLUG() { return productSlug(); } };
