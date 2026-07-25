/**
 * server/src/repositories/userRepository.js
 *
 * Persistence only (ADR-0005). Mirrors server/local.js's `users` table
 * queries exactly, with `role` resolved via a join to `roles` (role_id FK,
 * see migrations/001_identity_tenant_core.sql) instead of a free-text
 * column — the query *shapes* below intentionally match local.js's exact
 * WHERE-clause semantics, including the one asymmetry it has: the login
 * lookup filters on `is_active = 1`, but the add-staff duplicate-mobile
 * check does not (matching local.js:972-976 vs. local.js:1097 exactly).
 */
'use strict';

const { withConnection } = require('../database');

const BASE_SELECT = `
  SELECT u.id, u.tenant_id, u.username, u.display_name, u.mobile, u.email,
         u.password_hash, u.is_active, u.last_login, u.created_at,
         r.code AS role, t.shop_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
  JOIN tenants t ON t.id = u.tenant_id
`;

/**
 * Matches local.js's login query exactly: active users only, joined with
 * their tenant's shop_name.
 * @param {string} mobile
 * @returns {Promise<object|null>}
 */
async function findActiveByMobile(mobile) {
  return withConnection(async (conn) => {
    const rows = await conn.query(`${BASE_SELECT} WHERE u.mobile = ? AND u.is_active = 1`, [mobile]);
    return rows[0] || null;
  });
}

/**
 * Matches local.js's add-staff duplicate check exactly: NOT scoped to
 * is_active, deliberately (see file header).
 * @param {string} mobile
 * @returns {Promise<{id: number}|null>}
 */
async function findAnyByMobile(mobile) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT id FROM users WHERE mobile = ?', [mobile]);
    return rows[0] || null;
  });
}

/** @param {number} id @returns {Promise<object|null>} */
async function findById(id) {
  return withConnection(async (conn) => {
    const rows = await conn.query(`${BASE_SELECT} WHERE u.id = ?`, [id]);
    return rows[0] || null;
  });
}

/**
 * Matches local.js's GET /api/data/users projection exactly (id, username,
 * email, role, is_active, last_login, created_at — no password_hash,
 * no mobile).
 * @param {number} tenantId
 * @returns {Promise<object[]>}
 */
async function listByTenant(tenantId) {
  return withConnection(async (conn) => {
    return conn.query(
      `SELECT u.id, u.username, u.email, r.code AS role, u.is_active, u.last_login, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.tenant_id = ? ORDER BY u.created_at`,
      [tenantId]
    );
  });
}

/**
 * @param {{tenantId: number, mobile: string, displayName: string, passwordHash: string, roleId: number}} data
 * @returns {Promise<object>}
 */
async function create({ tenantId, mobile, displayName, passwordHash, roleId }) {
  return withConnection(async (conn) => {
    const result = await conn.query(
      'INSERT INTO users (tenant_id, username, display_name, mobile, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, mobile, displayName || mobile, mobile, passwordHash, roleId]
    );
    return findById(Number(result.insertId));
  });
}

/** @param {number} userId */
async function touchLastLogin(userId) {
  return withConnection(async (conn) => {
    await conn.query("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [userId]);
  });
}

/** @param {number} userId @param {string} passwordHash */
async function updatePasswordHash(userId, passwordHash) {
  return withConnection(async (conn) => {
    await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  });
}

/** @param {number} userId @param {boolean} active */
async function setActive(userId, active) {
  return withConnection(async (conn) => {
    await conn.query('UPDATE users SET is_active = ? WHERE id = ?', [active ? 1 : 0, userId]);
  });
}

/**
 * Matches local.js's last-active-owner guard query exactly (local.js:1359).
 * @param {number} tenantId
 * @returns {Promise<number>}
 */
async function countActiveOwners(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query(
      `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.tenant_id = ? AND r.code = 'owner' AND u.is_active = 1`,
      [tenantId]
    );
    return Number(rows[0].c);
  });
}

module.exports = {
  findActiveByMobile, findAnyByMobile, findById, listByTenant,
  create, touchLastLogin, updatePasswordHash, setActive, countActiveOwners,
};
