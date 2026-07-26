'use strict';

const { getDb } = require('../database/connection');

function listForOrganization(organizationId) {
  return getDb().prepare(`
    SELECT u.*, p.name AS product_name FROM organization_users u JOIN platform_products p ON p.id = u.product_id
    WHERE u.organization_id = ? ORDER BY u.created_at
  `).all(organizationId);
}
function countOnlineToday() {
  return getDb().prepare("SELECT COUNT(DISTINCT organization_id) c FROM organization_users WHERE last_login >= datetime('now','start of day')").get().c;
}

module.exports = { listForOrganization, countOnlineToday };
