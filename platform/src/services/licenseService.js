/**
 * platform/src/services/licenseService.js — License Center. The platform
 * owns every license, for every organization, for every product — one
 * platform_licenses row per (organization, product) pair, same proven
 * 5-state model (TRIAL/ACTIVE/READ_ONLY/SUSPENDED/ARCHIVED) as ShopERP's
 * own tenant_licenses, generalized across products.
 *
 * Adapter-backed organizations (ShopERP today) have no platform_licenses
 * row at all — every action below dispatches straight to the adapter's
 * corresponding real ShopERP endpoint, reusing that existing service
 * exactly, never reimplementing license business rules here.
 *
 * Phase 5E: every action also writes a platform_license_history row (in
 * addition to the general platform_audit_logs entry it already wrote) —
 * organization_id keyed as TEXT so the same history table covers both
 * local and adapter-backed organizations, making "License Timeline" a
 * real, dedicated view rather than a filtered slice of the general audit
 * log. "Cancel" has no distinct adapter verb (the adapter contract is
 * frozen) — for adapter-backed organizations it dispatches to the same
 * suspendTenant() capability that already exists, with a "cancelled"
 * reason; for local organizations it is a genuine terminal ARCHIVED state
 * (cancelled_at distinguishes a cancellation from any other path to
 * ARCHIVED), mirroring the precedent already set for registration
 * rejection.
 */
'use strict';

const crypto = require('crypto');
const licenseRepository = require('../repositories/platformLicenseRepository');
const licenseHistoryRepository = require('../repositories/platformLicenseHistoryRepository');
const planRepository = require('../repositories/platformSubscriptionPlanRepository');
const auditService = require('./auditService');
const eventBusService = require('./eventBusService');
const orgRef = require('./orgRef');
const { listConfiguredAdapters } = require('../adapters');
const { NotFoundError: NF, ValidationError: VE } = require('../errors');

const KEY_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — matches server/license.js's convention

function generateLicenseKey() {
  const group = () => { const b = crypto.randomBytes(4); let s = ''; for (let i = 0; i < 4; i++) s += KEY_CHARSET[b[i] % KEY_CHARSET.length]; return s; };
  return `ZMAX-${group()}-${group()}-${group()}`;
}

function validatePlanCode(planCode) {
  const plan = planRepository.findByCode(planCode);
  if (!plan || !plan.is_active) throw new VE(`Unknown or inactive plan code: ${planCode}`);
  return plan;
}

function recordHistory(rawOrgId, productId, eventType, fromValue, toValue, detail, actor) {
  licenseHistoryRepository.record({ organizationId: rawOrgId, productId, eventType, fromValue, toValue, detail, actor: (actor && actor.email) || 'system' });
}

function getLicense(organizationId, productId) {
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('No license found for this organization/product');
  return lic;
}

async function activate(rawOrgId, productId, { planCode, days }, actor) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    if (planCode) await ref.adapter.assignPlan(ref.sourceId, planCode, 'monthly');
    if (days) await ref.adapter.extendLicense(ref.sourceId, days);
    else await ref.adapter.reactivateTenant(ref.sourceId);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_ACTIVATED', newValue: 'ACTIVE', detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    recordHistory(rawOrgId, null, 'ACTIVATED', null, 'ACTIVE', planCode ? `plan: ${planCode}` : '', actor);
    return { status: 'ACTIVE', plan_code: planCode || null, expires_at: null };
  }
  if (planCode) validatePlanCode(planCode);
  const organizationId = ref.localId;
  let lic = licenseRepository.find(organizationId, productId);
  const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  if (!lic) lic = licenseRepository.create({ organizationId, productId, planCode: planCode || 'BASIC', status: 'ACTIVE', expiresAt });
  else lic = licenseRepository.update(lic.id, { status: 'ACTIVE', planCode: planCode || lic.plan_code, expiresAt: expiresAt || lic.expires_at });
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_ACTIVATED', oldValue: lic.status, newValue: 'ACTIVE', ip: actor.ip });
  recordHistory(organizationId, productId, 'ACTIVATED', lic.status, 'ACTIVE', planCode ? `plan: ${planCode}` : '', actor);
  return lic;
}

/** License Assignment — explicitly assign a catalog plan to an org/product, generating a license key if none exists yet. */
async function assign(rawOrgId, productId, planCode, actor) {
  if (!planCode) throw new VE('planCode is required');
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    validatePlanCode(planCode); // still validate against the shared catalog, even though the adapter stores its own copy
    await ref.adapter.assignPlan(ref.sourceId, planCode, 'monthly');
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_ASSIGNED', newValue: planCode, detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    recordHistory(rawOrgId, null, 'ASSIGNED', null, planCode, '', actor);
    eventBusService.publish({ eventType: 'license.issued', organizationId: rawOrgId, payload: { organizationId: rawOrgId, planCode } });
    return { plan_code: planCode };
  }
  validatePlanCode(planCode);
  const organizationId = ref.localId;
  let lic = licenseRepository.find(organizationId, productId);
  const key = (lic && lic.license_key) || generateLicenseKey();
  if (!lic) lic = licenseRepository.create({ organizationId, productId, planCode, status: 'TRIAL' });
  lic = licenseRepository.update(lic.id, { planCode });
  if (!lic.license_key) require('../database/connection').getDb().prepare('UPDATE platform_licenses SET license_key = ? WHERE id = ?').run(key, lic.id);
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_ASSIGNED', newValue: planCode, ip: actor.ip });
  recordHistory(organizationId, productId, 'ASSIGNED', null, planCode, `key: ${key}`, actor);
  eventBusService.publish({ eventType: 'license.issued', organizationId, productId, payload: { organizationId, productId, planCode, licenseKey: key } });
  return licenseRepository.findById(lic.id);
}

async function suspend(rawOrgId, productId, reason, actor) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    await ref.adapter.suspendTenant(ref.sourceId, reason);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_SUSPENDED', newValue: 'SUSPENDED', detail: `${ref.slug}:${ref.sourceId} — ${reason || ''}`, ip: actor.ip });
    recordHistory(rawOrgId, null, 'SUSPENDED', null, 'SUSPENDED', reason || '', actor);
    return { status: 'SUSPENDED' };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const updated = licenseRepository.update(lic.id, { status: 'SUSPENDED' });
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_SUSPENDED', oldValue: lic.status, newValue: 'SUSPENDED', detail: reason || '', ip: actor.ip });
  recordHistory(organizationId, productId, 'SUSPENDED', lic.status, 'SUSPENDED', reason || '', actor);
  return updated;
}

async function resume(rawOrgId, productId, actor) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    await ref.adapter.reactivateTenant(ref.sourceId);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_RESUMED', newValue: 'ACTIVE', detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    recordHistory(rawOrgId, null, 'RESUMED', null, 'ACTIVE', '', actor);
    return { status: 'ACTIVE' };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const updated = licenseRepository.update(lic.id, { status: 'ACTIVE' });
  require('../database/connection').getDb().prepare("UPDATE platform_licenses SET grace_started_at = NULL WHERE id = ?").run(lic.id);
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_RESUMED', oldValue: lic.status, newValue: 'ACTIVE', ip: actor.ip });
  recordHistory(organizationId, productId, 'RESUMED', lic.status, 'ACTIVE', '', actor);
  return updated;
}

async function renew(rawOrgId, productId, { days }, actor) {
  if (!days || days <= 0) throw new VE('days must be a positive number');
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    const result = await ref.adapter.extendLicense(ref.sourceId, days);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_RENEWED', newValue: result.expiresAt, detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    recordHistory(rawOrgId, null, 'RENEWED', null, result.expiresAt, `+${days} days`, actor);
    eventBusService.publish({ eventType: 'license.renewed', organizationId: rawOrgId, payload: { organizationId: rawOrgId, expiresAt: result.expiresAt, days } });
    return { expires_at: result.expiresAt };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const base = lic.expires_at && new Date(lic.expires_at).getTime() > Date.now() ? new Date(lic.expires_at) : new Date();
  const expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  const updated = licenseRepository.update(lic.id, { expiresAt, status: 'ACTIVE' });
  require('../database/connection').getDb().prepare("UPDATE platform_licenses SET grace_started_at = NULL WHERE id = ?").run(lic.id);
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_RENEWED', oldValue: lic.expires_at, newValue: expiresAt, ip: actor.ip });
  recordHistory(organizationId, productId, 'RENEWED', lic.expires_at, expiresAt, `+${days} days`, actor);
  eventBusService.publish({ eventType: 'license.renewed', organizationId, productId, payload: { organizationId, productId, expiresAt, days } });
  return updated;
}

async function changePlan(rawOrgId, productId, planCode, direction, actor) {
  if (!planCode) throw new VE('planCode is required');
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    validatePlanCode(planCode);
    await ref.adapter.assignPlan(ref.sourceId, planCode, 'monthly');
    const eventType = direction === 'upgrade' ? 'LICENSE_UPGRADED' : 'LICENSE_DOWNGRADED';
    auditService.record({ platformUserId: actor.userId, action: eventType, newValue: planCode, detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    recordHistory(rawOrgId, null, direction === 'upgrade' ? 'UPGRADED' : 'DOWNGRADED', null, planCode, '', actor);
    eventBusService.publish({ eventType: 'subscription.changed', organizationId: rawOrgId, payload: { organizationId: rawOrgId, direction, planCode } });
    return { plan_code: planCode };
  }
  validatePlanCode(planCode);
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const updated = licenseRepository.update(lic.id, { planCode });
  const eventType = direction === 'upgrade' ? 'LICENSE_UPGRADED' : 'LICENSE_DOWNGRADED';
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: eventType, oldValue: lic.plan_code, newValue: planCode, ip: actor.ip });
  recordHistory(organizationId, productId, direction === 'upgrade' ? 'UPGRADED' : 'DOWNGRADED', lic.plan_code, planCode, '', actor);
  eventBusService.publish({ eventType: 'subscription.changed', organizationId, productId, payload: { organizationId, productId, direction, fromPlan: lic.plan_code, toPlan: planCode } });
  return updated;
}

/** Cancel — a genuine terminal state for local organizations (ARCHIVED); the closest available adapter capability (suspend) for adapter-backed ones, since the frozen adapter contract has no distinct "cancel" verb. */
async function cancel(rawOrgId, productId, reason, actor) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    await ref.adapter.suspendTenant(ref.sourceId, reason || 'Subscription cancelled');
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_CANCELLED', newValue: 'CANCELLED', detail: `${ref.slug}:${ref.sourceId} — ${reason || ''}`, ip: actor.ip });
    recordHistory(rawOrgId, null, 'CANCELLED', null, 'CANCELLED', reason || '', actor);
    return { status: 'CANCELLED' };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  require('../database/connection').getDb().prepare("UPDATE platform_licenses SET status = 'ARCHIVED', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(lic.id);
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_CANCELLED', oldValue: lic.status, newValue: 'ARCHIVED', detail: reason || '', ip: actor.ip });
  recordHistory(organizationId, productId, 'CANCELLED', lic.status, 'ARCHIVED', reason || '', actor);
  return licenseRepository.findById(lic.id);
}

/** License Timeline / Renewal History — merges the dedicated platform_license_history with, for adapter-backed orgs, the product's own native history (e.g. ShopERP's own license_history), so nothing Z-SUPERADMIN didn't directly cause is missing. */
async function getLicenseHistory(rawOrgId) {
  const own = licenseHistoryRepository.listForOrganization(rawOrgId).map((h) => ({
    source: 'platform', eventType: h.event_type, fromValue: h.from_value, toValue: h.to_value,
    detail: h.detail, actor: h.actor, productName: h.product_name, timestamp: h.created_at,
  }));
  const ref = orgRef.resolve(rawOrgId);
  let native = [];
  if (ref.isAdapter) {
    const d = await ref.adapter.getOrganization(ref.sourceId);
    native = (d.history || []).map((a) => ({
      source: ref.slug, eventType: a.eventType, fromValue: a.oldValue, toValue: a.newValue,
      detail: a.detail, actor: a.actor || 'system', productName: ref.slug, timestamp: a.timestamp,
    }));
  }
  return [...own, ...native].filter((e) => e.timestamp).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/** Grace Countdown — days remaining in a READ_ONLY license's grace period before it auto-suspends, for local orgs only (adapter-backed grace is the product's own concept). */
function getGraceCountdown(lic) {
  if (!lic || lic.status !== 'READ_ONLY' || !lic.grace_started_at) return null;
  const graceEnds = new Date(lic.grace_started_at).getTime() + lic.grace_period_days * 86400000;
  return Math.max(0, Math.ceil((graceEnds - Date.now()) / 86400000));
}

/** Expiration Dashboard — buckets every license (local + every configured adapter) by urgency. */
async function getExpirationDashboard() {
  const db = require('../database/connection').getDb();
  const buckets = { expiringSoon: [], expiring30: [], inGrace: [], suspended: [] };
  const local = db.prepare(`
    SELECT l.*, o.business_name, p.name AS product_name FROM platform_licenses l
    JOIN organizations o ON o.id = l.organization_id JOIN platform_products p ON p.id = l.product_id
  `).all();
  for (const l of local) {
    const entry = { organizationId: String(l.organization_id), businessName: l.business_name, productName: l.product_name, planCode: l.plan_code, status: l.status, expiresAt: l.expires_at };
    if (l.status === 'READ_ONLY') { entry.graceDaysRemaining = getGraceCountdown(l); buckets.inGrace.push(entry); }
    else if (l.status === 'SUSPENDED') buckets.suspended.push(entry);
    else if (l.status === 'ACTIVE' && l.expires_at) {
      const days = Math.ceil((new Date(l.expires_at).getTime() - Date.now()) / 86400000);
      if (days <= 7) buckets.expiringSoon.push({ ...entry, daysRemaining: days });
      else if (days <= 30) buckets.expiring30.push({ ...entry, daysRemaining: days });
    }
  }
  for (const { slug, adapter } of listConfiguredAdapters()) {
    const result = await adapter.listOrganizations({ page: 1, pageSize: 500 });
    for (const o of result.organizations || []) {
      const lic = o.license;
      if (!lic || !lic.expiresAt) continue;
      const days = Math.ceil((new Date(lic.expiresAt).getTime() - Date.now()) / 86400000);
      const entry = { organizationId: o.id, businessName: o.businessName, productName: slug, planCode: lic.planCode, status: lic.status, expiresAt: lic.expiresAt, daysRemaining: days };
      if (lic.status === 'READ_ONLY') buckets.inGrace.push(entry);
      else if (lic.status === 'SUSPENDED') buckets.suspended.push(entry);
      else if (days <= 7) buckets.expiringSoon.push(entry);
      else if (days <= 30) buckets.expiring30.push(entry);
    }
  }
  return buckets;
}

module.exports = {
  getLicense, activate, assign, suspend, resume, renew, changePlan, cancel,
  getLicenseHistory, getGraceCountdown, getExpirationDashboard,
  generateLicenseKey, validatePlanCode,
};
