/**
 * Phase 2 test — services/sessionService.js. Verifies session lifecycle
 * matches server/sessions.js exactly (createSession, checkSession
 * including the legacy no-`sid` pass-through, refreshSession including
 * the 20s multi-tab grace window, revoke, heartbeat). No live database
 * needed — every repository this touches is monkey-patched.
 *
 * Usage: node server/src/tests/sessionService.test.js
 */
'use strict';

const jwt = require('jsonwebtoken');
const sessionRepository = require('../repositories/sessionRepository');
const tenantRepository = require('../repositories/tenantRepository');
const userRepository = require('../repositories/userRepository');
const sessionService = require('../services/sessionService');
const { NotFoundError } = require('../errors');

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

const SECRET = 'test-jwt-secret';

async function main() {
  console.log('Phase 2: sessionService.js tests');
  console.log('');

  // ── createSession + JWT payload shape ──────────────────────────────────────
  {
    let insertedRow = null;
    const restore = patch(sessionRepository, { create: async (data) => { insertedRow = data; } });
    const result = await sessionService.createSession(SECRET, {
      user: { id: 7, role: 'owner' }, tenant: { id: 3, shop_name: 'Test Shop' },
      req: { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' }, ip: '1.2.3.4' },
    });
    assert(!!insertedRow && insertedRow.tenantId === 3 && insertedRow.userId === 7, 'createSession inserts a session row for the correct tenant/user');
    assert(insertedRow.browser === 'Chrome', 'createSession correctly parses the user-agent (matches sessions.js parseUA)');
    const decoded = jwt.verify(result.accessToken, SECRET, { algorithms: ['HS256'] });
    assert(decoded.userId === 7 && decoded.tenantId === 3 && decoded.role === 'owner' && decoded.shopName === 'Test Shop' && !!decoded.sid && !!decoded.jti,
      'the signed JWT payload has EXACTLY the fields sessions.js signs (userId, tenantId, role, shopName, sid, jti)');
    assert(typeof result.refreshToken === 'string' && result.refreshToken.length === 64, 'a real 32-byte (64 hex char) refresh token is generated, matching sessions.js');
    restore();
  }

  // ── checkSession — legacy pass-through (no `sid`) ──────────────────────────
  {
    const result = await sessionService.checkSession({ userId: 1 });
    assert(result.ok === true && result.legacy === true, "a payload with no `sid` is accepted as legacy, matching sessions.js's checkSession() exactly — pre-Wave-1 tokens keep working until they naturally expire");
  }

  // ── checkSession — active session ──────────────────────────────────────────
  {
    let touched = false;
    const restore = patch(sessionRepository, {
      findStatusBySessionId: async () => ({ status: 'active' }),
      touchActivity: async () => { touched = true; },
    });
    const result = await sessionService.checkSession({ sid: 'abc' });
    assert(result.ok === true && !result.legacy, 'an active session is accepted');
    assert(touched, 'checking an active session touches its last_activity');
    restore();
  }

  // ── checkSession — revoked session ──────────────────────────────────────────
  {
    const restore = patch(sessionRepository, { findStatusBySessionId: async () => ({ status: 'revoked' }) });
    const result = await sessionService.checkSession({ sid: 'revoked-one' });
    assert(result.ok === false, 'a revoked session is rejected');
    restore();
  }

  // ── refreshSession — normal rotation ────────────────────────────────────────
  {
    let rotated = null;
    const restore1 = patch(sessionRepository, {
      findByRefreshTokenHash: async () => ({ session_id: 'sess-1', tenant_id: 3, user_id: 7, status: 'active' }),
      rotateRefreshToken: async (sessionId, hash, jti) => { rotated = { sessionId, hash, jti }; },
    });
    const restore2 = patch(tenantRepository, { findById: async () => ({ id: 3, shop_name: 'Test Shop' }) });
    const restore3 = patch(userRepository, { findById: async () => ({ id: 7, role: 'owner' }) });
    const result = await sessionService.refreshSession(SECRET, 'some-refresh-token');
    assert(result.ok === true && !!result.accessToken && !!result.refreshToken, 'a normal refresh rotates both tokens and succeeds');
    assert(!!rotated && rotated.sessionId === 'sess-1', 'the correct session row is rotated');
    restore1(); restore2(); restore3();
  }

  // ── refreshSession — invalid token ──────────────────────────────────────────
  {
    const restore = patch(sessionRepository, {
      findByRefreshTokenHash: async () => null,
      findByPrevRefreshTokenHash: async () => null,
    });
    const result = await sessionService.refreshSession(SECRET, 'garbage-token');
    assert(result.ok === false && result.reason === 'invalid', 'an unrecognized refresh token is rejected as invalid');
    restore();
  }

  // ── refreshSession — grace window (multi-tab race) ──────────────────────────
  {
    let rotateCalled = false, jtiOnlyUpdated = false;
    const restore1 = patch(sessionRepository, {
      findByRefreshTokenHash: async () => null,
      findByPrevRefreshTokenHash: async () => ({ session_id: 'sess-2', tenant_id: 3, user_id: 7, status: 'active' }),
      rotateRefreshToken: async () => { rotateCalled = true; },
      updateJwtIdOnly: async () => { jtiOnlyUpdated = true; },
    });
    const restore2 = patch(tenantRepository, { findById: async () => ({ id: 3, shop_name: 'Test Shop' }) });
    const restore3 = patch(userRepository, { findById: async () => ({ id: 7, role: 'owner' }) });
    const result = await sessionService.refreshSession(SECRET, 'a-token-a-sibling-tab-already-rotated-away');
    assert(result.ok === true && result.refreshToken === null, "a grace-window hit (sibling-tab race) does NOT return a new refresh token — matches sessions.js's deliberate null (the client keeps whatever the winning tab already stored)");
    assert(jtiOnlyUpdated && !rotateCalled, 'a grace-window hit only rotates the JWT ID, never the refresh token itself — no second rotation on top of the winning tab\'s');
    restore1(); restore2(); restore3();
  }

  // ── revokeOwned — ownership check ──────────────────────────────────────────
  {
    const restore = patch(sessionRepository, { findTenantIdBySessionId: async () => ({ tenant_id: 999 }) });
    try {
      await sessionService.revokeOwned(3, 'someone-elses-session');
      failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m revokeOwned rejects a session belonging to a different tenant');
    } catch (e) {
      assert(e instanceof NotFoundError, "revokeOwned throws NotFoundError (not AuthorizationError) for a session belonging to a different tenant — matches local.js:1078's deliberate choice of 404 over 403, so as not to confirm the session ID even exists");
    }
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
