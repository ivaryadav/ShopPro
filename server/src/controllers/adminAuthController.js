/**
 * server/src/controllers/adminAuthController.js — request/response only (ADR-0005).
 * Matches POST /api/admin/login exactly (local.js:1197-1232).
 */
'use strict';

const adminAuthService = require('../services/adminAuthService');

/** @type {import('express').RequestHandler} */
async function login(req, res, next) {
  try {
    const token = await adminAuthService.login(req.body.password);
    res.json({ ok: true, adminToken: token });
  } catch (e) { next(e); }
}

module.exports = { login };
