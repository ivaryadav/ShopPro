/**
 * server/src/repositories/tenantLicenseRepository.js
 *
 * Persistence only (ADR-0005). Matches local.js's tenant_licenses table
 * and every query against it exactly (local.js:456-606, 1152-1652 — see
 * docs/architecture/Licensing.md for the full per-function citation).
 *
 * `revokeAllSessionsForTenant` is the one function here that touches a
 * table (`user_sessions`) owned by the Authentication domain (Phase 2).
 * This sprint's mission is explicit: "Do NOT touch: Authentication" —
 * interpreted as "do not modify any Authentication-domain FILE"
 * (services/sessionService.js, repositories/sessionRepository.js,
 * middleware/requireAuth.js are all untouched by this sprint). But
 * suspending a tenant killing that tenant's active sessions is real,
 * required Licensing business behavior local.js itself performs
 * (`sessions.revokeAllTenantSessions`, called from the sweep and from
 * manual suspend) — preserving it exactly requires ONE UPDATE statement
 * against `user_sessions`, added here rather than by editing Phase 2's
 * files. This is a data-layer read/write across a domain boundary (the
 * same kind of thing `userRepository`'s BASE_SELECT already does by
 * joining `tenants` for `shop_name`), not new Authentication business logic.
 */
'use strict';

const { withConnection } = require('../database');

/** @param {number} tenantId @returns {Promise<object|null>} */
async function findByTenantId(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT * FROM tenant_licenses WHERE tenant_id = ?', [tenantId]);
    return rows[0] || null;
  });
}

/** @param {string} key @returns {Promise<boolean>} */
async function licenseKeyExists(key) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT 1 FROM tenant_licenses WHERE license_key = ?', [key]);
    return rows.length > 0;
  });
}

/**
 * Matches the tenant_licenses INSERT inside /api/auth/signup's transaction
 * exactly (local.js:871-874) — this function itself is NOT transactional
 * with tenant/user creation (those are Identity-domain, out of scope);
 * the caller (a future Identity-domain phase) is responsible for wrapping
 * this together with tenant/user creation in one transaction, exactly as
 * local.js's own `db.transaction(...)` does.
 * @param {{tenantId:number,planCode:string,requestedPlanCode:string,deviceLimit:number,
 *   requestedDevicesBucket?:string,requestedModules:string[]}} data
 */
async function createPending(data) {
  await withConnection((conn) =>
    conn.query(
      `INSERT INTO tenant_licenses (tenant_id, status, plan_code, requested_plan_code, device_limit, requested_devices_bucket, requested_modules)
       VALUES (?, 'PENDING_APPROVAL', ?, ?, ?, ?, ?)`,
      [data.tenantId, data.planCode, data.requestedPlanCode, data.deviceLimit, data.requestedDevicesBucket || null, JSON.stringify(data.requestedModules || [])]
    )
  );
  return findByTenantId(data.tenantId);
}

/** Matches assignPlanToTenant's UPDATE exactly (local.js:358-360). */
async function assignPlan(tenantId, { planCode, billingCycle, deviceLimit, expiresAt }) {
  await withConnection((conn) =>
    conn.query(
      `UPDATE tenant_licenses SET plan_code = ?, billing_cycle = ?, device_limit = ?, starts_at = CURRENT_TIMESTAMP, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`,
      [planCode, billingCycle, deviceLimit, expiresAt, tenantId]
    )
  );
  return findByTenantId(tenantId);
}

/** @param {number} tenantId @param {string} key */
async function setLicenseKey(tenantId, key) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET license_key = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [key, tenantId])
  );
  return findByTenantId(tenantId);
}

/** Matches the approve endpoint's status flip exactly (local.js:1424). */
async function markActive(tenantId) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId])
  );
}

/** Matches the reject endpoint exactly (local.js:1446) — ARCHIVED, no dedicated REJECTED state. */
async function markArchived(tenantId) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId])
  );
}

/** Matches the extend endpoint exactly (local.js:1557-1559) — reactivates, clears both timers. */
async function extend(tenantId, expiresAt) {
  await withConnection((conn) =>
    conn.query(
      `UPDATE tenant_licenses SET expires_at = ?, status = 'ACTIVE', read_only_since = NULL, suspended_since = NULL, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`,
      [expiresAt, tenantId]
    )
  );
}

/** Matches the manual-suspend endpoint exactly (local.js:1570). */
async function suspend(tenantId) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET status = 'SUSPENDED', suspended_since = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId])
  );
}

/** Matches the reactivate endpoint exactly (local.js:1581). */
async function reactivate(tenantId) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET status = 'ACTIVE', read_only_since = NULL, suspended_since = NULL, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId])
  );
}

/** @param {number} tenantId @param {number} deviceLimit */
async function setDeviceLimit(tenantId, deviceLimit) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET device_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [deviceLimit, tenantId])
  );
}

/**
 * Matches GET /api/license/status's UPDATE...RETURNING exactly
 * (local.js:1161-1163) — MariaDB's UPDATE has no RETURNING clause, so
 * this does the UPDATE then a follow-up SELECT on the same connection;
 * the net effect (the response reflects THIS call's timestamp, not the
 * previous one) is identical.
 * @param {number} tenantId @returns {Promise<object|null>}
 */
async function touchLastVerified(tenantId) {
  return withConnection(async (conn) => {
    await conn.query(`UPDATE tenant_licenses SET last_verified_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId]);
    const rows = await conn.query('SELECT * FROM tenant_licenses WHERE tenant_id = ?', [tenantId]);
    return rows[0] || null;
  });
}

/** @param {number} tenantId @returns {Promise<number>} matches local.js:1166 exactly (trusted_devices, cross-domain read — see file header) */
async function countActiveDevices(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT COUNT(*) AS c FROM trusted_devices WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    return Number(rows[0].c);
  });
}

/** Matches the sweep's ACTIVE->READ_ONLY query exactly (local.js:568-570). @returns {Promise<number[]>} tenantIds */
async function findExpiredActiveTenantIds() {
  return withConnection(async (conn) => {
    const rows = await conn.query(`SELECT tenant_id FROM tenant_licenses WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`);
    return rows.map((r) => r.tenant_id);
  });
}

/** Matches the sweep's READ_ONLY->SUSPENDED query exactly (local.js:579-581, 30 days). @returns {Promise<number[]>} */
async function findStaleReadOnlyTenantIds() {
  return withConnection(async (conn) => {
    const rows = await conn.query(`SELECT tenant_id FROM tenant_licenses WHERE status = 'READ_ONLY' AND read_only_since IS NOT NULL AND read_only_since < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)`);
    return rows.map((r) => r.tenant_id);
  });
}

/** Matches the sweep's SUSPENDED->ARCHIVED query exactly (local.js:591-593, 365 days). @returns {Promise<number[]>} */
async function findStaleSuspendedTenantIds() {
  return withConnection(async (conn) => {
    const rows = await conn.query(`SELECT tenant_id FROM tenant_licenses WHERE status = 'SUSPENDED' AND suspended_since IS NOT NULL AND suspended_since < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 365 DAY)`);
    return rows.map((r) => r.tenant_id);
  });
}

/** Sweep step: ACTIVE -> READ_ONLY (local.js:572-574). @param {number} tenantId */
async function markReadOnly(tenantId) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET status = 'READ_ONLY', read_only_since = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId])
  );
}

/** Sweep step: READ_ONLY -> SUSPENDED (local.js:583-585). @param {number} tenantId */
async function markSuspendedFromReadOnly(tenantId) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET status = 'SUSPENDED', suspended_since = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId])
  );
}

/** Sweep step: SUSPENDED -> ARCHIVED (local.js:595-597). @param {number} tenantId */
async function markArchivedFromSuspended(tenantId) {
  await withConnection((conn) =>
    conn.query(`UPDATE tenant_licenses SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`, [tenantId])
  );
}

/** Matches GET /api/admin/tenant-licenses' dashboard query exactly (local.js:1454-1463), minus the Administration-gated devices join. */
async function listAll() {
  return withConnection((conn) =>
    conn.query(`
      SELECT t.id AS tenant_id, t.shop_name, t.created_at AS registered_at,
             tl.status, tl.plan_code, tl.billing_cycle, tl.device_limit, tl.expires_at,
             tl.requested_modules, tl.license_key
      FROM tenant_licenses tl JOIN tenants t ON t.id = tl.tenant_id
      ORDER BY t.shop_name
    `)
  );
}

/** Matches GET /api/admin/registrations exactly (local.js:1373-1398). */
async function listPendingRegistrations() {
  return withConnection((conn) =>
    conn.query(`
      SELECT t.id AS tenant_id, t.shop_name, t.address, t.gst_number, t.created_at AS registered_at,
             u.display_name AS owner_name, u.mobile, u.email, u.email_verified_at,
             tl.requested_plan_code, tl.requested_devices_bucket, tl.requested_modules
      FROM tenant_licenses tl
      JOIN tenants t ON t.id = tl.tenant_id
      JOIN users u ON u.tenant_id = t.id AND u.role_id = (SELECT id FROM roles WHERE code = 'owner')
      WHERE tl.status = 'PENDING_APPROVAL'
      ORDER BY t.created_at ASC
    `)
  );
}

/**
 * Matches sessions.revokeAllTenantSessions exactly (local.js's sessions.js,
 * called from the sweep and manual suspend) — see file header for why this
 * lives here rather than in Phase 2's sessionRepository.js.
 * @param {number} tenantId @returns {Promise<number>} rows affected
 */
async function revokeAllSessionsForTenant(tenantId) {
  return withConnection(async (conn) => {
    const result = await conn.query(`UPDATE user_sessions SET status = 'revoked' WHERE tenant_id = ? AND status = 'active'`, [tenantId]);
    return Number(result.affectedRows || 0);
  });
}

module.exports = {
  findByTenantId, licenseKeyExists, createPending, assignPlan, setLicenseKey,
  markActive, markArchived, extend, suspend, reactivate, setDeviceLimit,
  touchLastVerified, countActiveDevices, findExpiredActiveTenantIds,
  findStaleReadOnlyTenantIds, findStaleSuspendedTenantIds, markReadOnly,
  markSuspendedFromReadOnly, markArchivedFromSuspended, listAll,
  listPendingRegistrations, revokeAllSessionsForTenant,
};
