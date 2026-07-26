'use strict';

const licenseService = require('../services/licenseService');
const planRepository = require('../repositories/platformSubscriptionPlanRepository');

function actor(req) { return { userId: req.platformUser.userId, email: req.platformUser.email, ip: req.ip }; }

async function activate(req, res, next) {
  try {
    const lic = await licenseService.activate(req.params.orgId, Number(req.params.productId), req.body, actor(req));
    res.json({ ok: true, status: lic.status, planCode: lic.plan_code, expiresAt: lic.expires_at });
  } catch (e) { next(e); }
}
async function assign(req, res, next) {
  try {
    const lic = await licenseService.assign(req.params.orgId, Number(req.params.productId), req.body.planCode, actor(req));
    res.json({ ok: true, status: lic.status, planCode: lic.plan_code, licenseKey: lic.license_key });
  } catch (e) { next(e); }
}
async function suspend(req, res, next) {
  try { const lic = await licenseService.suspend(req.params.orgId, Number(req.params.productId), req.body.reason, actor(req)); res.json({ ok: true, status: lic.status }); } catch (e) { next(e); }
}
async function resume(req, res, next) {
  try { const lic = await licenseService.resume(req.params.orgId, Number(req.params.productId), actor(req)); res.json({ ok: true, status: lic.status }); } catch (e) { next(e); }
}
async function renew(req, res, next) {
  try { const lic = await licenseService.renew(req.params.orgId, Number(req.params.productId), req.body, actor(req)); res.json({ ok: true, expiresAt: lic.expires_at }); } catch (e) { next(e); }
}
async function changePlan(req, res, next) {
  try { const lic = await licenseService.changePlan(req.params.orgId, Number(req.params.productId), req.body.planCode, req.body.direction, actor(req)); res.json({ ok: true, planCode: lic.plan_code }); } catch (e) { next(e); }
}
async function cancel(req, res, next) {
  try { const lic = await licenseService.cancel(req.params.orgId, Number(req.params.productId), req.body.reason, actor(req)); res.json({ ok: true, status: lic.status }); } catch (e) { next(e); }
}
async function history(req, res, next) {
  try { res.json({ history: await licenseService.getLicenseHistory(req.params.orgId) }); } catch (e) { next(e); }
}
async function expirationDashboard(req, res, next) {
  try { res.json(await licenseService.getExpirationDashboard()); } catch (e) { next(e); }
}

// ── Plan Catalog ─────────────────────────────────────────────────────────
async function listPlans(req, res, next) {
  try { res.json({ plans: planRepository.listAll({ includeInactive: req.query.includeInactive === 'true' }) }); } catch (e) { next(e); }
}
async function createPlan(req, res, next) {
  try {
    const b = req.body;
    if (!b.code || !b.name) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'code and name are required' } });
    const plan = planRepository.create(b);
    res.status(201).json({ plan });
  } catch (e) { next(e); }
}
async function updatePlan(req, res, next) {
  try { res.json({ plan: planRepository.update(Number(req.params.id), req.body) }); } catch (e) { next(e); }
}

module.exports = { activate, assign, suspend, resume, renew, changePlan, cancel, history, expirationDashboard, listPlans, createPlan, updatePlan };
