/**
 * server/src/repositories/permissionRepository.js
 *
 * Persistence only. See docs/adr/0006-table-driven-authorization.md.
 */
'use strict';

const { withConnection } = require('../database');

/**
 * All permission codes granted to a role, by role code — this is the one
 * query services/AuthorizationService.js actually depends on.
 * @param {string} roleCode
 * @returns {Promise<string[]>}
 */
async function findPermissionCodesForRole(roleCode) {
  return withConnection(async (conn) => {
    const rows = await conn.query(
      `SELECT p.code FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN roles r ON r.id = rp.role_id
       WHERE r.code = ?`,
      [roleCode]
    );
    return rows.map((r) => r.code);
  });
}

module.exports = { findPermissionCodesForRole };
