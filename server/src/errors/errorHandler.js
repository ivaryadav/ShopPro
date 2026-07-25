/**
 * server/src/errors/errorHandler.js
 *
 * The ONE global Express error-handling middleware for server/src/. Every
 * route/controller/service throws (or calls `next(err)` with) one of the
 * typed errors in this folder; nothing else in this tree writes its own
 * try/catch-and-format-a-response — that duplication is exactly what
 * "consistent API responses, consistent logging, consistent error codes"
 * (the Phase 1 requirement) means to eliminate.
 *
 * Response shape (always):
 *   { error: { code: string, message: string, details?: object } }
 *
 * Operational errors (AppError subclasses with isOperational: true) are
 * logged at WARN and their message/details are returned as-is — they were
 * thrown deliberately, with a message already written to be safe to show
 * a caller. Non-operational AppErrors (DatabaseError, InfrastructureError)
 * and any error that isn't an AppError at all (a genuine bug) are logged
 * at ERROR with the full stack, and the caller gets a fixed, generic
 * message — matching server/local.js's existing "never leak internals"
 * posture (see docs/independent-audit/APIAudit.md's Output encoding
 * section, which found zero stack-trace leaks in the current app; this
 * middleware exists so that stays true by construction, not by habit).
 */
'use strict';

const { AppError } = require('./AppError');
const { getLogger } = require('../logging');

const GENERIC_MESSAGE = 'Something went wrong. Please try again, or contact support if this continues.';

/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  const logger = getLogger();
  const isAppError = err instanceof AppError;
  const isOperational = isAppError && err.isOperational;

  const logMeta = {
    path: req.originalUrl,
    method: req.method,
    code: isAppError ? err.code : 'UNHANDLED_ERROR',
  };

  if (isOperational) {
    logger.warn(err.message, logMeta);
  } else {
    logger.error(err.message, { ...logMeta, stack: err.stack });
  }

  const statusCode = isAppError ? err.statusCode : 500;
  const responseBody = isOperational
    ? { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }
    : { error: { code: isAppError ? err.code : 'INTERNAL_ERROR', message: GENERIC_MESSAGE } };

  res.status(statusCode).json(responseBody);
}

module.exports = { errorHandler, GENERIC_MESSAGE };
