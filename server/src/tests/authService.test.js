/**
 * Phase 2 test — services/authService.js (login orchestration). Verifies
 * the FULL login flow matches local.js's POST /api/auth/login exactly
 * (local.js:965-1037), most importantly the anti-enumeration rule: the
 * error for "no such account" and "wrong PIN" must be byte-for-byte
 * identical (docs/independent-audit/IndependentSecurityReview.md §4). No
 * live database needed — every repository this touches is monkey-patched.
 *
 * Usage: node server/src/tests/authService.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const userRepository = require('../repositories/userRepository');
const sessionRepository = require('../repositories/sessionRepository');
const authService = require('../services/authService');
const { ValidationError, AuthenticationError } = require('../errors');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function patch(mod, overrides) {
  const originals = {};
  for (const [key, fn] of Object.entries(overrides)) { originals[key] = mod[key]; mod[key] = fn; }
  return () => { for (const [key, fn] of Object.entries(originals)) mod[key] = fn; };
}

function fakeReq(headers) {
  return { headers: headers || {}, ip: '127.0.0.1' };
}

async function main() {
  console.log('Phase 2: authService.js tests');
  console.log('');

  await (async () => {
    try {
      await authService.login({ mobile: '', pin: '1234' }, fakeReq(), 'secret');
      failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m missing mobile throws ValidationError');
    } catch (e) {
      assert(e instanceof ValidationError, 'missing mobile throws ValidationError, matching local.js:968-970');
    }
  })();

  // ── Anti-enumeration: mobile not registered ────────────────────────────────
  {
    const restore = patch(userRepository, { findActiveByMobile: async () => null });
    try {
      await authService.login({ mobile: '9999999999', pin: '1234' }, fakeReq(), 'secret');
      failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m unregistered mobile throws AuthenticationError');
    } catch (e) {
      assert(
        e instanceof AuthenticationError && e.message === authService.GENERIC_LOGIN_FAILURE,
        "an unregistered mobile number produces the EXACT generic message ('Invalid mobile number or PIN.') — matches local.js:983"
      );
    }
    restore();
  }

  // ── Anti-enumeration: wrong PIN produces the IDENTICAL message ─────────────
  {
    const passwordHash = bcrypt.hashSync('correct-pin', 10);
    const restore = patch(userRepository, {
      findActiveByMobile: async () => ({ id: 1, tenant_id: 1, shop_name: 'Test Shop', role: 'owner', display_name: 'Owner', username: '9876543210', password_hash: passwordHash }),
    });
    try {
      await authService.login({ mobile: '9876543210', pin: 'wrong-pin' }, fakeReq(), 'secret');
      failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m wrong PIN throws AuthenticationError');
    } catch (e) {
      assert(
        e instanceof AuthenticationError && e.message === authService.GENERIC_LOGIN_FAILURE,
        'a WRONG PIN produces the IDENTICAL generic message as an unregistered mobile — the two cases are indistinguishable to the caller, exactly as local.js requires'
      );
    }
    restore();
  }

  // ── Successful login end-to-end (no deviceId — old client compat) ─────────
  {
    const passwordHash = bcrypt.hashSync('1234', 10);
    let lastLoginTouched = false;
    let sessionCreated = null;
    const restoreUser = patch(userRepository, {
      findActiveByMobile: async () => ({ id: 7, tenant_id: 3, shop_name: 'Real Shop', role: 'owner', display_name: 'Real Owner', username: '9876500000', password_hash: passwordHash }),
      touchLastLogin: async (id) => { lastLoginTouched = (id === 7); },
    });
    const restoreSession = patch(sessionRepository, {
      create: async (data) => { sessionCreated = data; },
    });
    const result = await authService.login({ mobile: '9876500000', pin: '1234' }, fakeReq(), 'test-secret');
    assert(lastLoginTouched, 'a successful login touches last_login, matching local.js:1019');
    assert(!!sessionCreated && sessionCreated.tenantId === 3 && sessionCreated.userId === 7, 'a real session row is created for the correct tenant/user');
    assert(result.shopName === 'Real Shop' && result.role === 'owner', "the response includes shopName/role, matching local.js's response shape");
    assert(result.licenseExpiry === null && result.licensePlan === 'monthly', "licenseExpiry/licensePlan are returned as null/'monthly' — local.js's OWN fallback values for a missing tenantInfo lookup (Licensing domain, out of scope for Phase 2), not new defaults invented here");
    assert(typeof result.token === 'string' && result.token.length > 0, 'a real JWT access token is returned');
    restoreUser(); restoreSession();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
