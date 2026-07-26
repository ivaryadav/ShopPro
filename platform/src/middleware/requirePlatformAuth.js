'use strict';

const platformAuthService = require('../services/platformAuthService');
const { AuthenticationError, AuthorizationError } = require('../errors');

/**
 * @param {string} jwtSecret
 * @param {{allowMfaSetupPending?: boolean}} [opts] — set true only for the
 * handful of routes a user must be able to reach WHILE still completing a
 * role-forced MFA enrollment (mfa/setup, mfa/verify, auth/me) — every
 * other route 403s with MFA_SETUP_REQUIRED until enrollment is done.
 */
function requirePlatformAuth(jwtSecret, opts) {
  opts = opts || {};
  return function (req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) return next(new AuthenticationError('Missing Authorization header'));
    let platformUser;
    try {
      platformUser = platformAuthService.verifyToken(header.slice(7), jwtSecret);
    } catch (e) {
      return next(e instanceof AuthenticationError ? e : new AuthenticationError('Session expired. Please log in again.'));
    }
    req.platformUser = platformUser;
    // Deliberately outside the try/catch above — this is a real 403
    // (AuthorizationError), not a token/session failure, and must not be
    // relabeled into a generic 401 by the catch meant for verifyToken.
    if (platformUser.mfaSetupRequired && !opts.allowMfaSetupPending) {
      return next(new AuthorizationError('Multi-factor authentication setup is required for your role before continuing.'));
    }
    next();
  };
}

module.exports = { requirePlatformAuth };
