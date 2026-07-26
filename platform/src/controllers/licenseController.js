'use strict';

const licenseService = require('../services/licenseService');

function actor(req) { return { userId: req.platformUser.userId, ip: req.ip }; }

async function activate(req, res, next) {
  try {
    const lic = await licenseService.activate(req.params.orgId, Number(req.params.productId), req.body, actor(req));
    res.json({ ok: true, status: lic.status, planCode: lic.plan_code, expiresAt: lic.expires_at });
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

module.exports = { activate, suspend, resume, renew, changePlan };
