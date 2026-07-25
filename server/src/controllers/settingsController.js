/**
 * server/src/controllers/settingsController.js — request/response only (ADR-0005).
 */
'use strict';

const settingsService = require('../services/settingsService');

/** @type {import('express').RequestHandler} */
async function get(req, res, next) {
  try {
    res.json({ settings: await settingsService.getSettings(req.user.tenantId) });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function put(req, res, next) {
  try {
    res.json({ settings: await settingsService.putSettings(req.user.tenantId, req.body.settings || req.body) });
  } catch (e) { next(e); }
}

module.exports = { get, put };
