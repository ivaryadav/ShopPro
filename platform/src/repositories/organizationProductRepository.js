'use strict';

const { getDb } = require('../database/connection');

function listForOrganization(organizationId) {
  return getDb().prepare(`
    SELECT op.*, p.name AS product_name, p.slug AS product_slug, p.status AS product_status
    FROM organization_products op JOIN platform_products p ON p.id = op.product_id
    WHERE op.organization_id = ?
  `).all(organizationId);
}
function find(organizationId, productId) {
  return getDb().prepare('SELECT * FROM organization_products WHERE organization_id = ? AND product_id = ?').get(organizationId, productId);
}
function attach(organizationId, productId) {
  getDb().prepare('INSERT OR IGNORE INTO organization_products (organization_id, product_id) VALUES (?,?)').run(organizationId, productId);
  return find(organizationId, productId);
}
function setStatus(organizationId, productId, status) {
  getDb().prepare('UPDATE organization_products SET status = ? WHERE organization_id = ? AND product_id = ?').run(status, organizationId, productId);
}

module.exports = { listForOrganization, find, attach, setStatus };
