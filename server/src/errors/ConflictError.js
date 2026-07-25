/**
 * server/src/errors/ConflictError.js
 * Thrown when a request conflicts with the current state of the resource —
 * duplicate registration, optimistic-concurrency version mismatch
 * (server/local.js's PUT /api/data), a unique-constraint violation. 409.
 */
'use strict';

const { AppError } = require('./AppError');

class ConflictError extends AppError {
  /** @param {string} message @param {object} [details] */
  constructor(message, details) {
    super(message, { statusCode: 409, code: 'CONFLICT_ERROR', isOperational: true, details });
  }
}

module.exports = { ConflictError };
