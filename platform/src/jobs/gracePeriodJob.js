/**
 * platform/src/jobs/gracePeriodJob.js — Phase 5E. Transitions local
 * (platform_licenses) READ_ONLY licenses into SUSPENDED once their
 * per-license grace_period_days has elapsed since grace_started_at (set
 * by licenseExpiryJob). Local-organizations only — see licenseExpiryJob's
 * header comment for why adapter-backed (ShopERP) organizations are
 * deliberately out of scope here.
 */
'use strict';

const { getDb } = require('../database/connection');
const licenseHistoryRepository = require('../repositories/platformLicenseHistoryRepository');

async function run() {
  const db = getDb();
  const due = db.prepare(`
    SELECT * FROM platform_licenses
    WHERE status = 'READ_ONLY' AND grace_started_at IS NOT NULL
      AND datetime(grace_started_at, '+' || grace_period_days || ' days') <= datetime('now')
  `).all();
  const update = db.prepare("UPDATE platform_licenses SET status = 'SUSPENDED', updated_at = datetime('now') WHERE id = ?");
  for (const lic of due) {
    update.run(lic.id);
    licenseHistoryRepository.record({ organizationId: lic.organization_id, productId: lic.product_id, eventType: 'SUSPENDED', fromValue: 'READ_ONLY', toValue: 'SUSPENDED', detail: `grace period (${lic.grace_period_days}d) elapsed`, actor: 'system' });
  }
  return { itemsProcessed: due.length };
}

module.exports = { run };
