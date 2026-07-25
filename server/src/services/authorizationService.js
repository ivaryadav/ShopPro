/**
 * server/src/services/authorizationService.js
 *
 * Table-driven authorization — see docs/adr/0006-table-driven-authorization.md
 * for why this exists and why it reproduces, not changes, today's 4
 * hardcoded `role !== 'owner'` gates.
 */
'use strict';

const permissionRepository = require('../repositories/permissionRepository');

/**
 * @param {string} roleCode
 * @param {string} permissionCode
 * @returns {Promise<boolean>}
 */
async function hasPermission(roleCode, permissionCode) {
  const codes = await permissionRepository.findPermissionCodesForRole(roleCode);
  return codes.includes(permissionCode);
}

module.exports = { hasPermission };
