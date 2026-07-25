/**
 * server/src/errors/InfrastructureError.js
 * Thrown when something outside this application's own code fails —
 * SMTP unreachable, filesystem write failure, a downstream HTTP call
 * timing out. Distinct from DatabaseError only in that it's not the
 * database specifically; kept separate so logging/alerting can
 * distinguish "our database is down" from "some other dependency is
 * down" at a glance. Not operational — same reasoning as DatabaseError.
 */
'use strict';

const { AppError } = require('./AppError');

class InfrastructureError extends AppError {
  /**
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(message, cause) {
    super(message, { statusCode: 503, code: 'INFRASTRUCTURE_ERROR', isOperational: false });
    this.cause = cause;
  }
}

module.exports = { InfrastructureError };
