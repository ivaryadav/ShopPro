'use strict';

const { getDb } = require('../database/connection');

function listAll({ includeInactive } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM platform_subscription_plans ORDER BY sort_order, id'
    : "SELECT * FROM platform_subscription_plans WHERE is_active = 1 ORDER BY sort_order, id";
  return getDb().prepare(sql).all();
}
function findByCode(code) { return getDb().prepare('SELECT * FROM platform_subscription_plans WHERE code = ?').get(code); }
function findById(id) { return getDb().prepare('SELECT * FROM platform_subscription_plans WHERE id = ?').get(id); }

function create({ code, name, billingCycle, deviceLimit, userLimit, storageLimitMb, priceAmount, priceCurrency, features, sortOrder }) {
  const result = getDb().prepare(`
    INSERT INTO platform_subscription_plans (code, name, billing_cycle, device_limit, user_limit, storage_limit_mb, price_amount, price_currency, features, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(code, name, billingCycle || 'monthly', deviceLimit || 2, userLimit || 5, storageLimitMb || 1024, priceAmount || 0, priceCurrency || 'INR', JSON.stringify(features || []), sortOrder || 0);
  return findById(Number(result.lastInsertRowid));
}

function update(id, fields) {
  const sets = [];
  const params = [];
  const map = {
    name: 'name', billingCycle: 'billing_cycle', deviceLimit: 'device_limit', userLimit: 'user_limit',
    storageLimitMb: 'storage_limit_mb', priceAmount: 'price_amount', priceCurrency: 'price_currency',
    isActive: 'is_active', sortOrder: 'sort_order',
  };
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(fields[key]); }
  }
  if (fields.features !== undefined) { sets.push('features = ?'); params.push(JSON.stringify(fields.features)); }
  if (!sets.length) return findById(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE platform_subscription_plans SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findById(id);
}

module.exports = { listAll, findByCode, findById, create, update };
