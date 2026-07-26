'use strict';

const platformAuthService = require('../services/platformAuthService');
const { AuthenticationError } = require('../errors');

function requirePlatformAuth(jwtSecret) {
  return function (req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) return next(new AuthenticationError('Missing Authorization header'));
    try {
      req.platformUser = platformAuthService.verifyToken(header.slice(7), jwtSecret);
      next();
    } catch (e) {
      next(e instanceof AuthenticationError ? e : new AuthenticationError('Session expired. Please log in again.'));
    }
  };
}

module.exports = { requirePlatformAuth };
