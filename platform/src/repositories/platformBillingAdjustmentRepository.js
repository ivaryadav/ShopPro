'use strict';

const { getDb } = require('../database/connection');

function findById(id) { return getDb().prepare('SELECT * FROM platform_billing_adjustments WHERE id = ?').get(id); }
function listForOrganization(organizationId) {
  return getDb().prepare('SELECT * FROM platform_billing_adjustments WHERE organization_id = ? ORDER BY created_at DESC, id DESC').all(String(organizationId));
}
function sumForOrganization(organizationId, type) {
  return getDb().prepare('SELECT COALESCE(SUM(amount),0) s FROM platform_billing_adjustments WHERE organization_id = ? AND type = ?').get(String(organizationId), type).s;
}
function totalSum(type) {
  return getDb().prepare('SELECT COALESCE(SUM(amount),0) s FROM platform_billing_adjustments WHERE type = ?').get(type).s;
}
function create({ organizationId, invoiceId, type, amount, currency, reason, createdBy }) {
  const result = getDb().prepare(`
    INSERT INTO platform_billing_adjustments (organization_id, invoice_id, type, amount, currency, reason, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(String(organizationId), invoiceId || null, type, amount, currency || 'INR', reason || '', createdBy || null);
  return findById(Number(result.lastInsertRowid));
}

module.exports = { findById, listForOrganization, sumForOrganization, totalSum, create };
