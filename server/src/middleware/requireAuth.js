/**
 * server/src/middleware/requireAuth.js
 *
 * Mirrors server/local.js's requireAuth() exactly (local.js:418-434),
 * including its exact error messages and the JWT algorithm pin
 * (HS256 only — closes the classic alg:none/RS256-confusion attack class,
 * see docs/independent-audit/IndependentSecurityReview.md §11).
 */
'use strict';

const jwt = require('jsonwebtoken');
const sessionService = require('../services/sessionService');
const { AuthenticationError } = require('../errors');

/**
 * @param {string} jwtSecret
 * @returns {import('express').RequestHandler}
 */
function requireAuth(jwtSecret) {
  return async function (req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      return next(new AuthenticationError('Missing Authorization header'));
    }
    try {
      const payload = jwt.verify(header.slice(7), jwtSecret, { algorithms: ['HS256'] });
      const check = await sessionService.checkSession(payload);
      if (!check.ok) {
        return next(new AuthenticationError('Session expired or was signed out elsewhere. Please log in again.'));
      }
      req.user = payload;
      next();
    } catch (e) {
      if (e instanceof AuthenticationError) return next(e);
      next(new AuthenticationError('Session expired. Please log in again.'));
    }
  };
}

module.exports = { requireAuth };
