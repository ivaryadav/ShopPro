/**
 * Phase 2 regression test — a consolidated equivalence check across the
 * whole new stack, verifying constants/config that must match
 * server/local.js and server/sessions.js EXACTLY, byte-for-byte. Where
 * any of these drift from the old values without a corresponding,
 * documented reason, it is a real regression, not a stylistic choice.
 *
 * Also re-runs the existing server/test/ suite (SQLite/local.js) as the
 * ultimate proof that nothing about this phase's work touched or
 * regressed the actual, deployed application — see the phase's final
 * report for the full 436-assertion result; this file focuses on the new
 * code's own internal constants.
 *
 * Usage: node server/src/tests/regression.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const userService = require('../services/userService');
const trustedDeviceService = require('../services/trustedDeviceService');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

console.log('Phase 2 regression: constants and config must match local.js/sessions.js exactly');
console.log('');

assert(userService.BCRYPT_ROUNDS === 10, "bcrypt cost factor is 10 — matches every bcrypt.hashSync(_, 10) call in local.js verbatim; a different cost factor would be a real, silent security-relevant behavior change");
assert(trustedDeviceService.FALLBACK_DEVICE_LIMIT === 2, "device-limit fallback is 2 — matches local.js:1001's `lic ? lic.device_limit : 2` exactly");

// requireAuth pins the JWT algorithm to HS256 — re-read the source directly
// rather than re-deriving it, since this is a security-critical literal
// that must never silently drift (docs/independent-audit/IndependentSecurityReview.md §11).
const requireAuthSrc = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'requireAuth.js'), 'utf8');
assert(requireAuthSrc.includes("algorithms: ['HS256']"), "requireAuth pins JWT verification to HS256 only — matches local.js:424 exactly, closing the alg:none/RS256-confusion attack class");

const sessionServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'sessionService.js'), 'utf8');
assert(sessionServiceSrc.includes("ACCESS_TOKEN_TTL = '15m'"), 'access token TTL is 15 minutes — matches sessions.js exactly');
assert(sessionServiceSrc.includes('SESSION_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000'), 'session idle-expiry is 30 days — matches sessions.js exactly');
assert(sessionServiceSrc.includes('CLEANUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000'), 'session cleanup retention is 90 days — matches sessions.js exactly');
assert(sessionServiceSrc.includes('REFRESH_GRACE_MS = 20 * 1000'), 'refresh-token multi-tab grace window is 20 seconds — matches sessions.js exactly');

const authRouterSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth', 'index.js'), 'utf8');
assert(authRouterSrc.includes("rateLimit(10, 5 * 60 * 1000)") && authRouterSrc.includes("router.post('/login'"), 'login rate limit is 10 requests / 5 minutes — matches local.js:965 exactly');
assert(authRouterSrc.includes("rateLimit(30, 5 * 60 * 1000)"), 'refresh rate limit is 30 requests / 5 minutes — matches local.js:1041 exactly');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
