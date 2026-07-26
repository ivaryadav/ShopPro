'use strict';

const { getDb } = require('../database/connection');

function findById(id) { return getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(id); }

function create({ businessName, ownerName, email, phone, address, gstNumber, status }) {
  const result = getDb().prepare(`
    INSERT INTO organizations (business_name, owner_name, email, phone, address, gst_number, status)
    VALUES (?,?,?,?,?,?,?)
  `).run(businessName, ownerName || '', email || '', phone || '', address || '', gstNumber || '', status || 'PENDING_APPROVAL');
  return findById(Number(result.lastInsertRowid));
}

function updateStatus(id, status) {
  getDb().prepare('UPDATE organizations SET status = ? WHERE id = ?').run(status, id);
}

const SORT_COLUMNS = { businessName: 'business_name', ownerName: 'owner_name', createdAt: 'created_at', status: 'status' };
function list({ q, status, productId, page, pageSize, sort, dir }) {
  const where = [];
  const params = [];
  const joins = [];
  if (productId) {
    joins.push('JOIN organization_products op ON op.organization_id = o.id AND op.product_id = ?');
    params.push(productId);
  }
  if (q) {
    where.push('(o.business_name LIKE ? OR o.owner_name LIKE ? OR o.email LIKE ? OR o.phone LIKE ? OR o.gst_number LIKE ?)');
    const like = '%' + String(q).replace(/[%_]/g, '\\$&') + '%';
    params.push(like, like, like, like, like);
  }
  if (status) { where.push('o.status = ?'); params.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const joinSql = joins.join(' ');
  const sortCol = SORT_COLUMNS[sort] || 'o.created_at';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) c FROM organizations o ${joinSql} ${whereSql}`).get(...params).c;
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`SELECT o.* FROM organizations o ${joinSql} ${whereSql} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  return { rows, total };
}

module.exports = { findById, create, updateStatus, list };
