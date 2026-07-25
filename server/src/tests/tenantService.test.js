/**
 * Phase 2 test — services/tenantService.js. Verifies assertActive()
 * matches local.js's requireActive() exactly (minus the license_expiry
 * check — Licensing domain, out of scope, documented in the service's own
 * header). No live database needed — tenantRepository is monkey-patched.
 *
 * Usage: node server/src/tests/tenantService.test.js
 */
'use strict';

const tenantRepository = require('../repositories/tenantRepository');
const tenantService = require('../services/tenantService');
const { AuthorizationError, NotFoundError } = require('../errors');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
async function assertThrowsWith(fn, ErrorClass, expectedMessage, label) {
  try {
    await fn();
    failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label + ' (did not throw)');
  } catch (e) {
    const ok = e instanceof ErrorClass && (!expectedMessage || e.message === expectedMessage);
    if (ok) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
    else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label + ` (got ${e.constructor.name}: ${e.message})`); }
  }
}

async function main() {
  console.log('Phase 2: tenantService.js tests');
  console.log('');

  const original = tenantRepository.findStatusById;
  const FAKE = {
    1: { status: 'active', suspend_reason: '' },
    2: { status: 'paused', suspend_reason: 'Payment overdue' },
    3: { status: 'terminated', suspend_reason: 'Fraud investigation' },
  };
  tenantRepository.findStatusById = async (id) => FAKE[id] || null;

  try {
    await tenantService.assertActive(1); // should not throw
    passed++; console.log('  \x1b[32m✓\x1b[0m an active tenant passes assertActive() without throwing');

    await assertThrowsWith(
      () => tenantService.assertActive(2), AuthorizationError, 'Account paused',
      "a paused tenant throws AuthorizationError('Account paused') — matches local.js:440 exactly"
    );
    try {
      await tenantService.assertActive(2);
    } catch (e) {
      assert(e.details.status === 'paused' && e.details.reason === 'Payment overdue', 'the paused error carries status+reason details, matching local.js\'s response shape');
    }

    await assertThrowsWith(
      () => tenantService.assertActive(3), AuthorizationError, 'Account terminated',
      "a terminated tenant throws AuthorizationError('Account terminated') — matches local.js:441 exactly"
    );

    await assertThrowsWith(
      () => tenantService.assertActive(999), NotFoundError, 'Tenant not found',
      "a nonexistent tenant throws NotFoundError('Tenant not found') — matches local.js:439 exactly"
    );
  } finally {
    tenantRepository.findStatusById = original;
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
