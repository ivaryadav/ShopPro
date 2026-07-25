/**
 * server/src/repositories/adminDirectoryRepository.js
 *
 * Persistence only (ADR-0005). Cross-tenant admin-console queries that
 * don't belong in any single tenant-scoped repository (tenantRepository/
 * userRepository/trustedDeviceRepository all deliberately scope every
 * query to one tenant, per ADR's tenant-isolation posture) — matches
 * local.js's admin-console queries exactly (local.js:1297-1330,
 * 1613-1652). Deliberately a NEW file rather than adding cross-tenant
 * methods to Phase 2's tenantRepository.js/userRepository.js/
 * trustedDeviceRepository.js, per this sprint's "Do NOT touch:
 * Authentication" instruction, honored at the file level.
 */
'use strict';

const { withConnection } = require('../database');

/**
 * Matches /api/admin/tenant/status's shop-name lookup exactly
 * (local.js:1263, case-insensitive).
 * @param {string} shopName @returns {Promise<object|null>}
 */
async function findTenantByShopName(shopName) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT id, shop_name FROM tenants WHERE LOWER(shop_name) = LOWER(?)', [shopName]);
    return rows[0] || null;
  });
}

/** Matches GET /api/admin/tenants exactly (local.js:1297-1301). @returns {Promise<object[]>} */
async function listAllTenants() {
  return withConnection((conn) =>
    conn.query('SELECT id, shop_name, status, suspend_reason, created_at FROM tenants ORDER BY created_at DESC')
  );
}

/**
 * Matches GET /api/admin/web-users exactly (local.js:1305-1330), minus
 * `t.license_plan` (Licensing-domain column living on `tenants` in
 * local.js, deliberately excluded from server/src/'s tenants table —
 * migrations/001, out of scope for this sprint to add).
 * @returns {Promise<object[]>} flat rows; grouping by shop is the service's job
 */
async function listAllUsersWithTenant() {
  return withConnection((conn) =>
    conn.query(`
      SELECT u.id, u.display_name, u.mobile, r.code AS role, u.is_active, u.last_login, u.created_at,
             t.id AS tenant_id, t.shop_name, t.status AS shop_status
      FROM users u
      JOIN roles r ON r.id = u.role_id
      JOIN tenants t ON t.id = u.tenant_id
      ORDER BY t.shop_name, r.code DESC, u.created_at
    `)
  );
}

/** Matches GET /api/admin/tenant-licenses/:tenantId/devices exactly (local.js:1613-1621). @param {number} tenantId */
async function listDevicesForTenant(tenantId) {
  return withConnection((conn) =>
    conn.query(`
      SELECT d.id, d.device_id, d.device_name, d.browser, d.os, d.first_login_at, d.last_login_at, d.is_active,
             u.display_name, u.mobile
      FROM trusted_devices d JOIN users u ON u.id = d.user_id
      WHERE d.tenant_id = ? ORDER BY d.last_login_at DESC
    `, [tenantId])
  );
}

/** @param {number} tenantId @param {number} rowId @returns {Promise<boolean>} true if the row existed and belonged to this tenant */
async function findDeviceRow(tenantId, rowId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT id FROM trusted_devices WHERE id = ? AND tenant_id = ?', [rowId, tenantId]);
    return !!rows[0];
  });
}

/** Matches the devices/:rowId/remove endpoint exactly (local.js:1630) — soft-remove only, audit trail preserved. @param {number} rowId */
async function deactivateDevice(rowId) {
  await withConnection((conn) => conn.query('UPDATE trusted_devices SET is_active = 0 WHERE id = ?', [rowId]));
}

/** Matches devices/reset-all exactly (local.js:1638). @param {number} tenantId @returns {Promise<number>} rows changed */
async function deactivateAllDevices(tenantId) {
  return withConnection(async (conn) => {
    const result = await conn.query('UPDATE trusted_devices SET is_active = 0 WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    return Number(result.affectedRows || 0);
  });
}

module.exports = {
  findTenantByShopName, listAllTenants, listAllUsersWithTenant,
  listDevicesForTenant, findDeviceRow, deactivateDevice, deactivateAllDevices,
};
