/**
 * platform/src/services/licenseService.js — License Center. The platform
 * owns every license, for every organization, for every product — one
 * platform_licenses row per (organization, product) pair, same proven
 * 5-state model (TRIAL/ACTIVE/READ_ONLY/SUSPENDED/ARCHIVED) as ShopERP's
 * own tenant_licenses, generalized across products.
 *
 * Adapter-backed organizations (ShopERP today) have no platform_licenses
 * row at all — every action below dispatches straight to the adapter's
 * corresponding real ShopERP endpoint, reusing that existing service
 * exactly, never reimplementing license business rules here.
 */
'use strict';

const licenseRepository = require('../repositories/platformLicenseRepository');
const auditService = require('./auditService');
const orgRef = require('./orgRef');
const { NotFoundError: NF, ValidationError: VE } = require('../errors');

function getLicense(organizationId, productId) {
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('No license found for this organization/product');
  return lic;
}

async function activate(rawOrgId, productId, { planCode, days }, actor) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    if (planCode) await ref.adapter.assignPlan(ref.sourceId, planCode, 'monthly');
    if (days) await ref.adapter.extendLicense(ref.sourceId, days);
    else await ref.adapter.reactivateTenant(ref.sourceId);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_ACTIVATED', newValue: 'ACTIVE', detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    return { status: 'ACTIVE', plan_code: planCode || null, expires_at: null };
  }
  const organizationId = ref.localId;
  let lic = licenseRepository.find(organizationId, productId);
  const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  if (!lic) lic = licenseRepository.create({ organizationId, productId, planCode: planCode || 'BASIC', status: 'ACTIVE', expiresAt });
  else lic = licenseRepository.update(lic.id, { status: 'ACTIVE', planCode: planCode || lic.plan_code, expiresAt: expiresAt || lic.expires_at });
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_ACTIVATED', oldValue: lic.status, newValue: 'ACTIVE', ip: actor.ip });
  return lic;
}

async function suspend(rawOrgId, productId, reason, actor) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    await ref.adapter.suspendTenant(ref.sourceId, reason);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_SUSPENDED', newValue: 'SUSPENDED', detail: `${ref.slug}:${ref.sourceId} — ${reason || ''}`, ip: actor.ip });
    return { status: 'SUSPENDED' };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const updated = licenseRepository.update(lic.id, { status: 'SUSPENDED' });
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_SUSPENDED', oldValue: lic.status, newValue: 'SUSPENDED', detail: reason || '', ip: actor.ip });
  return updated;
}

async function resume(rawOrgId, productId, actor) {
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    await ref.adapter.reactivateTenant(ref.sourceId);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_RESUMED', newValue: 'ACTIVE', detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    return { status: 'ACTIVE' };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const updated = licenseRepository.update(lic.id, { status: 'ACTIVE' });
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_RESUMED', oldValue: lic.status, newValue: 'ACTIVE', ip: actor.ip });
  return updated;
}

async function renew(rawOrgId, productId, { days }, actor) {
  if (!days || days <= 0) throw new VE('days must be a positive number');
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    const result = await ref.adapter.extendLicense(ref.sourceId, days);
    auditService.record({ platformUserId: actor.userId, action: 'LICENSE_RENEWED', newValue: result.expiresAt, detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    return { expires_at: result.expiresAt };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const base = lic.expires_at && new Date(lic.expires_at).getTime() > Date.now() ? new Date(lic.expires_at) : new Date();
  const expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  const updated = licenseRepository.update(lic.id, { expiresAt, status: 'ACTIVE' });
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: 'LICENSE_RENEWED', oldValue: lic.expires_at, newValue: expiresAt, ip: actor.ip });
  return updated;
}

async function changePlan(rawOrgId, productId, planCode, direction, actor) {
  if (!planCode) throw new VE('planCode is required');
  const ref = orgRef.resolve(rawOrgId);
  if (ref.isAdapter) {
    await ref.adapter.assignPlan(ref.sourceId, planCode, 'monthly');
    auditService.record({ platformUserId: actor.userId, action: direction === 'upgrade' ? 'LICENSE_UPGRADED' : 'LICENSE_DOWNGRADED', newValue: planCode, detail: `${ref.slug}:${ref.sourceId}`, ip: actor.ip });
    return { plan_code: planCode };
  }
  const organizationId = ref.localId;
  const lic = licenseRepository.find(organizationId, productId);
  if (!lic) throw new NF('License not found');
  const updated = licenseRepository.update(lic.id, { planCode });
  auditService.record({ platformUserId: actor.userId, organizationId, productId, action: direction === 'upgrade' ? 'LICENSE_UPGRADED' : 'LICENSE_DOWNGRADED', oldValue: lic.plan_code, newValue: planCode, ip: actor.ip });
  return updated;
}

module.exports = { getLicense, activate, suspend, resume, renew, changePlan };
