/**
 * Phase 1 test — server/src/errors/. Tests every error class's shape and
 * errorHandler.js's response formatting using mock Express req/res objects
 * (no real HTTP server needed).
 *
 * Usage: node server/src/tests/errors.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AppError, ValidationError, AuthenticationError, AuthorizationError,
  ConflictError, DatabaseError, BusinessRuleError, NotFoundError,
  InfrastructureError, errorHandler, GENERIC_MESSAGE,
} = require('../errors');
const { _resetForTests } = require('../logging');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

console.log('Phase 1: errors/ tests');
console.log('');

// ── Error class shapes ───────────────────────────────────────────────────
const cases = [
  [new ValidationError('bad input'), 400, 'VALIDATION_ERROR', true],
  [new AuthenticationError(), 401, 'AUTHENTICATION_ERROR', true],
  [new AuthorizationError(), 403, 'AUTHORIZATION_ERROR', true],
  [new ConflictError('dup'), 409, 'CONFLICT_ERROR', true],
  [new NotFoundError(), 404, 'NOT_FOUND_ERROR', true],
  [new BusinessRuleError('nope', 'SOME_RULE'), 422, 'BUSINESS_RULE_ERROR:SOME_RULE', true],
  [new DatabaseError('db broke'), 500, 'DATABASE_ERROR', false],
  [new InfrastructureError('smtp down'), 503, 'INFRASTRUCTURE_ERROR', false],
];
for (const [err, statusCode, code, isOperational] of cases) {
  assert(err instanceof AppError, `${err.name} is an instance of AppError`);
  assert(err.statusCode === statusCode, `${err.name} has statusCode ${statusCode}`);
  assert(err.code === code, `${err.name} has code '${code}'`);
  assert(err.isOperational === isOperational, `${err.name}.isOperational === ${isOperational}`);
}

// A plain, non-AppError Error (simulating a genuine bug reaching the handler)
const rawBug = new TypeError("Cannot read properties of undefined (reading 'x')");
assert(!(rawBug instanceof AppError), 'a raw TypeError is correctly NOT an AppError (used below)');

// ── errorHandler.js — mock req/res harness ──────────────────────────────
_resetForTests();
process.env.LOG_LEVEL = 'FATAL'; // suppress WARN/ERROR console noise during this test run
const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoperp-errhandler-test-'));
process.env.LOG_DIR = tmpLogDir; // keep this test from writing into the real server/logs/

function mockReqRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const req = { originalUrl: '/api/test', method: 'POST' };
  return { req, res };
}

// Operational error -> its own message/details returned as-is
{
  const { req, res } = mockReqRes();
  const err = new ValidationError('mobile must be 10 digits', { field: 'mobile' });
  errorHandler(err, req, res, () => {});
  assert(res.statusCode === 400, 'errorHandler sets the status code from the thrown error');
  assert(res.body.error.code === 'VALIDATION_ERROR', 'errorHandler returns the error code');
  assert(res.body.error.message === 'mobile must be 10 digits', "an operational error's own message is returned to the caller");
  assert(res.body.error.details.field === 'mobile', 'operational error details are included in the response');
}

// Non-operational AppError (DatabaseError) -> generic message, no internal detail leaked
{
  const { req, res } = mockReqRes();
  const err = new DatabaseError('SELECT * FROM users WHERE id = 1 failed: connection reset');
  errorHandler(err, req, res, () => {});
  assert(res.statusCode === 500, 'a DatabaseError produces a 500');
  assert(res.body.error.message === GENERIC_MESSAGE, 'a DatabaseError never leaks its internal message to the caller');
  assert(!res.body.error.message.includes('SELECT'), 'the raw SQL/internal detail is not present anywhere in the response');
}

// A raw, non-AppError bug -> 500, generic message, INTERNAL_ERROR code
{
  const { req, res } = mockReqRes();
  errorHandler(rawBug, req, res, () => {});
  assert(res.statusCode === 500, 'an unexpected raw error produces a 500');
  assert(res.body.error.code === 'INTERNAL_ERROR', 'an unexpected raw error gets the generic INTERNAL_ERROR code');
  assert(res.body.error.message === GENERIC_MESSAGE, "an unexpected raw error's real message is never returned to the caller");
}

fs.rmSync(tmpLogDir, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
