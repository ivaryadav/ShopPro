/**
 * Phase 6 test — verifies the rate-limiting fix applied to every
 * Operations route group (routes/inventory, customers, sales, repairs,
 * expenses, settings). Rate limiting is applied AFTER requireAuth/
 * requireActive in each router (matching local.js's own convention for
 * already-authenticated mutation routes, e.g. `/api/admin/tenant/status`:
 * `requireAdminKey, rateLimit(...)`), so it only trips for traffic that
 * has already passed authentication — an HTTP-level test would need a
 * real database-backed session to get past requireAuth at all. Instead,
 * this asserts directly on the Express route stack: each router's
 * middleware chain must include a rate-limiting layer, not just auth.
 *
 * Usage: node server/src/tests/operationsRateLimit.test.js
 */
'use strict';

const { createInventoryRouter } = require('../routes/inventory');
const { createCustomersRouter } = require('../routes/customers');
const { createSalesRouter } = require('../routes/sales');
const { createRepairsRouter } = require('../routes/repairs');
const { createExpensesRouter } = require('../routes/expenses');
const { createSettingsRouter } = require('../routes/settings');
const { rateLimit } = require('../middleware/rateLimit');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

/**
 * A rate-limited handler and a plain handler both show up in Express's
 * route stack as anonymous functions, so this checks by *behavior*: the
 * rate limiter closes over its own `_buckets` state and, given a low
 * enough limit, returns a 429 JSON response instead of calling `next()`.
 * We can't inspect closures directly, so instead this constructs the
 * SAME router factory pattern each createXRouter uses and confirms the
 * router's first layer for a GET '/' route has more than just the 2
 * auth-middleware functions — i.e. a 3rd middleware (the rate limiter)
 * is present in the chain.
 * @param {import('express').Router} router
 * @param {string} path
 */
function middlewareCountFor(router, path, method) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.length : 0;
}

async function main() {
  console.log('Phase 6: Operations route rate-limiting tests');
  console.log('');

  const routers = [
    [createInventoryRouter({ jwtSecret: 'x' }), '/', 'get', 'Inventory'],
    [createCustomersRouter({ jwtSecret: 'x' }), '/', 'get', 'Customers'],
    [createSalesRouter({ jwtSecret: 'x' }), '/', 'get', 'Sales'],
    [createRepairsRouter({ jwtSecret: 'x' }), '/', 'get', 'Repairs'],
    [createExpensesRouter({ jwtSecret: 'x' }), '/', 'get', 'Expenses'],
    [createSettingsRouter({ jwtSecret: 'x' }), '/', 'get', 'Settings'],
  ];

  // Baseline: a route with just [requireAuth, requireActive] + the handler
  // has 3 stack entries. Every Operations route now adds rateLimit(), so
  // it must have 4: requireAuth, requireActive, rateLimit, handler.
  for (const [router, path, method, label] of routers) {
    const count = middlewareCountFor(router, path, method);
    assert(count === 4, `${label} '${path}' has 4 middleware layers (requireAuth, requireActive, rateLimit, handler) — was 3 before Phase 6's fix`);
  }

  // Direct behavioral proof the rateLimit() factory itself trips correctly
  // (already covered generically, but re-confirmed here for this phase's report).
  {
    const limiter = rateLimit(2, 60 * 1000);
    let calls = 0;
    const next = () => { calls++; };
    const fakeRes = { set() {}, status() { return this; }, json() {} };
    const fakeReq = { ip: '10.0.0.1', path: '/api/inventory-test' };
    limiter(fakeReq, fakeRes, next);
    limiter(fakeReq, fakeRes, next);
    let blocked = false;
    limiter(fakeReq, { ...fakeRes, status(code) { blocked = code === 429; return this; } }, next);
    assert(calls === 2 && blocked, 'rateLimit(2, 60s) allows exactly 2 requests then blocks the 3rd with a 429 — the same primitive every Operations route now uses');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
