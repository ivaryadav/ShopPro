/**
 * platform/src/services/maintenanceService.js — Phase 5D: Platform
 * Maintenance & Business Continuity. Z-SUPERADMIN is the single source
 * of truth for maintenance policy; this service is the only place that
 * creates, edits, or resolves it. Products never decide policy — they
 * pull the effective, already-resolved state via getEffectiveForProduct()
 * (exposed at GET /maintenance/effective, API-key authenticated) and
 * enforce their own locally-cached copy (see ShopERP's maintenanceSync.js
 * + maintenanceGate for the consuming side of this contract).
 *
 * Resolution precedence: **emergency mode wins outright, regardless of
 * scope** (an emergency platform-wide lock overrides a scheduled,
 * non-emergency organization-level maintenance window); among windows of
 * the same emergency-ness, the most SPECIFIC scope wins — organization >
 * product > platform. This is intentionally re-derivable, not a single
 * opaque "winner" flag, because ShopERP's own maintenanceGate repeats
 * this exact algorithm client-side against its cached raw ingredients —
 * see maintenanceSync.js's resolution comment for why that's safer than
 * trusting one pre-computed verdict across a sync boundary.
 */
'use strict';

const windowRepository = require('../repositories/platformMaintenanceWindowRepository');
const historyRepository = require('../repositories/platformMaintenanceHistoryRepository');
const productRepository = require('../repositories/platformProductRepository');
const orgRef = require('./orgRef');
const auditService = require('./auditService');
const { ValidationError, NotFoundError } = require('../errors');

const SPECIFICITY = { organization: 0, product: 1, platform: 2 };

/** Normalizes an <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM") into SQLite's own comparable format ("YYYY-MM-DD HH:MM:SS") — treated as UTC throughout, exactly like every other timestamp in this system (datetime('now') is always UTC; there is no timezone-conversion layer anywhere in this codebase, and inventing one just for this feature would be its own large, undocumented assumption). */
function normalizeDatetime(s) {
  if (!s) return null;
  let v = String(s).trim().replace('T', ' ');
  if (v.length === 16) v += ':00'; // no seconds supplied
  return v;
}

function validate(fields) {
  if (!['platform', 'product', 'organization'].includes(fields.scopeType)) {
    throw new ValidationError('scopeType must be platform, product, or organization');
  }
  if (fields.scopeType === 'platform' && fields.scopeRef) {
    throw new ValidationError('scopeRef must be empty for platform scope');
  }
  if (fields.scopeType === 'product') {
    if (!fields.scopeRef) throw new ValidationError('scopeRef (product slug) is required for product scope');
    if (!productRepository.findBySlug(fields.scopeRef)) throw new ValidationError(`Unknown product slug: ${fields.scopeRef}`);
  }
  if (fields.scopeType === 'organization') {
    if (!fields.scopeRef) throw new ValidationError('scopeRef (organization id) is required for organization scope');
    const ref = orgRef.resolve(fields.scopeRef);
    if (!ref.isAdapter && !Number.isFinite(ref.localId)) throw new ValidationError(`Invalid organization scopeRef: ${fields.scopeRef}`);
  }
  if (fields.mode && !['scheduled', 'immediate', 'emergency'].includes(fields.mode)) {
    throw new ValidationError('mode must be scheduled, immediate, or emergency');
  }
  if (fields.accessLevel && !['read_only', 'locked'].includes(fields.accessLevel)) {
    throw new ValidationError('accessLevel must be read_only or locked');
  }
  if ((fields.mode || 'scheduled') === 'scheduled' && !fields.startsAt) {
    throw new ValidationError('startsAt is required for scheduled mode');
  }
  if (fields.startsAt && fields.endsAt && fields.endsAt <= fields.startsAt) {
    throw new ValidationError('endsAt must be after startsAt');
  }
}

function createPolicy(fields, actor) {
  validate(fields);
  const startsAt = normalizeDatetime(fields.startsAt);
  const endsAt = normalizeDatetime(fields.endsAt);
  const mode = fields.mode || 'scheduled';
  // immediate/emergency modes take effect the moment they're created — no
  // separate "publish" step needed; scheduled ones wait for the
  // Maintenance Publish Job to flip them to active at their start time.
  const initialStatus = mode === 'scheduled' ? 'scheduled' : 'active';
  const window = windowRepository.create({
    scopeType: fields.scopeType, scopeRef: fields.scopeRef || null, mode, accessLevel: fields.accessLevel || 'locked',
    status: initialStatus, message: fields.message || '', eta: fields.eta || '',
    startsAt, endsAt,
    allowlistUsers: fields.allowlistUsers, allowlistOrganizations: fields.allowlistOrganizations, allowlistIps: fields.allowlistIps,
    createdBy: actor.userId,
  });
  historyRepository.record({ windowId: window.id, action: 'CREATED', detail: describeScope(window), actor: actor.email || 'system' });
  if (initialStatus === 'active') historyRepository.record({ windowId: window.id, action: 'ACTIVATED', detail: `${mode} mode, effective immediately`, actor: actor.email || 'system' });
  auditService.record({ platformUserId: actor.userId, action: 'MAINTENANCE_CREATED', detail: describeScope(window), ip: actor.ip });
  return mapWindow(window);
}

function editPolicy(id, fields, actor) {
  const existing = windowRepository.findById(id);
  if (!existing) throw new NotFoundError('Maintenance window not found');
  if (existing.status === 'cancelled' || existing.status === 'expired') {
    throw new ValidationError(`Cannot edit a ${existing.status} maintenance window — create a new one instead`);
  }
  // Merge onto the EXISTING window's full field set, not just scope — an
  // edit that only sends {message} would otherwise validate as if mode/
  // startsAt/accessLevel were all absent, incorrectly failing "startsAt is
  // required for scheduled mode" even though the existing window already
  // has one. Found by this phase's own test suite.
  const merged = {
    scopeType: existing.scope_type, scopeRef: existing.scope_ref, mode: existing.mode, accessLevel: existing.access_level,
    startsAt: existing.starts_at, endsAt: existing.ends_at, ...fields,
  };
  validate(merged);
  const updated = windowRepository.update(id, {
    ...fields,
    startsAt: fields.startsAt !== undefined ? normalizeDatetime(fields.startsAt) : undefined,
    endsAt: fields.endsAt !== undefined ? normalizeDatetime(fields.endsAt) : undefined,
  });
  historyRepository.record({ windowId: id, action: 'EDITED', detail: describeScope(updated), actor: actor.email || 'system' });
  auditService.record({ platformUserId: actor.userId, action: 'MAINTENANCE_EDITED', detail: describeScope(updated), ip: actor.ip });
  return mapWindow(updated);
}

function activate(id, actor) {
  const window = windowRepository.findById(id);
  if (!window) throw new NotFoundError('Maintenance window not found');
  const updated = windowRepository.setStatus(id, 'active');
  historyRepository.record({ windowId: id, action: 'ACTIVATED', detail: describeScope(updated), actor: actor.email || 'system' });
  auditService.record({ platformUserId: actor.userId, action: 'MAINTENANCE_ACTIVATED', detail: describeScope(updated), ip: actor.ip });
  return mapWindow(updated);
}
function deactivate(id, actor) {
  const window = windowRepository.findById(id);
  if (!window) throw new NotFoundError('Maintenance window not found');
  const updated = windowRepository.setStatus(id, 'expired');
  historyRepository.record({ windowId: id, action: 'DEACTIVATED', detail: describeScope(updated), actor: actor.email || 'system' });
  auditService.record({ platformUserId: actor.userId, action: 'MAINTENANCE_DEACTIVATED', detail: describeScope(updated), ip: actor.ip });
  return mapWindow(updated);
}
function cancel(id, actor) {
  const window = windowRepository.findById(id);
  if (!window) throw new NotFoundError('Maintenance window not found');
  if (window.status === 'active') throw new ValidationError('Cannot cancel an active window — deactivate it instead');
  const updated = windowRepository.setStatus(id, 'cancelled');
  historyRepository.record({ windowId: id, action: 'CANCELLED', detail: describeScope(updated), actor: actor.email || 'system' });
  auditService.record({ platformUserId: actor.userId, action: 'MAINTENANCE_CANCELLED', detail: describeScope(updated), ip: actor.ip });
  return mapWindow(updated);
}

function listPolicies({ status, scopeType } = {}) { return windowRepository.listAll({ status, scopeType }).map(mapWindow); }
function getPolicy(id) {
  const window = windowRepository.findById(id);
  if (!window) throw new NotFoundError('Maintenance window not found');
  return { ...mapWindow(window), history: historyRepository.listForWindow(id).map(mapHistory) };
}
function getHistory(limit) { return historyRepository.listRecent(limit).map((h) => ({ ...mapHistory(h), scopeType: h.scope_type, scopeRef: h.scope_ref })); }

function pickBySpecificity(windows) {
  if (!windows.length) return null;
  const emergencyOnes = windows.filter((w) => w.mode === 'emergency');
  const pool = emergencyOnes.length ? emergencyOnes : windows;
  pool.sort((a, b) => SPECIFICITY[a.scope_type] - SPECIFICITY[b.scope_type]);
  return pool[0];
}

/** Resolves the single effective policy (or null) for one specific (product, organization) pair — used by the operator-facing "what would this tenant see right now" check. */
function resolveEffective({ productSlug, organizationScopeRef }) {
  const active = windowRepository.listActiveForScopes({ productSlug, organizationScopeRef });
  const effective = pickBySpecificity(active);
  return effective ? mapWindow(effective) : null;
}

/**
 * The bulk payload a product's sync pull consumes — ShopERP's
 * maintenanceSync.js calls this shape (via GET /maintenance/effective)
 * once per poll and caches it whole, then resolves per-tenant itself
 * using the SAME pickBySpecificity precedence, locally, against whatever
 * it last successfully cached.
 */
function getEffectiveForProduct(productSlug) {
  if (!productRepository.findBySlug(productSlug)) throw new NotFoundError(`Unknown product slug: ${productSlug}`);
  const platformActive = pickBySpecificity(windowRepository.listActiveForScopes({}));
  const productActive = pickBySpecificity(windowRepository.listActiveForScopes({ productSlug }));
  const orgWindows = windowRepository.listActiveOrganizationScoped(productSlug);
  const organizations = {};
  for (const w of orgWindows) {
    const ref = orgRef.resolve(w.scope_ref);
    const tenantKey = ref.isAdapter ? ref.sourceId : w.scope_ref;
    organizations[tenantKey] = mapWindow(w);
  }
  const platformUpcoming = windowRepository.listUpcomingForScopes({})[0] || null;
  const productUpcoming = windowRepository.listUpcomingForScopes({ productSlug })[0] || null;
  return {
    platform: platformActive ? mapWindow(platformActive) : null,
    product: productActive ? mapWindow(productActive) : null,
    organizations,
    upcoming: {
      platform: platformUpcoming ? mapWindow(platformUpcoming) : null,
      product: productUpcoming ? mapWindow(productUpcoming) : null,
    },
    generatedAt: new Date().toISOString(),
  };
}

function describeScope(window) {
  if (window.scope_type === 'platform') return 'platform-wide';
  return `${window.scope_type}:${window.scope_ref}`;
}
function mapWindow(w) {
  return {
    id: w.id, scopeType: w.scope_type, scopeRef: w.scope_ref, mode: w.mode, accessLevel: w.access_level, status: w.status,
    message: w.message, eta: w.eta, startsAt: w.starts_at, endsAt: w.ends_at,
    allowlistUsers: JSON.parse(w.allowlist_users || '[]'), allowlistOrganizations: JSON.parse(w.allowlist_organizations || '[]'),
    allowlistIps: JSON.parse(w.allowlist_ips || '[]'), createdAt: w.created_at, updatedAt: w.updated_at,
  };
}
function mapHistory(h) { return { id: h.id, windowId: h.window_id, action: h.action, detail: h.detail, actor: h.actor, createdAt: h.created_at }; }

module.exports = {
  validate, createPolicy, editPolicy, activate, deactivate, cancel, listPolicies, getPolicy, getHistory,
  resolveEffective, getEffectiveForProduct,
};
