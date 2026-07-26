'use strict';

const productRegistryService = require('../services/productRegistryService');

function actor(req) { return { userId: req.platformUser.userId, ip: req.ip }; }

async function list(req, res, next) { try { res.json({ products: productRegistryService.listProducts() }); } catch (e) { next(e); } }
async function getOne(req, res, next) { try { res.json({ product: productRegistryService.getProduct(Number(req.params.id)) }); } catch (e) { next(e); } }
async function create(req, res, next) { try { res.status(201).json({ product: productRegistryService.createProduct(req.body, actor(req)) }); } catch (e) { next(e); } }
async function update(req, res, next) { try { res.json({ product: productRegistryService.updateProduct(Number(req.params.id), req.body, actor(req)) }); } catch (e) { next(e); } }

module.exports = { list, getOne, create, update };
