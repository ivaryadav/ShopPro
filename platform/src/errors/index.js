/**
 * platform/src/errors/index.js — typed errors + one global error handler,
 * same {error:{code,message}} shape convention this whole engagement uses.
 */
'use strict';

class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}
class ValidationError extends AppError { constructor(m) { super(m, 400, 'VALIDATION_ERROR'); } }
class AuthenticationError extends AppError { constructor(m) { super(m, 401, 'AUTHENTICATION_ERROR'); } }
class AuthorizationError extends AppError { constructor(m) { super(m, 403, 'AUTHORIZATION_ERROR'); } }
class NotFoundError extends AppError { constructor(m) { super(m, 404, 'NOT_FOUND_ERROR'); } }
class ConflictError extends AppError { constructor(m) { super(m, 409, 'CONFLICT_ERROR'); } }
class LockedError extends AppError { constructor(m) { super(m, 423, 'LOCKED_ERROR'); } }

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
  }
  console.error('[PLATFORM] Unhandled error:', req.method, req.path, err && err.message);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
}

module.exports = { AppError, ValidationError, AuthenticationError, AuthorizationError, NotFoundError, ConflictError, LockedError, errorHandler };
