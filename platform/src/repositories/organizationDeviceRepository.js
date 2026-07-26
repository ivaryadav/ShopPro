'use strict';

const { getDb } = require('../database/connection');

function listForOrganization(organizationId) {
  return getDb().prepare(`
    SELECT d.*, p.name AS product_name FROM organization_devices d JOIN platform_products p ON p.id = d.product_id
    WHERE d.organization_id = ? ORDER BY d.last_seen DESC
  `).all(organizationId);
}
function findById(id, organizationId) {
  return getDb().prepare('SELECT * FROM organization_devices WHERE id = ? AND organization_id = ?').get(id, organizationId);
}
function revoke(id, organizationId) {
  return getDb().prepare('UPDATE organization_devices SET is_active = 0 WHERE id = ? AND organization_id = ?').run(id, organizationId).changes > 0;
}
function count(organizationId) {
  return getDb().prepare('SELECT COUNT(*) c FROM organization_devices WHERE organization_id = ? AND is_active = 1').get(organizationId).c;
}
function totalActive() {
  return getDb().prepare('SELECT COUNT(*) c FROM organization_devices WHERE is_active = 1').get().c;
}

module.exports = { listForOrganization, findById, revoke, count, totalActive };
