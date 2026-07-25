/**
 * Licensing regression test — email verification (Phase 1, Step 5).
 * See docs/architecture-review/RegistrationFlow.md for the design this verifies.
 *
 * Usage:  node server/test/license-email-verification.test.js
 */
'use strict';

const crypto = require('crypto');
const Database = require('better-sqlite3');
const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function reqFactory(baseUrl, adminKey) {
  return async function (method, path_, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
    if (opts.admin) headers['X-Admin-Key'] = adminKey;
    const r = await fetch(baseUrl + path_, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    let data = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { data = await r.json(); } catch (_) {} }
    else { data = await r.text(); }
    return { status: r.status, data };
  };
}

async function main() {
  console.log('Licensing regression: email verification (Phase 1, Step 5)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    const signup = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Verify Test Shop', ownerName: 'Anita Sharma', mobile: '9834567890',
      email: 'anita@example.com', pin: '5678',
    }});
    assert(signup.status === 201, 'signup succeeds');
    const tenantId = signup.data.tenantId;

    // 1. Invalid/missing token
    const noToken = await req('GET', '/api/auth/verify-email');
    assert(noToken.status === 200, 'verify-email with no token still returns a page (not a crash)');
    assert(typeof noToken.data === 'string' && noToken.data.includes('missing a token'), 'verify-email with no token explains the link is invalid');

    const bogus = await req('GET', '/api/auth/verify-email?token=' + crypto.randomBytes(32).toString('hex'));
    assert(bogus.data.includes('expired or invalid'), 'verify-email with an unknown token reports expired/invalid');

    const userBefore = db.prepare('SELECT * FROM users WHERE tenant_id = ?').get(tenantId);
    assert(!userBefore.email_verified_at, 'email_verified_at is still unset after a bad token attempt');

    // 2. Expired token
    const expiredToken = crypto.randomBytes(32).toString('hex');
    const expiredHash = crypto.createHash('sha256').update(expiredToken).digest('hex');
    db.prepare("UPDATE users SET email_verify_token_hash = ?, email_verify_expires = datetime('now', '-1 hour') WHERE id = ?")
      .run(expiredHash, userBefore.id);
    const expiredAttempt = await req('GET', '/api/auth/verify-email?token=' + expiredToken);
    assert(expiredAttempt.data.includes('expired or invalid'), 'an expired token is rejected the same as an invalid one');

    // 3. Real token flow — reconstruct the plaintext token the same way signup does,
    //    since the server only ever stores its hash.
    const realToken = crypto.randomBytes(32).toString('hex');
    const realHash = crypto.createHash('sha256').update(realToken).digest('hex');
    db.prepare("UPDATE users SET email_verify_token_hash = ?, email_verify_expires = datetime('now', '+1 day') WHERE id = ?")
      .run(realHash, userBefore.id);
    const verify = await req('GET', '/api/auth/verify-email?token=' + realToken);
    assert(verify.status === 200 && verify.data.includes('Email verified'), 'a valid, unexpired token verifies successfully');

    const userAfter = db.prepare('SELECT * FROM users WHERE id = ?').get(userBefore.id);
    assert(!!userAfter.email_verified_at, 'email_verified_at is now set');
    assert(!userAfter.email_verify_token_hash && !userAfter.email_verify_expires, 'the token is cleared after use — cannot be replayed');

    const historyRow = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'EMAIL_VERIFIED'").get(tenantId);
    assert(!!historyRow, 'an EMAIL_VERIFIED license_history event was logged');

    // 4. Reusing the same (now-cleared) token fails
    const replay = await req('GET', '/api/auth/verify-email?token=' + realToken);
    assert(replay.data.includes('expired or invalid'), 'the same token cannot be used a second time');

    // 5. Resend — for an already-verified user, responds generically (no state change, no error)
    const resendVerified = await req('POST', '/api/auth/resend-verification', { body: { mobile: '9834567890' } });
    assert(resendVerified.status === 200, 'resend-verification responds 200 even for an already-verified user');
    const stillVerified = db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(userBefore.id);
    assert(!!stillVerified.email_verified_at, 'resend does not disturb an already-verified account');

    // 6. Resend — for an unknown mobile, responds identically (no user enumeration)
    const resendUnknown = await req('POST', '/api/auth/resend-verification', { body: { mobile: '9000000000' } });
    assert(resendUnknown.status === 200 && resendUnknown.data.message === resendVerified.data.message,
      'resend-verification gives an identical generic response for an unknown mobile — does not reveal whether it exists');

    // 7. Resend — for a real, unverified pending signup, actually issues a fresh token
    const signup2 = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Resend Test Shop', ownerName: 'Vikram Singh', mobile: '9834567891',
      email: 'vikram@example.com', pin: '4321',
    }});
    const user2Before = db.prepare('SELECT * FROM users WHERE tenant_id = ?').get(signup2.data.tenantId);
    const resend2 = await req('POST', '/api/auth/resend-verification', { body: { mobile: '9834567891' } });
    assert(resend2.status === 200, 'resend-verification succeeds for a real pending signup');
    const user2After = db.prepare('SELECT * FROM users WHERE id = ?').get(user2Before.id);
    assert(user2After.email_verify_token_hash !== user2Before.email_verify_token_hash, 'resend issues a brand-new token, replacing the old one');

  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
