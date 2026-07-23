/**
 * Production-hardening regression test — prevent user enumeration
 * (Issue 3, docs/production-hardening/AuthenticationReview.md).
 *
 * Verifies POST /api/auth/login returns an IDENTICAL, generic failure for
 * "mobile not registered" and "wrong PIN for a real account" — the two
 * cases must be indistinguishable from the response alone.
 *
 * Usage:  node server/test/auth-enumeration.test.js
 */
'use strict';

const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Production-hardening regression: prevent user enumeration (Issue 3)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl);
  console.log('');

  const jsonHdr = { 'Content-Type': 'application/json' };

  try {
    // ── Set up one real, registered account ──────────────────────────────────
    let r = await fetch(srv.baseUrl + '/api/auth/signup', {
      method: 'POST', headers: jsonHdr,
      body: JSON.stringify({ shopName: 'Enum Test Shop', ownerName: 'Owner', mobile: '9822334455', email: 'enum@example.com', pin: '1357' }),
    });
    assert(r.status === 201, 'setup: signup succeeds');
    // (Left PENDING_APPROVAL deliberately — login must behave identically for
    // an unregistered mobile and a wrong PIN regardless of account status;
    // the actual PIN check happens before any license-status gate.)

    // ── Case A: mobile not registered at all ─────────────────────────────────
    r = await fetch(srv.baseUrl + '/api/auth/login', { method: 'POST', headers: jsonHdr, body: JSON.stringify({ mobile: '9000000000', pin: '1357' }) });
    const caseA = { status: r.status, body: await r.json() };

    // ── Case B: mobile IS registered, but the PIN is wrong ───────────────────
    r = await fetch(srv.baseUrl + '/api/auth/login', { method: 'POST', headers: jsonHdr, body: JSON.stringify({ mobile: '9822334455', pin: '9999' }) });
    const caseB = { status: r.status, body: await r.json() };

    assert(caseA.status === caseB.status, 'both cases return the identical HTTP status code');
    assert(caseA.body.error === caseB.body.error, 'both cases return the IDENTICAL error message — cannot distinguish "not registered" from "wrong PIN"');
    assert(!/not registered/i.test(caseA.body.error) && !/not registered/i.test(caseB.body.error), 'neither response leaks the word "registered" — no hint about account existence');
    assert(!/incorrect pin/i.test(caseA.body.error) && !/incorrect pin/i.test(caseB.body.error), 'neither response confirms the PIN specifically was wrong (would imply the account exists)');

    // ── Case C: correct mobile AND correct PIN — still works normally ───────
    // (Sanity: the generic message change must not have broken real login.)
    const userDb = require('better-sqlite3');
    const db = new userDb(srv.dbPath);
    const tenantRow = db.prepare("SELECT id FROM tenants WHERE shop_name = 'Enum Test Shop'").get();
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(tenantRow.id);
    await fetch(srv.baseUrl + '/api/admin/registrations/' + tenantRow.id + '/approve', { method: 'POST', headers: { 'X-Admin-Key': srv.adminKey, 'Content-Type': 'application/json' }, body: '{}' });
    r = await fetch(srv.baseUrl + '/api/auth/login', { method: 'POST', headers: jsonHdr, body: JSON.stringify({ mobile: '9822334455', pin: '1357' }) });
    const caseC = await r.json();
    assert(r.status === 200 && !!caseC.token, 'the correct mobile+PIN combination still logs in successfully — the fix only changed the failure message, not the actual check');
    db.close();

  } finally {
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
