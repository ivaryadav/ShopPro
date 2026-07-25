/**
 * server/src/errors/DatabaseError.js
 * Thrown by repositories/ when a database operation fails unexpectedly
 * (connection lost, constraint violation not already mapped to a more
 * specific error, query error). NOT operational by default — a database
 * failure is infrastructure trouble, not a normal, expected outcome of a
 * request, so errorHandler.js logs it at ERROR and never echoes the raw
 * database error message to the caller (which could leak schema/query
 * detail) — it returns a generic message instead, matching
 * server/local.js's existing "never leak internals" posture.
 */
'use strict';

const { AppError } = require('./AppError');

class DatabaseError extends AppError {
  /**
   * @param {string} message - Internal detail, logged but never sent to the caller.
   * @param {Error} [cause] - The original driver/query error, preserved for logging.
   */
  constructor(message, cause) {
    super(message, { statusCode: 500, code: 'DATABASE_ERROR', isOperational: false });
    this.cause = cause;
  }
}

module.exports = { DatabaseError };
