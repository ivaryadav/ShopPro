'use strict';

const { getDb } = require('../database/connection');

// INSERT-only repository — no update()/setStatus() exists here on purpose;
// see schema.js's platform_events comment for what "immutable" means here.
function create({ eventType, organizationId, productId, payload }) {
  const result = getDb().prepare(`
    INSERT INTO platform_events (event_type, organization_id, product_id, payload) VALUES (?,?,?,?)
  `).run(eventType, organizationId != null ? String(organizationId) : null, productId || null, JSON.stringify(payload || {}));
  return findById(Number(result.lastInsertRowid));
}
function findById(id) { return getDb().prepare('SELECT * FROM platform_events WHERE id = ?').get(id); }

function search({ eventType, organizationId, productId, dateFrom, dateTo, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = [];
  if (eventType) { where.push('event_type = ?'); params.push(eventType); }
  if (organizationId) { where.push('organization_id = ?'); params.push(String(organizationId)); }
  if (productId) { where.push('product_id = ?'); params.push(Number(productId)); }
  if (dateFrom) { where.push('created_at >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('created_at <= ?'); params.push(dateTo); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = getDb().prepare(`SELECT COUNT(*) c FROM platform_events ${whereSql}`).get(...params).c;
  const rows = getDb().prepare(`SELECT * FROM platform_events ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { rows, total };
}

function listRecent(limit) { return getDb().prepare('SELECT * FROM platform_events ORDER BY created_at DESC, id DESC LIMIT ?').all(limit || 20); }
function countSince(sinceExpr) { return getDb().prepare(`SELECT COUNT(*) c FROM platform_events WHERE created_at >= datetime('now', ?)`).get(sinceExpr).c; }
function countTotal() { return getDb().prepare('SELECT COUNT(*) c FROM platform_events').get().c; }

/** Event Retention Job — bulk delete of rows past the retention window. This is data lifecycle management, not a mutation of a live event; see schema.js's header comment. */
function deleteOlderThan(days) {
  return getDb().prepare(`DELETE FROM platform_events WHERE created_at < datetime('now', ?)`).run(`-${days} days`).changes;
}

module.exports = { create, findById, search, listRecent, countSince, countTotal, deleteOlderThan };
