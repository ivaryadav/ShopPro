/**
 * platform/src/services/organizationService.js — Organization Management.
 * One organization, many products (organization_products) for LOCAL,
 * platform-owned organizations — the multi-product-per-customer model the
 * mission requires (ABC Healthcare example: ShopERP + ZLAB + ZHospital =
 * 3 organization_products rows).
 *
 * Adapter-backed products (ShopERP today) are different: ShopERP owns its
 * own tenant data entirely, so a ShopERP organization's ID is the synthetic
 * "shoperp:<tenantId>" form (see orgRef.js) and every operation on it
 * delegates straight to shoperpAdapter — no local row, no duplicate data.
 * "All Products" views merge local organizations with every configured
 * adapter's live results.
 */
'use strict';

const organizationRepository = require('../repositories/organizationRepository');
const organizationProductRepository = require('../repositories/organizationProductRepository');
const platformLicenseRepository = require('../repositories/platformLicenseRepository');
const organizationDeviceRepository = require('../repositories/organizationDeviceRepository');
const organizationUserRepository = require('../repositories/organizationUserRepository');
const platformNotificationRepository = require('../repositories/platformNotificationRepository');
const productRepository = require('../repositories/platformProductRepository');
const auditLogRepository = require('../repositories/platformAuditLogRepository');
const organizationNoteRepository = require('../repositories/organizationNoteRepository');
const auditService = require('./auditService');
const orgRef = require('./orgRef');
const { listConfiguredAdapters } = require('../adapters');
const { ValidationError, NotFoundError } = require('../errors');

function createOrganization(data, actor) {
  if (!data.businessName) throw new ValidationError('businessName is required');
  const org = organizationRepository.create(data);
  auditService.record({ platformUserId: actor.userId, organizationId: org.id, action: 'ORGANIZATION_CREATED', detail: org.business_name, ip: actor.ip });
  return mapOrg(org);
}

/**
 * @param {{q?,status?,plan?,productId?,page?,pageSize?,sort?,dir?}} query
 * If productId resolves to a configured adapter product, delegate entirely
 * to it (single source, real pagination). Otherwise ("All Products" or a
 * local-only product filter), merge the local table with every configured
 * adapter — simple concatenation, since there is realistically one live
 * adapter today; documented as a v1 simplification for when multiple
 * adapter-backed products exist simultaneously.
 */
async function listOrganizations(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));

  if (query.productId) {
    const product = productRepository.findById(Number(query.productId));
    const adapter = product ? require('../adapters').getAdapter(product.slug) : null;
    if (adapter && adapter.isConfigured()) {
      const result = await adapter.listOrganizations({ q: query.q, status: query.status, plan: query.plan, page, pageSize, sort: query.sort, dir: query.dir });
      return { organizations: result.organizations, total: result.total, page: result.page, pageSize: result.pageSize };
    }
  }

  const { rows, total } = organizationRepository.list({ q: query.q, status: query.status, productId: query.productId ? Number(query.productId) : null, page, pageSize, sort: query.sort, dir: query.dir });
  let organizations = rows.map(mapOrg);
  let mergedTotal = total;

  if (!query.productId) {
    const adapters = listConfiguredAdapters();
    for (const { adapter } of adapters) {
      const result = await adapter.listOrganizations({ q: query.q, status: query.status, plan: query.plan, page: 1, pageSize: 100 });
      organizations = organizations.concat(result.organizations);
      mergedTotal += result.total;
    }
  }
  return { organizations, total: mergedTotal, page, pageSize };
}

async function getOrganization(rawId) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    const d = await ref.adapter.getOrganization(ref.sourceId);
    return {
      business: { id: rawId, ...d.business },
      products: [{ productId: ref.slug, productName: ref.slug, productSlug: ref.slug, status: 'ACTIVE', activatedAt: d.business.createdAt }],
      licenses: d.license ? [{ ...d.license, productSlug: ref.slug, productName: ref.slug }] : [],
      devices: d.devices,
      users: (d.activity && d.activity.users) || [],
      emailsSent: [],
      auditHistory: d.history,
      activity: d.activity,
      source: ref.slug,
    };
  }
  const id = ref.localId;
  const org = organizationRepository.findById(id);
  if (!org) throw new NotFoundError('Organization not found');
  const products = organizationProductRepository.listForOrganization(id);
  const licenses = platformLicenseRepository.listForOrganization(id);
  const devices = organizationDeviceRepository.listForOrganization(id);
  const users = organizationUserRepository.listForOrganization(id);
  const notifications = platformNotificationRepository.listForOrganization(id);
  const { rows: auditHistory } = auditLogRepository.list({ organizationId: id, page: 1, pageSize: 50 });
  return {
    business: mapOrg(org),
    products: products.map((p) => ({ productId: p.product_id, productName: p.product_name, productSlug: p.product_slug, status: p.status, activatedAt: p.activated_at })),
    licenses: licenses.map(mapLicense),
    devices: devices.map((d) => ({ id: d.id, productName: d.product_name, deviceId: d.device_id, deviceName: d.device_name, browser: d.browser, os: d.os, lastSeen: d.last_seen, isActive: !!d.is_active })),
    users: users.map((u) => ({ id: u.id, productName: u.product_name, name: u.name, email: u.email, mobile: u.mobile, roleLabel: u.role_label, isActive: !!u.is_active, lastLogin: u.last_login })),
    emailsSent: notifications.map((n) => ({ type: n.type, recipient: n.recipient, subject: n.subject, status: n.status, sentAt: n.created_at })),
    auditHistory: auditHistory.map(mapAudit),
  };
}

function attachProduct(rawId, productSlug, actor) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) throw new ValidationError(`${ref.slug} organizations are managed entirely by their own product — products cannot be attached/detached through Z-SUPERADMIN`);
  const organizationId = ref.localId;
  const org = organizationRepository.findById(organizationId);
  if (!org) throw new NotFoundError('Organization not found');
  const product = productRepository.findBySlug(productSlug);
  if (!product) throw new NotFoundError('Product not found');
  organizationProductRepository.attach(organizationId, product.id);
  if (!platformLicenseRepository.find(organizationId, product.id)) {
    platformLicenseRepository.create({ organizationId, productId: product.id, planCode: 'TRIAL', status: 'TRIAL' });
  }
  auditService.record({ platformUserId: actor.userId, organizationId, productId: product.id, action: 'PRODUCT_ATTACHED', detail: `${org.business_name} <- ${product.name}`, ip: actor.ip });
  return getOrganization(organizationId);
}

async function setStatus(rawId, status, actor) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    // ShopERP's approve/suspend/reactivate are separate, more specific
    // actions than a generic status setter — see approve()/suspend() below,
    // which the controller calls directly for adapter-backed organizations.
    throw new ValidationError(`Use the approve/suspend actions for ${ref.slug} organizations`);
  }
  const organizationId = ref.localId;
  const org = organizationRepository.findById(organizationId);
  if (!org) throw new NotFoundError('Organization not found');
  organizationRepository.updateStatus(organizationId, status);
  auditService.record({ platformUserId: actor.userId, organizationId, action: 'ORGANIZATION_STATUS_CHANGED', oldValue: org.status, newValue: status, ip: actor.ip });
  return getOrganization(organizationId);
}

/** Support Center: Approve Organization — dispatches to the adapter for adapter-backed orgs. */
async function approve(rawId, actor) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    await ref.adapter.approveRegistration(ref.sourceId);
    auditService.record({ platformUserId: actor.userId, action: 'ORGANIZATION_APPROVED', detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    return getOrganization(rawId);
  }
  return setStatus(rawId, 'ACTIVE', actor);
}
/** Support Center: Suspend Organization — dispatches to the adapter for adapter-backed orgs. */
async function suspend(rawId, reason, actor) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    await ref.adapter.suspendTenant(ref.sourceId, reason);
    auditService.record({ platformUserId: actor.userId, action: 'ORGANIZATION_SUSPENDED', detail: `${ref.slug}:${ref.sourceId} — ${reason || ''}`, ip: actor.ip });
    return getOrganization(rawId);
  }
  const organizationId = ref.localId;
  const org = organizationRepository.findById(organizationId);
  if (!org) throw new NotFoundError('Organization not found');
  organizationRepository.updateStatus(organizationId, 'SUSPENDED');
  auditService.record({ platformUserId: actor.userId, organizationId, action: 'ORGANIZATION_STATUS_CHANGED', oldValue: org.status, newValue: 'SUSPENDED', detail: reason || '', ip: actor.ip });
  return getOrganization(organizationId);
}

async function listDevices(rawId) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    const d = await ref.adapter.getOrganization(ref.sourceId);
    return d.devices;
  }
  return organizationDeviceRepository.listForOrganization(ref.localId);
}
async function revokeDevice(rawId, deviceId, actor) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    await ref.adapter.revokeDevice(ref.sourceId, deviceId);
    auditService.record({ platformUserId: actor.userId, action: 'DEVICE_REVOKED', detail: `${ref.slug}:${ref.sourceId} device ${deviceId}`, ip: actor.ip });
    return { ok: true };
  }
  const ok = organizationDeviceRepository.revoke(Number(deviceId), ref.localId);
  if (!ok) throw new NotFoundError('Device not found');
  auditService.record({ platformUserId: actor.userId, organizationId: ref.localId, action: 'DEVICE_REVOKED', detail: `device ${deviceId}`, ip: actor.ip });
  return { ok: true };
}
async function renameDevice(rawId, deviceId, deviceName, actor) {
  const ref = orgRef.resolve(rawId);
  if (!ref.isAdapter) throw new ValidationError('Device rename is only available for adapter-backed organizations today');
  const result = await ref.adapter.renameDevice(ref.sourceId, deviceId, deviceName);
  auditService.record({ platformUserId: actor.userId, action: 'DEVICE_RENAMED', detail: `${ref.slug}:${ref.sourceId} device ${deviceId} -> "${deviceName}"`, ip: actor.ip });
  return result;
}

/** Support Center: Reset Password / Unlock Account / Force Logout / Login History — adapter-backed organizations only (Z-SUPERADMIN has no local end-user identity system of its own to manage; see platform/docs/Architecture.md). */
async function unlockAccount(rawId, actor) {
  const ref = orgRef.resolve(rawId);
  if (!ref.isAdapter) throw new ValidationError('Account lockout is a product-level (adapter) concept — not applicable to locally-managed organizations');
  const result = await ref.adapter.unlockAccount(ref.sourceId);
  auditService.record({ platformUserId: actor.userId, action: 'ACCOUNT_UNLOCKED', detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
  return result;
}
async function forcePasswordReset(rawId, actor) {
  const ref = orgRef.resolve(rawId);
  if (!ref.isAdapter) throw new ValidationError('Password reset is a product-level (adapter) concept — not applicable to locally-managed organizations');
  const result = await ref.adapter.forcePasswordReset(ref.sourceId);
  auditService.record({ platformUserId: actor.userId, action: 'PASSWORD_RESET', detail: `force reset for ${ref.slug}:${ref.sourceId}`, ip: actor.ip });
  return result;
}
async function killSessions(rawId, actor) {
  const ref = orgRef.resolve(rawId);
  if (!ref.isAdapter) throw new ValidationError('Force logout is a product-level (adapter) concept — not applicable to locally-managed organizations');
  const result = await ref.adapter.killSessions(ref.sourceId);
  auditService.record({ platformUserId: actor.userId, action: 'SESSIONS_KILLED', detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
  return result;
}
async function getLoginHistory(rawId) {
  const ref = orgRef.resolve(rawId);
  if (!ref.isAdapter) return [];
  return ref.adapter.getLoginHistory(ref.sourceId);
}
async function getFailedLogins(rawId) {
  const ref = orgRef.resolve(rawId);
  if (!ref.isAdapter) return [];
  return ref.adapter.getFailedLogins(ref.sourceId);
}

// ── Organization 360 Workspace (Phase 5A) ────────────────────────────────
/** Internal Notes — Z-SUPERADMIN's own operator context, never product data. */
function listNotes(rawId) {
  return organizationNoteRepository.listForOrganization(rawId).map((n) => ({
    id: n.id, authorEmail: n.author_email, note: n.note, createdAt: n.created_at,
  }));
}
function addNote(rawId, note, actor) {
  const trimmed = String(note || '').trim();
  if (!trimmed) throw new ValidationError('note is required');
  const created = organizationNoteRepository.create(rawId, actor.email || 'unknown', trimmed);
  const ref = orgRef.resolve(rawId);
  auditService.record({
    platformUserId: actor.userId, organizationId: ref.isAdapter ? null : ref.localId,
    action: 'NOTE_ADDED', detail: ref.isAdapter ? `${ref.slug}:${ref.sourceId} — ${trimmed.slice(0, 200)}` : trimmed.slice(0, 200), ip: actor.ip,
  });
  return { id: created.id, authorEmail: created.author_email, note: created.note, createdAt: created.created_at };
}

/** Renewals — every license for this org, soonest-expiring first, flagged urgent within 30 days. */
async function getRenewals(rawId) {
  const org = await getOrganization(rawId);
  const licenses = (org.licenses || []).slice()
    .sort((a, b) => {
      if (!a.expiresAt) return 1;
      if (!b.expiresAt) return -1;
      return new Date(a.expiresAt) - new Date(b.expiresAt);
    })
    .map((l) => ({ ...l, urgent: l.daysRemaining !== null && l.daysRemaining !== undefined && l.daysRemaining <= 30 }));
  return { licenses };
}

/** Security — login/lockout history for adapter-backed orgs (ShopERP has this); security-relevant audit entries for locally-managed orgs (no end-user identity system of their own yet). */
async function getSecurity(rawId) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    const [loginHistory, failedLogins] = await Promise.all([
      ref.adapter.getLoginHistory(ref.sourceId), ref.adapter.getFailedLogins(ref.sourceId),
    ]);
    return { loginHistory, failedLogins, securityEvents: [] };
  }
  const { rows } = auditLogRepository.list({ organizationId: ref.localId, page: 1, pageSize: 50 });
  const securityEvents = rows.filter((r) => /LOCK|PASSWORD|SESSION|SECURITY/i.test(r.action)).map(mapAudit);
  return { loginHistory: [], failedLogins: [], securityEvents };
}

/** Activity Timeline — every event this org has, from every source, merged and sorted. */
async function getActivityTimeline(rawId) {
  const org = await getOrganization(rawId);
  const notes = listNotes(rawId).map((n) => ({ type: 'note', timestamp: n.createdAt, actor: n.authorEmail, summary: n.note }));
  const auditEntries = (org.auditHistory || []).map((a) => ({
    type: 'audit', timestamp: a.timestamp, actor: a.admin || a.actor || 'system',
    summary: `${a.action || a.eventType || 'EVENT'}${a.detail ? ' — ' + a.detail : ''}`,
  }));
  const emailEntries = (org.emailsSent || []).map((e) => ({
    type: 'email', timestamp: e.sentAt, actor: 'system', summary: `Sent "${e.subject}" to ${e.recipient} (${e.status})`,
  }));
  let loginEntries = [];
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    const logins = await ref.adapter.getLoginHistory(ref.sourceId);
    loginEntries = logins.map((l) => ({
      type: 'login', timestamp: l.loginTime, actor: l.userName || 'unknown',
      summary: `Logged in from ${l.ip || 'unknown IP'} (${l.status || 'active'})`,
    }));
  }
  const timeline = [...notes, ...auditEntries, ...emailEntries, ...loginEntries]
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { timeline };
}

// ── Organization 360 Expansion (Phase 5E) ────────────────────────────────
/** Resolves the product to use for a single-product-scoped view when the caller doesn't specify one — the adapter's own product for adapter orgs, or the first attached product for local orgs. */
function primaryProductId(rawId) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) return null;
  const products = organizationProductRepository.listForOrganization(ref.localId);
  return products.length ? products[0].product_id : null;
}

async function getSubscription(rawId, productId) {
  const subscriptionService = require('./subscriptionService');
  const pid = productId || primaryProductId(rawId);
  return subscriptionService.getSubscription(rawId, pid);
}
async function getUsage(rawId) {
  const subscriptionService = require('./subscriptionService');
  return subscriptionService.getUsage(rawId);
}
function getBilling(rawId) {
  const billingService = require('./billingService');
  return billingService.getOrganizationBilling(rawId);
}
async function getLicenseHistory(rawId) {
  const licenseService = require('./licenseService');
  return licenseService.getLicenseHistory(rawId);
}
async function getRenewalHistory(rawId) {
  const history = await getLicenseHistory(rawId);
  return history.filter((h) => h.eventType === 'RENEWED');
}

async function sendEmail(rawId, type, extra, actor) {
  const ref = orgRef.resolve(rawId);
  if (ref.isAdapter) {
    const result = await ref.adapter.sendEmail(ref.sourceId, type, extra);
    auditService.record({ platformUserId: actor.userId, action: 'EMAIL_SENT', detail: `${type} to ${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    return { ok: true, ...result };
  }
  const org = organizationRepository.findById(ref.localId);
  if (!org) throw new NotFoundError('Organization not found');
  if (!org.email) throw new ValidationError('This organization has no email on file');
  const platformMailerService = require('./platformMailerService');
  const templates = {
    welcome: { subject: `Welcome to ZMAX, ${org.business_name}!`, html: `<p>Hi ${org.owner_name || ''},</p><p>Your organization <strong>${org.business_name}</strong> is now set up.</p>` },
    'renewal-reminder': { subject: 'Your subscription is expiring soon', html: `<p>Hi ${org.owner_name || ''},</p><p>Please contact us to renew.</p>` },
    'resend-verification': { subject: 'Verify your ZMAX account', html: `<p>Please contact support to complete verification for ${org.business_name}.</p>` },
    custom: { subject: extra.subject || '(no subject)', html: `<p>${extra.body || ''}</p>` },
  };
  const t = templates[type] || templates.custom;
  const result = await platformMailerService.send({ to: org.email, subject: t.subject, html: t.html });
  const platformNotificationRepository = require('../repositories/platformNotificationRepository');
  platformNotificationRepository.create({ organizationId: ref.localId, type, channel: 'email', recipient: org.email, subject: t.subject, body: t.html, status: result.delivered ? 'sent' : 'logged_only' });
  auditService.record({ platformUserId: actor.userId, organizationId: ref.localId, action: 'EMAIL_SENT', detail: `${type} to ${org.email}`, ip: actor.ip });
  return { ok: true, ...result };
}

function mapOrg(o) {
  return {
    id: o.id, businessName: o.business_name, ownerName: o.owner_name, email: o.email, phone: o.phone,
    address: o.address, gstNumber: o.gst_number, status: o.status, createdAt: o.created_at,
  };
}
function mapLicense(l) {
  return {
    id: l.id, productId: l.product_id, productName: l.product_name, productSlug: l.product_slug,
    planCode: l.plan_code, status: l.status, startsAt: l.starts_at, expiresAt: l.expires_at,
    gracePeriodDays: l.grace_period_days,
    daysRemaining: l.expires_at ? Math.ceil((new Date(l.expires_at).getTime() - Date.now()) / 86400000) : null,
  };
}
function mapAudit(a) {
  return {
    id: a.id, timestamp: a.created_at, admin: a.admin_email || 'system', product: a.product_name,
    action: a.action, oldValue: a.old_value, newValue: a.new_value, detail: a.detail, ip: a.ip_address,
  };
}

module.exports = {
  createOrganization, listOrganizations, getOrganization, attachProduct, setStatus, approve, suspend,
  listDevices, revokeDevice, renameDevice, unlockAccount, forcePasswordReset, killSessions, getLoginHistory, getFailedLogins,
  sendEmail, mapOrg, mapLicense, mapAudit,
  listNotes, addNote, getRenewals, getSecurity, getActivityTimeline,
  getSubscription, getUsage, getBilling, getLicenseHistory, getRenewalHistory,
};
