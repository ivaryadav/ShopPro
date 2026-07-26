/**
 * platform/src/jobs/renewalReminderJob.js — Phase 5E. Sends a real
 * renewal-reminder email (reusing organizationService.sendEmail's
 * existing 'renewal-reminder' template from Phase 5A) to every
 * organization — local AND every configured adapter — whose license is
 * ACTIVE and expires within 7 days. Deduped via platform_license_history
 * (organization_id is TEXT there, so it works identically for adapter-
 * backed organizations, unlike platform_notifications which is local-only)
 * so the same organization isn't emailed again inside a 7-day window.
 * One organization's send failure (no email on file, SMTP unreachable)
 * is caught and skipped — it never aborts the run for the rest.
 */
'use strict';

const { getDb } = require('../database/connection');
const licenseHistoryRepository = require('../repositories/platformLicenseHistoryRepository');
const organizationService = require('./../services/organizationService');
const { listConfiguredAdapters } = require('../adapters');

const SYSTEM_ACTOR = { userId: null, email: 'system', ip: 'system' };

function alreadyRemindedRecently(organizationId) {
  return licenseHistoryRepository.listForOrganization(organizationId, 20)
    .some((h) => h.event_type === 'REMINDER_SENT' && new Date(h.created_at).getTime() > Date.now() - 7 * 86400000);
}

async function run() {
  const db = getDb();
  const candidates = [];

  const local = db.prepare(`
    SELECT l.organization_id, l.product_id FROM platform_licenses l
    WHERE l.status = 'ACTIVE' AND l.expires_at IS NOT NULL
      AND l.expires_at <= datetime('now', '+7 days') AND l.expires_at > datetime('now')
  `).all();
  for (const l of local) candidates.push({ organizationId: String(l.organization_id), productId: l.product_id });

  for (const { adapter } of listConfiguredAdapters()) {
    const result = await adapter.listOrganizations({ page: 1, pageSize: 500 });
    for (const o of result.organizations || []) {
      if (!o.license || o.license.status !== 'ACTIVE' || !o.license.expiresAt) continue;
      const days = Math.ceil((new Date(o.license.expiresAt).getTime() - Date.now()) / 86400000);
      if (days > 0 && days <= 7) candidates.push({ organizationId: o.id, productId: null });
    }
  }

  let sent = 0;
  for (const c of candidates) {
    if (alreadyRemindedRecently(c.organizationId)) continue;
    try {
      await organizationService.sendEmail(c.organizationId, 'renewal-reminder', {}, SYSTEM_ACTOR);
      licenseHistoryRepository.record({ organizationId: c.organizationId, productId: c.productId, eventType: 'REMINDER_SENT', detail: 'renewal reminder email sent', actor: 'system' });
      sent++;
    } catch (e) {
      licenseHistoryRepository.record({ organizationId: c.organizationId, productId: c.productId, eventType: 'REMINDER_FAILED', detail: e.message, actor: 'system' });
    }
  }
  return { itemsProcessed: sent };
}

module.exports = { run };
