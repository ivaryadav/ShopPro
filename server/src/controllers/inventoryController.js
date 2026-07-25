/**
 * server/src/controllers/inventoryController.js — request/response only (ADR-0005).
 */
'use strict';

const inventoryService = require('../services/inventoryService');

/** @type {import('express').RequestHandler} */
async function list(req, res, next) {
  try {
    res.json({ inventory: await inventoryService.listInventory(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function getOne(req, res, next) {
  try {
    res.json({ product: await inventoryService.getProduct(req.user.tenantId, Number(req.params.id)) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function create(req, res, next) {
  try {
    const product = await inventoryService.createProduct({ ...req.body, tenantId: req.user.tenantId });
    res.status(201).json({ product });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function update(req, res, next) {
  try {
    const product = await inventoryService.updateProduct(req.user.tenantId, Number(req.params.id), req.body);
    res.json({ product });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function adjustStock(req, res, next) {
  try {
    const product = await inventoryService.adjustStock(req.user.tenantId, Number(req.params.id), { ...req.body, actorUserId: req.user.userId });
    res.json({ product });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function remove(req, res, next) {
  try {
    await inventoryService.deleteProduct(req.user.tenantId, Number(req.params.id), req.user.userId);
    res.json({ message: 'Product deleted' });
  } catch (e) { next(e); }
}

module.exports = { list, getOne, create, update, adjustStock, remove };
