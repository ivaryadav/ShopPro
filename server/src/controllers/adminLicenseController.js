/**
 * server/src/controllers/adminLicenseController.js — request/response
 * only (ADR-0005). Registration Approval, Subscription Administration,
 * License Management, and Device Management — thin wrappers around
 * Sprint 1's tenantLicenseService (integration, not modification) and
 * this sprint's own adminDeviceService. Matches local.js:1373-1652 exactly.
 */
'use strict';

const tenantLicenseService = require('../services/tenantLicenseService');
const adminDeviceService = require('../services/adminDeviceService');

/** @type {import('express').RequestHandler} */
async function listRegistrations(req, res, next) {
  try {
    res.json({ registrations: await tenantLicenseService.listPendingRegistrations() });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function approveRegistration(req, res, next) {
  try {
    const result = await tenantLicenseService.approveRegistration(Number(req.params.tenantId));
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function rejectRegistration(req, res, next) {
  try {
    const result = await tenantLicenseService.rejectRegistration(Number(req.params.tenantId), req.body?.reason);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function listTenantLicenses(req, res, next) {
  try {
    res.json({ tenants: await tenantLicenseService.listTenantLicenses() });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function getHistory(req, res, next) {
  try {
    res.json({ history: await tenantLicenseService.getHistory(Number(req.params.tenantId)) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function assignPlan(req, res, next) {
  try {
    const { planCode, billingCycle, deviceLimitOverride } = req.body || {};
    const result = await tenantLicenseService.assignPlan(Number(req.params.tenantId), planCode, billingCycle, deviceLimitOverride);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function startTrial(req, res, next) {
  try {
    const result = await tenantLicenseService.startTrial(Number(req.params.tenantId));
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function generateLicense(req, res, next) {
  try {
    const result = await tenantLicenseService.generateLicenseForTenant(Number(req.params.tenantId), req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function extend(req, res, next) {
  try {
    const result = await tenantLicenseService.extendLicense(Number(req.params.tenantId), req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function suspend(req, res, next) {
  try {
    await tenantLicenseService.suspendTenant(Number(req.params.tenantId), req.body?.reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function reactivate(req, res, next) {
  try {
    await tenantLicenseService.reactivateTenant(Number(req.params.tenantId));
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function killSessions(req, res, next) {
  try {
    const result = await tenantLicenseService.killSessions(Number(req.params.tenantId));
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function addNote(req, res, next) {
  try {
    await tenantLicenseService.addNote(Number(req.params.tenantId), req.body?.note);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function addCallNote(req, res, next) {
  try {
    await tenantLicenseService.addCallNote(Number(req.params.tenantId), req.body?.note);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function setDeviceLimit(req, res, next) {
  try {
    const { deviceLimit } = req.body || {};
    await tenantLicenseService.setDeviceLimit(Number(req.params.tenantId), deviceLimit);
    res.json({ ok: true, deviceLimit });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function listDevices(req, res, next) {
  try {
    res.json({ devices: await adminDeviceService.listDevices(Number(req.params.tenantId)) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function removeDevice(req, res, next) {
  try {
    await adminDeviceService.removeDevice(Number(req.params.tenantId), Number(req.params.rowId));
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function resetAllDevices(req, res, next) {
  try {
    const result = await adminDeviceService.resetAllDevices(Number(req.params.tenantId));
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

module.exports = {
  listRegistrations, approveRegistration, rejectRegistration, listTenantLicenses, getHistory,
  assignPlan, startTrial, generateLicense, extend, suspend, reactivate, killSessions,
  addNote, addCallNote, setDeviceLimit, listDevices, removeDevice, resetAllDevices,
};
