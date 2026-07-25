/**
 * server/src/repositories/tenantRepository.js
 *
 * Persistence only — no business rules here (ADR-0005). Matches
 * server/local.js's `tenants` table exactly, scoped to the columns Phase 2
 * owns (status/suspend_reason) — see migrations/001_identity_tenant_core.sql
 * for what was deliberately left out (license_key_hash/license_expiry/
 * license_plan — Licensing domain, out of scope).
 */
'use strict';

const { withConnection } = require('../database');
const { DatabaseError } = require('../errors');

/**
 * @param {string} shopName
 * @returns {Promise<{id: number, shop_name: string, status: string, suspend_reason: string, is_active: number, created_at: Date}>}
 */
async function create(shopName) {
  return withConnection(async (conn) => {
    const result = await conn.query('INSERT INTO tenants (shop_name) VALUES (?)', [shopName]);
    return findById(Number(result.insertId));
  });
}

/**
 * @param {number} tenantId
 * @returns {Promise<object|null>}
 */
async function findById(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    return rows[0] || null;
  });
}

/**
 * Matches local.js's requireActive() read exactly: status + suspend_reason.
 * @param {number} tenantId
 * @returns {Promise<{status: string, suspend_reason: string}|null>}
 */
async function findStatusById(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT status, suspend_reason FROM tenants WHERE id = ?', [tenantId]);
    return rows[0] || null;
  });
}

/**
 * @param {number} tenantId
 * @param {'active'|'paused'|'terminated'} status
 * @param {string} [reason]
 */
async function updateStatus(tenantId, status, reason) {
  if (!['active', 'paused', 'terminated'].includes(status)) {
    throw new DatabaseError(`Invalid tenant status '${status}'`);
  }
  return withConnection(async (conn) => {
    await conn.query('UPDATE tenants SET status = ?, suspend_reason = ? WHERE id = ?', [status, reason || '', tenantId]);
  });
}

module.exports = { create, findById, findStatusById, updateStatus };
