/**
 * platform/src/jobs/licenseExpiryJob.js — Phase 5E. Transitions local
 * (platform_licenses) ACTIVE licenses into READ_ONLY once expires_at has
 * passed, starting the grace-period countdown gracePeriodJob later
 * enforces. Adapter-backed organizations (ShopERP) are deliberately NOT
 * touched here — ShopERP already runs its own license transition sweep
 * over its own tenant_licenses; duplicating that here would be a second,
 * competing source of truth for state ShopERP already owns and enforces.
 * This job — like every other job in this file — only ever affects
 * platform_licenses, the platform's own local-organization entitlement
 * table.
 */
'use strict';

const { getDb } = require('../database/connection');
const licenseHistoryRepository = require('../repositories/platformLicenseHistoryRepository');
const eventBusService = require('../services/eventBusService');

async function run() {
  const db = getDb();
  const due = db.prepare("SELECT * FROM platform_licenses WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= datetime('now')").all();
  const update = db.prepare("UPDATE platform_licenses SET status = 'READ_ONLY', grace_started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?");
  for (const lic of due) {
    update.run(lic.id);
    licenseHistoryRepository.record({ organizationId: lic.organization_id, productId: lic.product_id, eventType: 'EXPIRED', fromValue: 'ACTIVE', toValue: 'READ_ONLY', detail: `expired at ${lic.expires_at}`, actor: 'system' });
    eventBusService.publish({ eventType: 'license.expired', organizationId: lic.organization_id, productId: lic.product_id, payload: { organizationId: lic.organization_id, productId: lic.product_id, expiredAt: lic.expires_at } });
  }
  return { itemsProcessed: due.length };
}

module.exports = { run };
