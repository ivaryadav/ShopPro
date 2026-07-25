/**
 * server/src/controllers/licenseController.js
 *
 * Request/response only (ADR-0005). Matches GET /api/license/status
 * exactly for the tenant_licenses-sourced fields — see
 * tenantLicenseService.getLicenseStatus's own header for the one
 * documented narrowing (no outer legacy tenants-column fields).
 */
'use strict';

const tenantLicenseService = require('../services/tenantLicenseService');

/** @type {import('express').RequestHandler} */
async function getStatus(req, res, next) {
  try {
    const license = await tenantLicenseService.getLicenseStatus(req.user.tenantId);
    res.json({ license });
  } catch (e) { next(e); }
}

module.exports = { getStatus };
