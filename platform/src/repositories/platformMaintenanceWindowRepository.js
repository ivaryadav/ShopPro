'use strict';

const { getDb } = require('../database/connection');

function create({ scopeType, scopeRef, mode, accessLevel, status, message, eta, startsAt, endsAt, allowlistUsers, allowlistOrganizations, allowlistIps, createdBy }) {
  const result = getDb().prepare(`
    INSERT INTO platform_maintenance_windows
      (scope_type, scope_ref, mode, access_level, status, message, eta, starts_at, ends_at, allowlist_users, allowlist_organizations, allowlist_ips, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scopeType, scopeRef || null, mode || 'scheduled', accessLevel || 'locked', status || 'scheduled',
    message || '', eta || '', startsAt || null, endsAt || null,
    JSON.stringify(allowlistUsers || []), JSON.stringify(allowlistOrganizations || []), JSON.stringify(allowlistIps || []),
    createdBy || null,
  );
  return findById(Number(result.lastInsertRowid));
}
function findById(id) { return getDb().prepare('SELECT * FROM platform_maintenance_windows WHERE id = ?').get(id); }
function update(id, fields) {
  const sets = [];
  const params = [];
  const map = {
    mode: 'mode', accessLevel: 'access_level', message: 'message', eta: 'eta', startsAt: 'starts_at', endsAt: 'ends_at',
  };
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(fields[key]); }
  }
  if (fields.allowlistUsers !== undefined) { sets.push('allowlist_users = ?'); params.push(JSON.stringify(fields.allowlistUsers)); }
  if (fields.allowlistOrganizations !== undefined) { sets.push('allowlist_organizations = ?'); params.push(JSON.stringify(fields.allowlistOrganizations)); }
  if (fields.allowlistIps !== undefined) { sets.push('allowlist_ips = ?'); params.push(JSON.stringify(fields.allowlistIps)); }
  if (!sets.length) return findById(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE platform_maintenance_windows SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findById(id);
}
function setStatus(id, status) {
  getDb().prepare("UPDATE platform_maintenance_windows SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  return findById(id);
}
function listAll({ status, scopeType } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (scopeType) { where.push('scope_type = ?'); params.push(scopeType); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return getDb().prepare(`SELECT * FROM platform_maintenance_windows ${whereSql} ORDER BY created_at DESC`).all(...params);
}
/**
 * Every ACTIVE window that could possibly apply to this (product,
 * organization) pair — scope-type-aware (not a blanket scope_ref IN (...))
 * so a product slug and a synthetic organization ref can never collide
 * across scopes even in theory. resolveEffective() narrows this pool by
 * specificity/emergency.
 */
function listActiveForScopes({ productSlug, organizationScopeRef }) {
  const conditions = ["(status='active' AND scope_type='platform')"];
  const params = [];
  if (productSlug) { conditions.push("(status='active' AND scope_type='product' AND scope_ref=?)"); params.push(productSlug); }
  if (organizationScopeRef) { conditions.push("(status='active' AND scope_type='organization' AND scope_ref=?)"); params.push(organizationScopeRef); }
  return getDb().prepare(`SELECT * FROM platform_maintenance_windows WHERE ${conditions.join(' OR ')}`).all(...params);
}
function listUpcomingForScopes({ productSlug, organizationScopeRef }) {
  const conditions = ["(status='scheduled' AND scope_type='platform')"];
  const params = [];
  if (productSlug) { conditions.push("(status='scheduled' AND scope_type='product' AND scope_ref=?)"); params.push(productSlug); }
  if (organizationScopeRef) { conditions.push("(status='scheduled' AND scope_type='organization' AND scope_ref=?)"); params.push(organizationScopeRef); }
  return getDb().prepare(`SELECT * FROM platform_maintenance_windows WHERE ${conditions.join(' OR ')} ORDER BY starts_at ASC`).all(...params);
}
/** Every organization-scoped window (any product) — used to build the bulk /effective payload without needing to know every tenant ID in advance. */
function listActiveOrganizationScoped(productSlugPrefix) {
  return getDb().prepare("SELECT * FROM platform_maintenance_windows WHERE status='active' AND scope_type='organization' AND scope_ref LIKE ?").all(`${productSlugPrefix}:%`);
}
/** Scheduled windows whose start time has arrived — the Maintenance Publish Job's candidate pool. */
function listScheduledDue() {
  return getDb().prepare("SELECT * FROM platform_maintenance_windows WHERE status = 'scheduled' AND mode != 'immediate' AND starts_at IS NOT NULL AND starts_at <= datetime('now')").all();
}
/** Active windows whose end time has passed — the Maintenance Expiry Job's candidate pool. */
function listActiveExpired() {
  return getDb().prepare("SELECT * FROM platform_maintenance_windows WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= datetime('now')").all();
}

module.exports = {
  create, findById, update, setStatus, listAll, listActiveForScopes, listUpcomingForScopes,
  listActiveOrganizationScoped, listScheduledDue, listActiveExpired,
};
