'use strict';

const { getDb } = require('../database/connection');

function create({ organizationId, productId, type, channel, recipient, subject, body, status }) {
  getDb().prepare(`
    INSERT INTO platform_notifications (organization_id, product_id, type, channel, recipient, subject, body, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(organizationId, productId || null, type, channel || 'email', recipient || '', subject || '', body || '', status || 'sent');
}
function listForOrganization(organizationId) {
  return getDb().prepare('SELECT * FROM platform_notifications WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100').all(organizationId);
}

module.exports = { create, listForOrganization };
