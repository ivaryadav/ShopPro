/**
 * server/src/repositories/trustedDeviceRepository.js
 *
 * Persistence only (ADR-0005). Mirrors server/local.js's inline
 * trusted_devices queries inside POST /api/auth/login exactly.
 *
 * Scope note: local.js's admin device-management actions (remove a device,
 * reset all devices, change a tenant's device limit —
 * /api/admin/tenant-licenses/:tenantId/devices/*) are Licensing-domain
 * admin routes, out of scope for Phase 2 (docs/database/MigrationNotes.md).
 * Only the login-time auto-trust/enforce behavior is implemented here.
 */
'use strict';

const { withConnection } = require('../database');

/**
 * @param {number} tenantId @param {number} userId @param {string} deviceId
 * @returns {Promise<{id: number}|null>}
 */
async function findActive(tenantId, userId, deviceId) {
  return withConnection(async (conn) => {
    const rows = await conn.query(
      'SELECT id FROM trusted_devices WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND is_active = 1',
      [tenantId, userId, deviceId]
    );
    return rows[0] || null;
  });
}

/** @param {number} deviceRowId @param {string} browser @param {string} os */
async function touchLogin(deviceRowId, browser, os) {
  return withConnection(async (conn) => {
    await conn.query(
      'UPDATE trusted_devices SET last_login_at = CURRENT_TIMESTAMP, browser = ?, os = ? WHERE id = ?',
      [browser, os, deviceRowId]
    );
  });
}

/** @param {number} tenantId @returns {Promise<number>} */
async function countActiveForTenant(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT COUNT(*) AS c FROM trusted_devices WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    return Number(rows[0].c);
  });
}

/**
 * Matches local.js's insert-and-swallow-unique-violation race handling
 * exactly (local.js:1009-1016): two near-simultaneous first logins from the
 * same brand-new device are harmless, the row exists either way.
 * @param {number} tenantId @param {number} userId @param {string} deviceId @param {string} browser @param {string} os
 */
async function createIgnoringRace(tenantId, userId, deviceId, browser, os) {
  return withConnection(async (conn) => {
    try {
      await conn.query(
        'INSERT INTO trusted_devices (tenant_id, user_id, device_id, browser, os) VALUES (?, ?, ?, ?, ?)',
        [tenantId, userId, deviceId, browser, os]
      );
    } catch (e) {
      if (!/duplicate/i.test(e.message)) throw e;
    }
  });
}

module.exports = { findActive, touchLogin, countActiveForTenant, createIgnoringRace };
