/**
 * server/src/errors/index.js — single import point for every error type
 * plus the global handler.
 */
'use strict';

const { AppError } = require('./AppError');
const { ValidationError } = require('./ValidationError');
const { AuthenticationError } = require('./AuthenticationError');
const { AuthorizationError } = require('./AuthorizationError');
const { ConflictError } = require('./ConflictError');
const { DatabaseError } = require('./DatabaseError');
const { BusinessRuleError } = require('./BusinessRuleError');
const { NotFoundError } = require('./NotFoundError');
const { InfrastructureError } = require('./InfrastructureError');
const { errorHandler, GENERIC_MESSAGE } = require('./errorHandler');

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  BusinessRuleError,
  NotFoundError,
  InfrastructureError,
  errorHandler,
  GENERIC_MESSAGE,
};
