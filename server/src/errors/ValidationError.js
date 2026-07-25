/**
 * server/src/errors/ValidationError.js
 * Thrown when caller-supplied input fails validation. 400.
 */
'use strict';

const { AppError } = require('./AppError');

class ValidationError extends AppError {
  /**
   * @param {string} message
   * @param {object} [details] - e.g. { field: 'mobile', reason: 'must be 10 digits' }
   */
  constructor(message, details) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', isOperational: true, details });
  }
}

module.exports = { ValidationError };
