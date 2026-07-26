'use strict';

const { getDb } = require('../database/connection');

function record({ organizationId, productId, eventType, fromValue, toValue, detail, actor }) {
  getDb().prepare(`
    INSERT INTO platform_license_history (organization_id, product_id, event_type, from_value, to_value, detail, actor)
    VALUES (?,?,?,?,?,?,?)
  `).run(String(organizationId), productId || null, eventType, fromValue != null ? String(fromValue) : null, toValue != null ? String(toValue) : null, detail || '', actor || 'system');
}

// created_at has only 1-second resolution — id DESC as a tiebreaker keeps
// same-second events (e.g. RENEWED immediately followed by a status flip
// back to ACTIVE) in real insertion order, same reasoning already applied
// to platform_maintenance_history.
function listForOrganization(organizationId, limit) {
  return getDb().prepare(`
    SELECT h.*, p.name AS product_name, p.slug AS product_slug
    FROM platform_license_history h LEFT JOIN platform_products p ON p.id = h.product_id
    WHERE h.organization_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT ?
  `).all(String(organizationId), limit || 100);
}

function listRecent(limit) {
  return getDb().prepare(`
    SELECT h.*, p.name AS product_name FROM platform_license_history h LEFT JOIN platform_products p ON p.id = h.product_id
    ORDER BY h.created_at DESC, h.id DESC LIMIT ?
  `).all(limit || 50);
}

/** Renewal Success Rate (Reports): RENEWED events vs EXPIRED/CANCELLED events over the window. */
function countByEventType(sinceDays) {
  return getDb().prepare(`
    SELECT event_type, COUNT(*) count FROM platform_license_history
    WHERE created_at >= datetime('now', ?) GROUP BY event_type
  `).all(`-${sinceDays || 90} days`);
}

module.exports = { record, listForOrganization, listRecent, countByEventType };
