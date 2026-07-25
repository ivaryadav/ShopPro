/**
 * server/src/controllers/adminTenantController.js — request/response only
 * (ADR-0005). Tenant Management, Admin Dashboard, and User Administration —
 * matches local.js:1259-1370 exactly.
 */
'use strict';

const adminTenantService = require('../services/adminTenantService');
const adminUserService = require('../services/adminUserService');

/** @type {import('express').RequestHandler} */
async function setTenantStatus(req, res, next) {
  try {
    const result = await adminTenantService.setTenantStatus(req.body);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function listTenants(req, res, next) {
  try {
    res.json({ tenants: await adminTenantService.listTenants() });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function listWebUsers(req, res, next) {
  try {
    res.json({ shops: await adminTenantService.listWebUsers() });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function resetUserPin(req, res, next) {
  try {
    const { userId, newPin } = req.body || {};
    const result = await adminUserService.resetUserPin(userId, newPin);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function toggleUser(req, res, next) {
  try {
    const { userId, active } = req.body || {};
    const result = await adminUserService.toggleUser(userId, active);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

module.exports = { setTenantStatus, listTenants, listWebUsers, resetUserPin, toggleUser };
