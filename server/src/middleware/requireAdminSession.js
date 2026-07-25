/**
 * server/src/middleware/requireAdminSession.js
 *
 * Mirrors local.js's requireAdminKey exactly (local.js:505-517): reads the
 * X-Admin-Key header, checks it against the in-memory admin session map.
 * Named requireAdminSession (not requireAdminKey) to avoid implying it's a
 * static-secret comparison — it's a real, expiring session token exchange
 * (adminAuthService.login), matching local.js's own post-Issue-2 model.
 */
'use strict';

const adminAuthService = require('../services/adminAuthService');
const { AuthenticationError } = require('../errors');

/** @type {import('express').RequestHandler} */
function requireAdminSession(req, res, next) {
  const key = req.headers['x-admin-key'] || '';
  if (adminAuthService.isValidAdminSession(key)) return next();
  next(new AuthenticationError('Invalid or expired admin session. Please log in again.'));
}

module.exports = { requireAdminSession };
