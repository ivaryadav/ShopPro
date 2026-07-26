'use strict';

const { getDb } = require('../database/connection');
const licenseRepository = require('../repositories/platformLicenseRepository');
const deviceRepository = require('../repositories/organizationDeviceRepository');
const orgUserRepository = require('../repositories/organizationUserRepository');
const productRepository = require('../repositories/platformProductRepository');
const { getAdapter, listConfiguredAdapters } = require('../adapters');

async function stats(req, res, next) {
  try {
    const db = getDb();
    const productId = req.query.productId ? Number(req.query.productId) : null;
    const filterProduct = productId ? productRepository.findById(productId) : null;
    const filterAdapter = filterProduct ? getAdapter(filterProduct.slug) : null;

    // A specific adapter-backed product filter (e.g. "ShopERP" in the
    // Product Switcher) delegates entirely to that adapter's own real,
    // already-built dashboard-stats endpoint — reused, not reimplemented.
    if (filterAdapter && filterAdapter.isConfigured()) {
      return res.json(await filterAdapter.getDashboardStats());
    }

    const orgFilterJoin = productId ? 'JOIN organization_products op ON op.organization_id = o.id AND op.product_id = ?' : '';
    const orgParams = productId ? [productId] : [];
    let totalOrganizations = db.prepare(`SELECT COUNT(DISTINCT o.id) c FROM organizations o ${orgFilterJoin}`).get(...orgParams).c;
    const totalProducts = db.prepare("SELECT COUNT(*) c FROM platform_products WHERE status='active'").get().c;
    let pending = db.prepare(`SELECT COUNT(DISTINCT o.id) c FROM organizations o ${orgFilterJoin} WHERE o.status='PENDING_APPROVAL'`).get(...orgParams).c;
    const licStats = licenseRepository.stats();
    let activeLicenses = licStats.active, expiredLicenses = licStats.expired, expiringLicenses = licStats.expiringSoon;
    let activeDevices = deviceRepository.totalActive();
    let onlineToday = orgUserRepository.countOnlineToday();
    const localRecentOrgs = db.prepare(`SELECT o.id, o.business_name, o.owner_name, o.email, o.created_at FROM organizations o ${orgFilterJoin} ORDER BY o.created_at DESC LIMIT 10`).all(...orgParams);
    let recentOrganizations = localRecentOrgs.map((o) => ({ id: o.id, businessName: o.business_name, ownerName: o.owner_name, email: o.email, createdAt: o.created_at }));

    // "All Products" (no filter): merge in every configured adapter's live
    // stats too — this is the ONLY place ShopERP's real numbers appear
    // when the platform owner hasn't narrowed the Product Switcher.
    if (!productId) {
      for (const { adapter } of listConfiguredAdapters()) {
        const d = await adapter.getDashboardStats();
        totalOrganizations += d.totalOrganizations;
        pending += d.pendingRegistrations;
        activeLicenses += d.activeLicenses;
        expiredLicenses += d.expiredLicenses;
        expiringLicenses += d.expiringWithin30Days;
        activeDevices += d.totalDevices;
        onlineToday += d.onlineToday;
        recentOrganizations = recentOrganizations.concat(d.recentOrganizations)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
      }
    }

    res.json({
      totalOrganizations, totalProducts, activeLicenses, expiredLicenses,
      pendingRegistrations: pending, onlineOrganizationsToday: onlineToday,
      revenue: 0, // future-ready — no billing/payment integration exists yet in any product
      expiringLicenses, activeDevices,
      lastActivity: recentOrganizations[0] ? recentOrganizations[0].createdAt : null,
      recentOrganizations,
    });
  } catch (e) { next(e); }
}

module.exports = { stats };
