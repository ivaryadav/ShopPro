/**
 * server/src/repositories/sessionRepository.js
 *
 * Persistence only (ADR-0005). Mirrors server/sessions.js's SQL exactly —
 * that file is this repository's behavioral source of truth. All hashing,
 * token generation, and rotation *decisions* live in
 * services/sessionService.js; this file only reads/writes rows.
 */
'use strict';

const { withConnection } = require('../database');

/**
 * @param {{sessionId: string, tenantId: number, userId: number, jwtId: string,
 *   refreshTokenHash: string, ipAddress: string|null, browser: string, os: string}} data
 */
async function create(data) {
  return withConnection(async (conn) => {
    await conn.query(
      `INSERT INTO user_sessions
       (session_id, tenant_id, user_id, jwt_id, status, refresh_token_hash, ip_address, browser, os)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [data.sessionId, data.tenantId, data.userId, data.jwtId, data.refreshTokenHash, data.ipAddress, data.browser, data.os]
    );
  });
}

/** @param {string} sessionId @returns {Promise<{status: string}|null>} */
async function findStatusBySessionId(sessionId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT status FROM user_sessions WHERE session_id = ?', [sessionId]);
    return rows[0] || null;
  });
}

/** @param {string} sessionId */
async function touchActivity(sessionId) {
  return withConnection(async (conn) => {
    await conn.query('UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = ?', [sessionId]);
  });
}

/** @param {string} refreshTokenHash @returns {Promise<object|null>} */
async function findByRefreshTokenHash(refreshTokenHash) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT * FROM user_sessions WHERE refresh_token_hash = ?', [refreshTokenHash]);
    return rows[0] || null;
  });
}

/**
 * Grace-window lookup for a just-rotated-away token — matches
 * sessions.js's refreshSession() grace path exactly.
 * @param {string} refreshTokenHash
 * @param {Date} graceCutoff
 * @returns {Promise<object|null>}
 */
async function findByPrevRefreshTokenHash(refreshTokenHash, graceCutoff) {
  return withConnection(async (conn) => {
    const rows = await conn.query(
      `SELECT * FROM user_sessions WHERE prev_refresh_token_hash = ? AND refresh_rotated_at > ? AND status = 'active'`,
      [refreshTokenHash, graceCutoff]
    );
    return rows[0] || null;
  });
}

/** Grace-hit path: only the jwt_id changes, no token rotation. @param {string} sessionId @param {string} newJti */
async function updateJwtIdOnly(sessionId, newJti) {
  return withConnection(async (conn) => {
    await conn.query(
      "UPDATE user_sessions SET jwt_id = ?, last_activity = CURRENT_TIMESTAMP WHERE session_id = ?",
      [newJti, sessionId]
    );
  });
}

/** Full rotation path. @param {string} sessionId @param {string} newRefreshTokenHash @param {string} newJti */
async function rotateRefreshToken(sessionId, newRefreshTokenHash, newJti) {
  return withConnection(async (conn) => {
    await conn.query(
      `UPDATE user_sessions
       SET prev_refresh_token_hash = refresh_token_hash, refresh_rotated_at = CURRENT_TIMESTAMP,
           refresh_token_hash = ?, jwt_id = ?, last_activity = CURRENT_TIMESTAMP
       WHERE session_id = ?`,
      [newRefreshTokenHash, newJti, sessionId]
    );
  });
}

/** @param {string} sessionId @returns {Promise<boolean>} */
async function revoke(sessionId) {
  return withConnection(async (conn) => {
    const result = await conn.query("UPDATE user_sessions SET status = 'revoked' WHERE session_id = ?", [sessionId]);
    return Number(result.affectedRows) > 0;
  });
}

/** @param {number} tenantId @returns {Promise<number>} */
async function revokeAllForTenant(tenantId) {
  return withConnection(async (conn) => {
    const result = await conn.query("UPDATE user_sessions SET status = 'revoked' WHERE tenant_id = ? AND status = 'active'", [tenantId]);
    return Number(result.affectedRows);
  });
}

/** @param {string} sessionId @returns {Promise<{tenant_id: number}|null>} */
async function findTenantIdBySessionId(sessionId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT tenant_id FROM user_sessions WHERE session_id = ?', [sessionId]);
    return rows[0] || null;
  });
}

/** @param {string} sessionId @param {string|null} currentPage */
async function touchHeartbeat(sessionId, currentPage) {
  return withConnection(async (conn) => {
    await conn.query(
      "UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP, current_page = ? WHERE session_id = ? AND status = 'active'",
      [currentPage || null, sessionId]
    );
  });
}

/**
 * Matches sessions.js's listActiveSessions() exactly (fields + join + order).
 * @param {number} tenantId
 * @returns {Promise<object[]>}
 */
async function listActiveByTenant(tenantId) {
  return withConnection(async (conn) => {
    return conn.query(
      `SELECT s.session_id, s.user_id, u.display_name, u.mobile, s.login_time, s.last_activity,
              s.current_page, s.ip_address, s.browser, s.os
       FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.tenant_id = ? AND s.status = 'active' ORDER BY s.last_activity DESC`,
      [tenantId]
    );
  });
}

/**
 * @param {Date} idleCutoff
 * @param {Date} deleteCutoff
 * @returns {Promise<{expired: number, deleted: number}>}
 */
async function runCleanup(idleCutoff, deleteCutoff) {
  return withConnection(async (conn) => {
    const expiredResult = await conn.query(
      "UPDATE user_sessions SET status = 'expired' WHERE status = 'active' AND last_activity < ?",
      [idleCutoff]
    );
    const deletedResult = await conn.query(
      "DELETE FROM user_sessions WHERE status IN ('revoked','expired') AND last_activity < ?",
      [deleteCutoff]
    );
    return { expired: Number(expiredResult.affectedRows), deleted: Number(deletedResult.affectedRows) };
  });
}

module.exports = {
  create, findStatusBySessionId, touchActivity, findByRefreshTokenHash, findByPrevRefreshTokenHash,
  updateJwtIdOnly, rotateRefreshToken, revoke, revokeAllForTenant, findTenantIdBySessionId,
  touchHeartbeat, listActiveByTenant, runCleanup,
};
