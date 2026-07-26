'use strict';

const subscriptionService = require('../services/subscriptionService');

function actor(req) { return { userId: req.platformUser.userId, email: req.platformUser.email, ip: req.ip }; }

async function list(req, res, next) { try { res.json(await subscriptionService.listSubscriptions(req.query)); } catch (e) { next(e); } }
async function getOne(req, res, next) { try { res.json(await subscriptionService.getSubscription(req.params.orgId, Number(req.params.productId))); } catch (e) { next(e); } }

async function upgrade(req, res, next) {
  try { const lic = await subscriptionService.upgrade(req.params.orgId, Number(req.params.productId), req.body.planCode, actor(req)); res.json({ ok: true, planCode: lic.plan_code || lic.planCode }); } catch (e) { next(e); }
}
async function downgrade(req, res, next) {
  try { const lic = await subscriptionService.downgrade(req.params.orgId, Number(req.params.productId), req.body.planCode, actor(req)); res.json({ ok: true, planCode: lic.plan_code || lic.planCode }); } catch (e) { next(e); }
}
async function renew(req, res, next) {
  try { const lic = await subscriptionService.renew(req.params.orgId, Number(req.params.productId), req.body.days, actor(req)); res.json({ ok: true, expiresAt: lic.expires_at || lic.expiresAt }); } catch (e) { next(e); }
}
async function suspend(req, res, next) {
  try { const lic = await subscriptionService.suspend(req.params.orgId, Number(req.params.productId), req.body.reason, actor(req)); res.json({ ok: true, status: lic.status }); } catch (e) { next(e); }
}
async function resume(req, res, next) {
  try { const lic = await subscriptionService.resume(req.params.orgId, Number(req.params.productId), actor(req)); res.json({ ok: true, status: lic.status }); } catch (e) { next(e); }
}
async function cancel(req, res, next) {
  try { const lic = await subscriptionService.cancel(req.params.orgId, Number(req.params.productId), req.body.reason, actor(req)); res.json({ ok: true, status: lic.status }); } catch (e) { next(e); }
}

module.exports = { list, getOne, upgrade, downgrade, renew, suspend, resume, cancel };
