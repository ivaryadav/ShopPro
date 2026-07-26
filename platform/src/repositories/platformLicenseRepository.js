'use strict';

const { getDb } = require('../database/connection');

function find(organizationId, productId) {
  return getDb().prepare('SELECT * FROM platform_licenses WHERE organization_id = ? AND product_id = ?').get(organizationId, productId);
}
function findById(id) { return getDb().prepare('SELECT * FROM platform_licenses WHERE id = ?').get(id); }
function listForOrganization(organizationId) {
  return getDb().prepare(`
    SELECT l.*, p.name AS product_name, p.slug AS product_slug
    FROM platform_licenses l JOIN platform_products p ON p.id = l.product_id
    WHERE l.organization_id = ?
  `).all(organizationId);
}
function create({ organizationId, productId, planCode, status, expiresAt }) {
  const result = getDb().prepare(`
    INSERT INTO platform_licenses (organization_id, product_id, plan_code, status, expires_at)
    VALUES (?,?,?,?,?)
  `).run(organizationId, productId, planCode || 'TRIAL', status || 'TRIAL', expiresAt || null);
  return findById(Number(result.lastInsertRowid));
}
function update(id, fields) {
  const sets = [];
  const params = [];
  const map = { planCode: 'plan_code', status: 'status', expiresAt: 'expires_at', gracePeriodDays: 'grace_period_days' };
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(fields[key]); }
  }
  if (!sets.length) return findById(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE platform_licenses SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findById(id);
}
function stats() {
  const db = getDb();
  return {
    active: db.prepare("SELECT COUNT(*) c FROM platform_licenses WHERE status='ACTIVE'").get().c,
    expired: db.prepare("SELECT COUNT(*) c FROM platform_licenses WHERE status='READ_ONLY'").get().c,
    expiringSoon: db.prepare("SELECT COUNT(*) c FROM platform_licenses WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at <= datetime('now','+30 days')").get().c,
  };
}

module.exports = { find, findById, listForOrganization, create, update, stats };
