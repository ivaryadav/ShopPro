'use strict';

const apiKeyService = require('../services/apiKeyService');

function actor(req) { return { userId: req.platformUser.userId, ip: req.ip }; }

async function list(req, res, next) { try { res.json({ keys: apiKeyService.list() }); } catch (e) { next(e); } }
async function create(req, res, next) {
  try { res.status(201).json(apiKeyService.create(req.body, actor(req))); } catch (e) { next(e); }
}
async function rotate(req, res, next) {
  try { res.json(apiKeyService.rotate(req.params.id, actor(req))); } catch (e) { next(e); }
}
async function revoke(req, res, next) {
  try { res.json(apiKeyService.revoke(req.params.id, actor(req))); } catch (e) { next(e); }
}

module.exports = { list, create, rotate, revoke };
