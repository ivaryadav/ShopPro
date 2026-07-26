/**
 * platform/src/services/customerService.js — Customer Management: the
 * global cross-field search the mission asks for (Organization, Email,
 * Phone, License, Product, Status, Owner). Merges the local organizations
 * table with every configured adapter's own search — a ShopERP customer
 * found by license key never lived in Z-SUPERADMIN's own database.
 */
'use strict';

const { getDb } = require('../database/connection');
const { listConfiguredAdapters } = require('../adapters');

async function search(query) {
  const q = (query.q || '').trim();
  if (!q) return [];
  const where = [];
  const params = [];
  where.push('(o.business_name LIKE ? OR o.owner_name LIKE ? OR o.email LIKE ? OR o.phone LIKE ? OR l.plan_code LIKE ? OR p.name LIKE ?)');
  const like = '%' + q.replace(/[%_]/g, '\\$&') + '%';
  params.push(like, like, like, like, like, like);
  if (query.status) { where.push('o.status = ?'); params.push(query.status); }
  if (query.product) { where.push('p.slug = ?'); params.push(query.product); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = getDb().prepare(`
    SELECT DISTINCT o.id AS organization_id, o.business_name, o.owner_name, o.email, o.phone, o.status
    FROM organizations o
    LEFT JOIN organization_products op ON op.organization_id = o.id
    LEFT JOIN platform_products p ON p.id = op.product_id
    LEFT JOIN platform_licenses l ON l.organization_id = o.id AND l.product_id = op.product_id
    ${whereSql}
    LIMIT 25
  `).all(...params);
  let results = rows.map((r) => ({
    organizationId: r.organization_id, businessName: r.business_name, ownerName: r.owner_name,
    email: r.email, phone: r.phone, status: r.status,
  }));

  for (const { adapter } of listConfiguredAdapters()) {
    const adapterResults = await adapter.search(q);
    results = results.concat(adapterResults);
  }
  return results;
}

module.exports = { search };
