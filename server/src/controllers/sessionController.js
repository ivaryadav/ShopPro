/**
 * server/src/controllers/sessionController.js
 *
 * Request/response only (ADR-0005). Matches local.js's
 * GET /api/auth/sessions and POST /api/auth/sessions/:sessionId/revoke
 * exactly.
 */
'use strict';

const sessionService = require('../services/sessionService');

/** @type {import('express').RequestHandler} */
async function list(req, res, next) {
  try {
    const sessionsList = await sessionService.listForTenant(req.user.tenantId);
    res.json({ sessions: sessionsList });
  } catch (e) {
    next(e);
  }
}

/** @type {import('express').RequestHandler} */
async function revoke(req, res, next) {
  try {
    await sessionService.revokeOwned(req.user.tenantId, req.params.sessionId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

module.exports = { list, revoke };
