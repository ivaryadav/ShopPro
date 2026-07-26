'use strict';

const { getDb } = require('../database/connection');

function findById(id) { return getDb().prepare('SELECT * FROM platform_payments WHERE id = ?').get(id); }
function listForOrganization(organizationId) {
  return getDb().prepare('SELECT * FROM platform_payments WHERE organization_id = ? ORDER BY created_at DESC, id DESC').all(String(organizationId));
}
function listForInvoice(invoiceId) {
  return getDb().prepare('SELECT * FROM platform_payments WHERE invoice_id = ? ORDER BY created_at DESC, id DESC').all(invoiceId);
}
function listRecent(limit) {
  return getDb().prepare('SELECT * FROM platform_payments ORDER BY created_at DESC, id DESC LIMIT ?').all(limit || 10);
}
function sumForInvoice(invoiceId) {
  return getDb().prepare('SELECT COALESCE(SUM(amount),0) s FROM platform_payments WHERE invoice_id = ?').get(invoiceId).s;
}
function sumForOrganization(organizationId) {
  return getDb().prepare('SELECT COALESCE(SUM(amount),0) s FROM platform_payments WHERE organization_id = ?').get(String(organizationId)).s;
}
function totalSum() {
  return getDb().prepare('SELECT COALESCE(SUM(amount),0) s FROM platform_payments').get().s;
}
function create({ organizationId, invoiceId, amount, currency, method, reference, note, recordedBy }) {
  const result = getDb().prepare(`
    INSERT INTO platform_payments (organization_id, invoice_id, amount, currency, method, reference, note, recorded_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(String(organizationId), invoiceId || null, amount, currency || 'INR', method || 'manual', reference || '', note || '', recordedBy || null);
  return findById(Number(result.lastInsertRowid));
}

module.exports = { findById, listForOrganization, listForInvoice, listRecent, sumForInvoice, sumForOrganization, totalSum, create };
