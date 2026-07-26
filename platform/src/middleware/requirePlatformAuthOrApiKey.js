/**
 * platform/src/middleware/requirePlatformAuthOrApiKey.js — accepts either
 * a human operator's JWT (Authorization: Bearer ...) or a Platform API Key
 * (X-Platform-Api-Key: ...), resolving both to the same req.platformUser
 * shape requirePermission() already expects, so every existing route can
 * be reached by an API key without any route-level change beyond swapping
 * which auth middleware it uses.
 */
'use strict';

const platformAuthService = require('../services/platformAuthService');
const apiKeyService = require('../services/apiKeyService');
const { AuthenticationError, AuthorizationError } = require('../errors');

function requirePlatformAuthOrApiKey(jwtSecret) {
  return function (req, res, next) {
    const apiKeyHeader = req.headers['x-platform-api-key'];
    if (apiKeyHeader) {
      const key = apiKeyService.authenticate(apiKeyHeader);
      if (!key) return next(new AuthenticationError('Invalid, expired, or revoked API key.'));
      req.platformUser = { userId: null, email: `api-key:${key.name}`, roleCode: 'API_KEY', permissions: JSON.parse(key.permissions || '[]'), isApiKey: true, apiKeyId: key.id };
      return next();
    }
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) return next(new AuthenticationError('Missing Authorization header or X-Platform-Api-Key'));
    let platformUser;
    try {
      platformUser = platformAuthService.verifyToken(header.slice(7), jwtSecret);
    } catch (e) {
      return next(e instanceof AuthenticationError ? e : new AuthenticationError('Session expired. Please log in again.'));
    }
    req.platformUser = platformUser;
    if (platformUser.mfaSetupRequired) return next(new AuthorizationError('Multi-factor authentication setup is required for your role before continuing.'));
    next();
  };
}

module.exports = { requirePlatformAuthOrApiKey };
