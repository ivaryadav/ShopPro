/**
 * server/src/errors/NotFoundError.js
 * Thrown when a requested resource genuinely doesn't exist. 404.
 */
'use strict';

const { AppError } = require('./AppError');

class NotFoundError extends AppError {
  /** @param {string} [message] */
  constructor(message = 'The requested resource was not found.') {
    super(message, { statusCode: 404, code: 'NOT_FOUND_ERROR', isOperational: true });
  }
}

module.exports = { NotFoundError };
