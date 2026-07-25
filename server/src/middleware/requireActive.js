/**
 * server/src/middleware/requireActive.js
 *
 * Wraps services/tenantService.js's assertActive() as Express middleware.
 * See that file's header for the one documented deviation from
 * server/local.js (no license_expiry check — Licensing domain, out of scope).
 */
'use strict';

const tenantService = require('../services/tenantService');

/** @type {import('express').RequestHandler} */
async function requireActive(req, res, next) {
  try {
    await tenantService.assertActive(req.user.tenantId);
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireActive };
