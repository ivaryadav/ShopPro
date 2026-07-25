/**
 * server/src/errors/AuthorizationError.js
 * Thrown when the caller is authenticated but not permitted to do the
 * specific thing requested (wrong role, license status blocks the action,
 * wrong tenant). 403.
 */
'use strict';

const { AppError } = require('./AppError');

class AuthorizationError extends AppError {
  /**
   * @param {string} [message]
   * @param {object} [details] - e.g. { licenseStatus: 'SUSPENDED' } — see
   *   server/local.js's existing requireLicenseRead/Write responses, which
   *   this error type is designed to reproduce once ported in Phase 4.
   */
  constructor(message = 'You are not authorized to perform this action.', details) {
    super(message, { statusCode: 403, code: 'AUTHORIZATION_ERROR', isOperational: true, details });
  }
}

module.exports = { AuthorizationError };
