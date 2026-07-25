/**
 * server/src/controllers/customerController.js — request/response only (ADR-0005).
 */
'use strict';

const customerService = require('../services/customerService');

/** @type {import('express').RequestHandler} */
async function list(req, res, next) {
  try {
    res.json({ customers: await customerService.listCustomers(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function getOne(req, res, next) {
  try {
    res.json({ customer: await customerService.getCustomer(req.user.tenantId, Number(req.params.id)) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function create(req, res, next) {
  try {
    const customer = await customerService.createCustomer({ ...req.body, tenantId: req.user.tenantId });
    res.status(201).json({ customer });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function update(req, res, next) {
  try {
    const customer = await customerService.updateCustomer(req.user.tenantId, Number(req.params.id), req.body);
    res.json({ customer });
  } catch (e) { next(e); }
}

module.exports = { list, getOne, create, update };
