/**
 * server/src/errors/AppError.js
 *
 * Base class for every error type this backend throws deliberately (as
 * opposed to an unexpected bug surfacing as a raw Error/TypeError). Each
 * subclass fixes its own `statusCode` and `code` so a thrown error and its
 * HTTP response are never decided in two different places — see
 * errorHandler.js, which is the *only* place that inspects these fields
 * to build a response.
 */
'use strict';

class AppError extends Error {
  /**
   * @param {string} message - Safe to show to an API caller (errorHandler.js does).
   * @param {{ statusCode: number, code: string, isOperational?: boolean, details?: object }} options
   */
  constructor(message, { statusCode, code, isOperational = true, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    /**
     * True for "expected" errors (bad input, not found, etc.) that are safe
     * to log at WARN and whose message is safe to return to the caller.
     * False for genuinely unexpected failures — errorHandler.js logs those
     * at ERROR/FATAL and never echoes their raw message to the caller.
     */
    this.isOperational = isOperational;
    /** Optional structured detail (e.g. which field failed validation) — included in the API response. */
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { AppError };
