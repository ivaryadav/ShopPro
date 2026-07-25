/**
 * server/src/errors/BusinessRuleError.js
 * Thrown by services/ when a request is well-formed and the caller is
 * authorized, but a domain rule still forbids it — e.g. "device limit
 * reached" (server/local.js's DEVICE_LIMIT_REACHED), "this registration
 * is not pending approval". 422 — distinct from ValidationError (malformed
 * input) and AuthorizationError (a permissions/identity question).
 */
'use strict';

const { AppError } = require('./AppError');

class BusinessRuleError extends AppError {
  /**
   * @param {string} message
   * @param {string} [ruleCode] - A short, stable, machine-readable code for
   *   this specific rule (e.g. 'DEVICE_LIMIT_REACHED'), for clients that
   *   want to branch on it without parsing the message.
   * @param {object} [details]
   */
  constructor(message, ruleCode, details) {
    super(message, {
      statusCode: 422,
      code: ruleCode ? `BUSINESS_RULE_ERROR:${ruleCode}` : 'BUSINESS_RULE_ERROR',
      isOperational: true,
      details,
    });
    this.ruleCode = ruleCode;
  }
}

module.exports = { BusinessRuleError };
