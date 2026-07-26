'use strict';

const { getDb } = require('../database/connection');

function listAll() { return getDb().prepare('SELECT * FROM platform_products ORDER BY name').all(); }
function findById(id) { return getDb().prepare('SELECT * FROM platform_products WHERE id = ?').get(id); }
function findBySlug(slug) { return getDb().prepare('SELECT * FROM platform_products WHERE slug = ?').get(slug); }
function create({ name, slug, logoUrl, description, version, status, licenseModel, featureFlags, routes, permissions }) {
  const result = getDb().prepare(`
    INSERT INTO platform_products (name, slug, logo_url, description, version, status, license_model, feature_flags, routes, permissions)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(name, slug, logoUrl || '', description || '', version || '1.0.0', status || 'planned', licenseModel || 'subscription',
    JSON.stringify(featureFlags || []), JSON.stringify(routes || []), JSON.stringify(permissions || []));
  return findById(Number(result.lastInsertRowid));
}
function update(id, fields) {
  const sets = [];
  const params = [];
  const map = { name: 'name', logoUrl: 'logo_url', description: 'description', version: 'version', status: 'status', licenseModel: 'license_model' };
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(fields[key]); }
  }
  if (fields.featureFlags !== undefined) { sets.push('feature_flags = ?'); params.push(JSON.stringify(fields.featureFlags)); }
  if (!sets.length) return findById(id);
  params.push(id);
  getDb().prepare(`UPDATE platform_products SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findById(id);
}

module.exports = { listAll, findById, findBySlug, create, update };
