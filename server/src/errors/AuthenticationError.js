/**
 * server/src/errors/AuthenticationError.js
 * Thrown when a caller's identity cannot be established (missing/invalid/expired
 * credentials or session). 401. Message must stay generic at the call site —
 * see docs/independent-audit/IndependentSecurityReview.md's user-enumeration
 * findings on why "wrong password" vs "no such account" must never be
 * distinguishable in what's thrown here.
 */
'use strict';

const { AppError } = require('./AppError');

class AuthenticationError extends AppError {
  /** @param {string} [message] */
  constructor(message = 'Authentication required or credentials invalid.') {
    super(message, { statusCode: 401, code: 'AUTHENTICATION_ERROR', isOperational: true });
  }
}

module.exports = { AuthenticationError };
