'use strict';

const { getDb } = require('../database/connection');

function listAll() {
  return getDb().prepare(`
    SELECT f.*, p.name AS product_name FROM platform_feature_flags f LEFT JOIN platform_products p ON p.id = f.product_id ORDER BY f.key
  `).all();
}
function upsert({ key, description, isEnabled, productId }) {
  getDb().prepare(`
    INSERT INTO platform_feature_flags (key, description, is_enabled, product_id) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET description=excluded.description, is_enabled=excluded.is_enabled, product_id=excluded.product_id
  `).run(key, description || '', isEnabled ? 1 : 0, productId || null);
}

module.exports = { listAll, upsert };
