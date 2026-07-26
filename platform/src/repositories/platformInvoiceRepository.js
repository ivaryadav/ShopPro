'use strict';

const { getDb } = require('../database/connection');

function findById(id) { return getDb().prepare('SELECT * FROM platform_invoices WHERE id = ?').get(id); }
function findByNumber(invoiceNumber) { return getDb().prepare('SELECT * FROM platform_invoices WHERE invoice_number = ?').get(invoiceNumber); }

function listForOrganization(organizationId) {
  return getDb().prepare('SELECT * FROM platform_invoices WHERE organization_id = ? ORDER BY created_at DESC, id DESC').all(String(organizationId));
}

function listAll({ status, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = getDb().prepare(`SELECT COUNT(*) c FROM platform_invoices ${whereSql}`).get(...params).c;
  const rows = getDb().prepare(`SELECT * FROM platform_invoices ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { rows, total };
}

function listRecent(limit) {
  return getDb().prepare('SELECT * FROM platform_invoices ORDER BY created_at DESC, id DESC LIMIT ?').all(limit || 10);
}

function create({ organizationId, productId, invoiceNumber, description, amount, currency, status, dueAt, createdBy }) {
  const result = getDb().prepare(`
    INSERT INTO platform_invoices (organization_id, product_id, invoice_number, description, amount, currency, status, due_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(String(organizationId), productId || null, invoiceNumber, description || '', amount, currency || 'INR', status || 'draft', dueAt || null, createdBy || null);
  return findById(Number(result.lastInsertRowid));
}

function updateStatus(id, status, paidAt) {
  getDb().prepare("UPDATE platform_invoices SET status = ?, paid_at = ?, updated_at = datetime('now') WHERE id = ?").run(status, paidAt || null, id);
  return findById(id);
}

/** Revenue/Outstanding aggregates for the Billing Dashboard — computed live, never cached. */
function sums() {
  const db = getDb();
  return {
    totalInvoiced: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM platform_invoices WHERE status != 'void'").get().s,
    paid: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM platform_invoices WHERE status = 'paid'").get().s,
    overdue: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM platform_invoices WHERE status IN ('draft','sent') AND due_at IS NOT NULL AND due_at < datetime('now')").get().s,
  };
}

function monthlyRevenue() {
  return getDb().prepare(`
    SELECT strftime('%Y-%m', paid_at) month, COALESCE(SUM(amount),0) total
    FROM platform_invoices WHERE status = 'paid' AND paid_at IS NOT NULL
    GROUP BY month ORDER BY month
  `).all();
}

module.exports = { findById, findByNumber, listForOrganization, listAll, listRecent, create, updateStatus, sums, monthlyRevenue };
