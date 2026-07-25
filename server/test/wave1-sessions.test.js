/**
 * Wave 1 regression test — session architecture.
 * See docs/architecture-review/SessionArchitecture.md for the design this verifies.
 *
 * Runs against an isolated, disposable test server + SQLite file (see
 * server/test/testServer.js) — never touches server/shoperpro.db or the
 * production JWT_SECRET.
 *
 * Usage:  node server/test/wave1-sessions.test.js
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const jwt = require(path.join(__dirname, '..', 'node_modules', 'jsonwebtoken'));
const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function reqFactory(baseUrl, adminKey) {
  return async function (method, path_, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (typeof body === 'object' && body && body.__adminKey) { headers['X-Admin-Key'] = adminKey; delete body.__adminKey; }
    const r = await fetch(baseUrl + path_, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, data };
  };
}

async function main() {
  console.log('Wave 1 regression: session architecture');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const SHOP_NAME = 'Wave1 Test Shop';
  const MOBILE = '9246810000';
  const db = new Database(srv.dbPath);

  try {
    // Setup
    const gen = await req('POST', '/api/admin/generate-key', null, { __adminKey: true, plan: 'monthly' });
    const reg = await req('POST', '/api/auth/register', null, {
      shopName: SHOP_NAME, ownerName: 'Wave1 Tester', mobile: MOBILE, pin: '246810', licenseKey: gen.data.key,
    });
    assert(reg.status === 201, 'registration succeeds');
    assert(!!reg.data.token && !!reg.data.refreshToken, 'register response includes both an access token and a refresh token');
    const tenantId = db.prepare('SELECT id FROM tenants WHERE shop_name = ?').get(SHOP_NAME)?.id;

    let accessToken = reg.data.token;
    let refreshToken = reg.data.refreshToken;

    const sessionRow = db.prepare('SELECT * FROM user_sessions WHERE tenant_id = ?').get(tenantId);
    assert(!!sessionRow, 'a user_sessions row was created at registration');
    assert(sessionRow.status === 'active', 'new session status is active');
    assert(!!sessionRow.refresh_token_hash, 'refresh token is stored as a hash, not raw');
    assert(sessionRow.refresh_token_hash !== refreshToken, 'stored hash does not equal the raw refresh token');

    // 1. Access token works
    const d1 = await req('GET', '/api/data', accessToken);
    assert(d1.status === 200, 'fresh access token authenticates GET /api/data');

    // 2. Heartbeat updates last_activity + current_page
    const hb = await req('POST', '/api/auth/heartbeat', accessToken, { currentPage: 'inventory' });
    assert(hb.status === 200, 'heartbeat endpoint accepts the access token');
    const afterHb = db.prepare('SELECT current_page FROM user_sessions WHERE session_id = ?').get(sessionRow.session_id);
    assert(afterHb.current_page === 'inventory', 'heartbeat persisted the reported current_page');

    // 3. Owner can list active sessions
    const list = await req('GET', '/api/auth/sessions', accessToken);
    assert(list.status === 200 && list.data.sessions.length === 1, 'owner can list active sessions for their tenant');

    // 4. Refresh rotates both tokens
    const ref1 = await req('POST', '/api/auth/refresh', null, { refreshToken });
    assert(ref1.status === 200, 'refresh succeeds with a valid refresh token');
    assert(ref1.data.token !== accessToken, 'refresh issues a new access token, not the same one');
    assert(ref1.data.refreshToken !== refreshToken, 'refresh issues a new refresh token, not the same one');
    const oldRefreshToken = refreshToken;
    accessToken = ref1.data.token; refreshToken = ref1.data.refreshToken;

    // 5. Reusing the just-rotated-away token WITHIN the grace window succeeds
    //    without rotating again — this is the fix for the multi-tab race found
    //    during review (two tabs share localStorage and can race to refresh
    //    with the same token; without this, the losing tab got a spurious full
    //    logout). It must NOT hand back a second new refresh token (there's
    //    nothing to hand back — the real one already went to the "other tab").
    const ref2 = await req('POST', '/api/auth/refresh', null, { refreshToken: oldRefreshToken });
    assert(ref2.status === 200, 'reusing an already-rotated token within the grace window succeeds (prevents a same-device multi-tab spurious logout)');
    assert(ref2.data.refreshToken === null, 'the grace-window response does not hand back a second new refresh token');
    const graceAccessCheck = await req('GET', '/api/data', ref2.data.token);
    assert(graceAccessCheck.status === 200, 'the access token issued from a grace-window hit is fully valid');

    // 5b. The SAME old token, reused again AFTER the grace window has passed,
    //     must be rejected — this is the actual theft-detection case, and the
    //     grace window must not have weakened it.
    db.prepare("UPDATE user_sessions SET refresh_rotated_at = datetime('now','-5 minutes') WHERE session_id = ?").run(sessionRow.session_id);
    const ref3 = await req('POST', '/api/auth/refresh', null, { refreshToken: oldRefreshToken });
    assert(ref3.status === 401, 'reusing an already-rotated token AFTER the grace window has elapsed is still rejected (theft detection intact)');

    // 6. New access token works for authenticated calls
    const d2 = await req('GET', '/api/data', accessToken);
    assert(d2.status === 200, 'the newly-issued access token authenticates successfully');

    // 7. Revoking the session immediately kills the (still unexpired) access token
    const revoke = await req('POST', '/api/auth/sessions/' + sessionRow.session_id + '/revoke', accessToken, {});
    assert(revoke.status === 200, 'owner can revoke a session via the sessions endpoint');
    const d3 = await req('GET', '/api/data', accessToken);
    assert(d3.status === 401, 'a cryptographically-valid access token is rejected once its session is revoked — this is the entire point of Wave 1');

    // 8. Cross-tenant protection: register a SECOND, independent tenant in this
    //    same isolated DB and confirm tenant A cannot revoke tenant B's session.
    const relogin = await req('POST', '/api/auth/login', null, { mobile: MOBILE, pin: '246810' });
    assert(relogin.status === 200, 're-login works after the previous session was revoked (revocation is per-session, not per-account)');
    accessToken = relogin.data.token;

    const gen2 = await req('POST', '/api/admin/generate-key', null, { __adminKey: true, plan: 'yearly' });
    const reg2 = await req('POST', '/api/auth/register', null, {
      shopName: 'Wave1 Test Shop 2', ownerName: 'Tester2', mobile: '9246820000', pin: '135791', licenseKey: gen2.data.key,
    });
    const otherTenantId = db.prepare('SELECT id FROM tenants WHERE shop_name = ?').get('Wave1 Test Shop 2')?.id;
    const otherSession = db.prepare('SELECT session_id FROM user_sessions WHERE tenant_id = ?').get(otherTenantId);
    assert(!!otherSession, 'second independent tenant + session created for the cross-tenant check');
    const crossAttempt = await req('POST', '/api/auth/sessions/' + otherSession.session_id + '/revoke', accessToken, {});
    assert(crossAttempt.status === 404, 'cannot revoke a session belonging to a different tenant (404, not leaked as 200/403)');
    const otherStillActive = db.prepare("SELECT status FROM user_sessions WHERE session_id = ?").get(otherSession.session_id);
    assert(otherStillActive.status === 'active', "the other tenant's session is untouched by the failed cross-tenant attempt");

    // 9. Logout revokes the session tied to the presented token
    const beforeLogoutCount = db.prepare("SELECT COUNT(*) c FROM user_sessions WHERE tenant_id=? AND status='active'").get(tenantId).c;
    const logout = await req('POST', '/api/auth/logout', accessToken, {});
    assert(logout.status === 200, 'logout endpoint succeeds');
    const afterLogoutCount = db.prepare("SELECT COUNT(*) c FROM user_sessions WHERE tenant_id=? AND status='active'").get(tenantId).c;
    assert(afterLogoutCount === beforeLogoutCount - 1, 'logout revokes exactly the one active session tied to the token used');

    // 10. Backward compatibility: an old-shape JWT (no `sid`, pre-Wave-1) must
    //     still authenticate — it has nothing to check a session for, so it's
    //     accepted on signature+expiry alone, same as before this wave.
    const legacyToken = jwt.sign(
      { userId: sessionRow.user_id, tenantId, role: 'owner', shopName: SHOP_NAME },
      srv.jwtSecret, { expiresIn: '7d' }
    );
    const legacyCheck = await req('GET', '/api/data', legacyToken);
    assert(legacyCheck.status === 200, 'a legacy (pre-Wave-1, no session id) token still authenticates — old sessions are not force-broken by this deploy');

  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
