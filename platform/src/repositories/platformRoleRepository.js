'use strict';

const { getDb } = require('../database/connection');

function findByCode(code) {
  return getDb().prepare('SELECT * FROM platform_roles WHERE code = ?').get(code);
}
function listAll() {
  return getDb().prepare('SELECT * FROM platform_roles ORDER BY id').all();
}
function permissionsForRole(roleId) {
  return getDb().prepare(`
    SELECT p.code FROM platform_role_permissions rp
    JOIN platform_permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ?
  `).all(roleId).map((r) => r.code);
}

module.exports = { findByCode, listAll, permissionsForRole };
