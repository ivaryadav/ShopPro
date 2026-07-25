/**
 * server/src/controllers/saleController.js — request/response only (ADR-0005).
 */
'use strict';

const saleService = require('../services/saleService');

/** @type {import('express').RequestHandler} */
async function list(req, res, next) {
  try {
    res.json({ sales: await saleService.listSales(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function getOne(req, res, next) {
  try {
    res.json({ sale: await saleService.getSale(req.user.tenantId, Number(req.params.id)) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function create(req, res, next) {
  try {
    const sale = await saleService.createSale({ ...req.body, tenantId: req.user.tenantId, createdBy: req.user.userId });
    res.status(201).json({ sale });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function update(req, res, next) {
  try {
    const sale = await saleService.updateSale(req.user.tenantId, Number(req.params.id), req.body);
    res.json({ sale });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function nextInvoiceNo(req, res, next) {
  try {
    res.json({ invoiceNo: await saleService.nextInvoiceNo(req.user.tenantId) });
  } catch (e) { next(e); }
}

module.exports = { list, getOne, create, update, nextInvoiceNo };
