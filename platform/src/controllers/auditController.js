'use strict';

const auditLogRepository = require('../repositories/platformAuditLogRepository');
const productRepository = require('../repositories/platformProductRepository');
const orgRef = require('../services/orgRef');
const { getAdapter, listConfiguredAdapters } = require('../adapters');

async function list(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

    // Filtered to one specific adapter-backed organization (e.g. viewing a
    // ShopERP customer's own history from their profile) — delegate
    // entirely to that adapter's audit log for the real, tenant-scoped view.
    if (req.query.organizationId) {
      const ref = orgRef.resolve(req.query.organizationId);
      if (ref.isAdapter) {
        const d = await ref.adapter.getAuditLog({ tenantId: ref.sourceId, eventType: req.query.action, page, pageSize });
        return res.json(d);
      }
    }

    const filterProduct = req.query.productId ? productRepository.findById(Number(req.query.productId)) : null;
    const filterAdapter = filterProduct ? getAdapter(filterProduct.slug) : null;
    if (filterAdapter && filterAdapter.isConfigured()) {
      const d = await filterAdapter.getAuditLog({ eventType: req.query.action, page, pageSize });
      return res.json(d);
    }

    const { rows, total } = auditLogRepository.list({
      organizationId: req.query.organizationId && !isNaN(Number(req.query.organizationId)) ? Number(req.query.organizationId) : null,
      productId: req.query.productId ? Number(req.query.productId) : null,
      action: req.query.action || null, page, pageSize,
    });
    let entries = rows.map((r) => ({
      id: r.id, timestamp: r.created_at, admin: r.admin_email || 'system', organization: r.org_name,
      product: r.product_name, action: r.action, oldValue: r.old_value, newValue: r.new_value,
      detail: r.detail, ip: r.ip_address, device: r.device,
    }));
    let total2 = total;

    // "All Products, all organizations" view — merge in every configured
    // adapter's own audit log too, page 1 only (a v1 simplification for
    // cross-source pagination, same as the Organizations/Dashboard merges).
    if (!req.query.organizationId && !req.query.productId) {
      for (const { adapter } of listConfiguredAdapters()) {
        const d = await adapter.getAuditLog({ eventType: req.query.action, page: 1, pageSize: 50 });
        entries = entries.concat(d.entries.map((e) => ({
          id: 'shoperp:' + e.id, timestamp: e.timestamp, admin: e.admin, organization: e.organization,
          product: 'ShopERP', action: e.action, oldValue: e.oldValue, newValue: e.newValue, detail: e.detail, ip: '', device: '',
        })));
        total2 += d.total;
      }
      entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    res.json({ entries, total: total2, page, pageSize });
  } catch (e) { next(e); }
}

module.exports = { list };
