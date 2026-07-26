'use strict';

const { getDb } = require('../database/connection');

function create({ platformUserId, organizationId, productId, action, oldValue, newValue, detail, ip, device }) {
  getDb().prepare(`
    INSERT INTO platform_audit_logs (platform_user_id, organization_id, product_id, action, old_value, new_value, detail, ip_address, device)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(platformUserId, organizationId, productId, action, oldValue, newValue, detail, ip, device);
}

function list({ organizationId, productId, action, page, pageSize }) {
  const where = [];
  const params = [];
  if (organizationId) { where.push('a.organization_id = ?'); params.push(organizationId); }
  if (productId) { where.push('a.product_id = ?'); params.push(productId); }
  if (action) { where.push('a.action = ?'); params.push(action); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) c FROM platform_audit_logs a ${whereSql}`).get(...params).c;
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`
    SELECT a.*, u.email AS admin_email, o.business_name AS org_name, p.name AS product_name
    FROM platform_audit_logs a
    LEFT JOIN platform_users u ON u.id = a.platform_user_id
    LEFT JOIN organizations o ON o.id = a.organization_id
    LEFT JOIN platform_products p ON p.id = a.product_id
    ${whereSql}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);
  return { rows, total };
}

module.exports = { create, list };
