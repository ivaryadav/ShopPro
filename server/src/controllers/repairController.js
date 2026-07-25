/**
 * server/src/controllers/repairController.js — request/response only (ADR-0005).
 */
'use strict';

const repairService = require('../services/repairService');

/** @type {import('express').RequestHandler} */
async function list(req, res, next) {
  try {
    res.json({ repairs: await repairService.listRepairs(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function getOne(req, res, next) {
  try {
    res.json({ repair: await repairService.getRepair(req.user.tenantId, Number(req.params.id)) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function create(req, res, next) {
  try {
    const repair = await repairService.createRepair({ ...req.body, tenantId: req.user.tenantId, createdBy: req.user.userId });
    res.status(201).json({ repair });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function addPart(req, res, next) {
  try {
    const repair = await repairService.addPart(req.user.tenantId, Number(req.params.id), { ...req.body, actorUserId: req.user.userId });
    res.json({ repair });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function removePart(req, res, next) {
  try {
    const repair = await repairService.removePart(req.user.tenantId, Number(req.params.id), Number(req.params.partId), req.user.userId);
    res.json({ repair });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function updateFinancials(req, res, next) {
  try {
    const repair = await repairService.recalculateFinalCost(req.user.tenantId, Number(req.params.id), req.body.labourCharge);
    res.json({ repair });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function updateStatus(req, res, next) {
  try {
    const repair = await repairService.updateStatus(req.user.tenantId, Number(req.params.id), req.body.status, req.body.deliveredDate);
    res.json({ repair });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function collectPayment(req, res, next) {
  try {
    const repair = await repairService.collectPayment(req.user.tenantId, Number(req.params.id), req.body.payments, req.body.paymentDate);
    res.json({ repair });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function remove(req, res, next) {
  try {
    await repairService.deleteRepair(req.user.tenantId, Number(req.params.id), req.user.userId);
    res.json({ message: 'Job deleted' });
  } catch (e) { next(e); }
}

module.exports = { list, getOne, create, addPart, removePart, updateFinancials, updateStatus, collectPayment, remove };
