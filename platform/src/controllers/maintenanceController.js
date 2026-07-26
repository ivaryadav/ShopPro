'use strict';

const maintenanceService = require('../services/maintenanceService');
const auditService = require('../services/auditService');

function actor(req) { return { userId: req.platformUser.userId, email: req.platformUser.email, ip: req.ip }; }

async function list(req, res, next) {
  try { res.json({ policies: maintenanceService.listPolicies({ status: req.query.status, scopeType: req.query.scopeType }) }); } catch (e) { next(e); }
}
async function getOne(req, res, next) {
  try { res.json(maintenanceService.getPolicy(Number(req.params.id))); } catch (e) { next(e); }
}
async function create(req, res, next) {
  try { res.status(201).json({ policy: maintenanceService.createPolicy(req.body, actor(req)) }); } catch (e) { next(e); }
}
async function edit(req, res, next) {
  try { res.json({ policy: maintenanceService.editPolicy(Number(req.params.id), req.body, actor(req)) }); } catch (e) { next(e); }
}
async function activate(req, res, next) {
  try { res.json({ policy: maintenanceService.activate(Number(req.params.id), actor(req)) }); } catch (e) { next(e); }
}
async function deactivate(req, res, next) {
  try { res.json({ policy: maintenanceService.deactivate(Number(req.params.id), actor(req)) }); } catch (e) { next(e); }
}
async function cancel(req, res, next) {
  try { res.json({ policy: maintenanceService.cancel(Number(req.params.id), actor(req)) }); } catch (e) { next(e); }
}
async function history(req, res, next) {
  try { res.json({ entries: maintenanceService.getHistory(Number(req.query.limit) || 100) }); } catch (e) { next(e); }
}
/** Operator-facing preview: "what would this tenant see right now?" */
async function resolve(req, res, next) {
  try { res.json({ effective: maintenanceService.resolveEffective({ productSlug: req.query.productSlug, organizationScopeRef: req.query.organizationScopeRef }) }); } catch (e) { next(e); }
}
/** Product-facing bulk pull — authenticated via Platform API Key, not a human session. */
async function effectiveForProduct(req, res, next) {
  try {
    const result = maintenanceService.getEffectiveForProduct(req.query.product);
    // The ONLY signal the Maintenance Synchronization Job has that a
    // product is actually syncing — Z-SUPERADMIN never calls out to a
    // product, so it can only ever observe inbound pulls like this one.
    auditService.record({ platformUserId: req.platformUser.userId || null, action: 'MAINTENANCE_SYNC_PULLED', detail: req.query.product, ip: req.ip });
    res.json(result);
  } catch (e) { next(e); }
}

module.exports = { list, getOne, create, edit, activate, deactivate, cancel, history, resolve, effectiveForProduct };
