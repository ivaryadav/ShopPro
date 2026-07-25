/**
 * server/src/services/adminTenantService.js
 *
 * Mirrors local.js's Tenant Management + Admin Dashboard business rules
 * exactly. Reuses Phase 2's tenantRepository.updateStatus (already exists,
 * unmodified) and Sprint 1's tenantLicenseRepository/licenseHistoryRepository
 * (already exist, unmodified) — this is "Licensing (except integration)":
 * consuming existing repositories from a new Sprint 2 service, not
 * changing any Phase 2/Sprint 1 file.
 */
'use strict';

const tenantRepository = require('../repositories/tenantRepository');
const tenantLicenseRepository = require('../repositories/tenantLicenseRepository');
const licenseHistoryRepository = require('../repositories/licenseHistoryRepository');
const adminDirectoryRepository = require('../repositories/adminDirectoryRepository');
const { ValidationError, NotFoundError } = require('../errors');

const LEGACY_STATUSES = ['active', 'paused', 'terminated'];

/**
 * Matches syncLegacyStatusToLicense exactly (local.js:1243-1257) — fails
 * open (silently no-ops) if the tenant has no tenant_licenses row yet,
 * exactly like local.js, rather than throwing. This is a deliberately
 * different failure mode than tenantLicenseService's own suspendTenant/
 * reactivateTenant (which throw NotFoundError) — local.js's two code
 * paths genuinely behave differently here, preserved as-is, not
 * silently unified.
 * @param {number} tenantId @param {'active'|'paused'|'terminated'} legacyStatus @param {string} [reason]
 */
async function syncLegacyStatusToLicense(tenantId, legacyStatus, reason) {
  const lic = await tenantLicenseRepository.findByTenantId(tenantId);
  if (!lic) return; // no license row yet — fail safe rather than throw, matches local.js:1245 exactly
  const licStatus = legacyStatus === 'paused' ? 'SUSPENDED' : legacyStatus === 'terminated' ? 'ARCHIVED' : 'ACTIVE';
  if (lic.status === licStatus) return; // already in sync

  if (licStatus === 'SUSPENDED') {
    await tenantLicenseRepository.suspend(tenantId);
    await tenantLicenseRepository.revokeAllSessionsForTenant(tenantId);
  } else if (licStatus === 'ARCHIVED') {
    await tenantLicenseRepository.markArchived(tenantId);
    await tenantLicenseRepository.revokeAllSessionsForTenant(tenantId);
  } else {
    await tenantLicenseRepository.reactivate(tenantId);
  }
  await licenseHistoryRepository.record({
    tenantId, eventType: 'STATUS_CHANGED', fromStatus: lic.status, toStatus: licStatus,
    detail: reason || `legacy admin action: ${legacyStatus}`, actor: 'admin',
  });
}

/**
 * Matches POST /api/admin/tenant/status exactly (local.js:1259-1269).
 * @param {{shopName:string,status:string,reason?:string}} params
 */
async function setTenantStatus({ shopName, status, reason = '' }) {
  if (!shopName || !status) throw new ValidationError('shopName and status required');
  if (!LEGACY_STATUSES.includes(status)) throw new ValidationError('Invalid status');
  const tenant = await adminDirectoryRepository.findTenantByShopName(shopName);
  if (!tenant) throw new NotFoundError('Shop not found on this server');
  await tenantRepository.updateStatus(tenant.id, status, reason);
  await syncLegacyStatusToLicense(tenant.id, status, reason);
  return { shopName: tenant.shop_name, status, reason };
}

/** Matches GET /api/admin/tenants exactly (local.js:1297-1301). */
async function listTenants() {
  return adminDirectoryRepository.listAllTenants();
}

/**
 * Matches GET /api/admin/web-users exactly (local.js:1305-1330) — groups
 * the flat row list by tenant, same as local.js's own reduce-into-object
 * logic. `licensePlan` is omitted per adminDirectoryRepository.js's own
 * documented column exclusion.
 */
async function listWebUsers() {
  const rows = await adminDirectoryRepository.listAllUsersWithTenant();
  const shops = new Map();
  for (const r of rows) {
    if (!shops.has(r.tenant_id)) {
      shops.set(r.tenant_id, { tenantId: r.tenant_id, shopName: r.shop_name, shopStatus: r.shop_status, users: [] });
    }
    shops.get(r.tenant_id).users.push({
      id: r.id, name: r.display_name || r.mobile, mobile: r.mobile,
      role: r.role, isActive: r.is_active === 1, lastLogin: r.last_login, createdAt: r.created_at,
    });
  }
  return Array.from(shops.values());
}

module.exports = { setTenantStatus, listTenants, listWebUsers };
