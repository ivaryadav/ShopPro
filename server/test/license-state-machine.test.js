/**
 * Licensing regression test — expiry state machine (Phases 5, 6, 11).
 * ACTIVE -> READ_ONLY (on expiry) -> SUSPENDED (30 days later) -> ARCHIVED
 * (365 days later). See docs/architecture-review/LicenseArchitecture.md.
 *
 * Uses LICENSE_SWEEP_INTERVAL_MS (env-configurable, see server/local.js) to
 * shrink the sweep interval and backdates timestamps directly in the test's
 * own SQLite handle to fast-forward transitions — same technique
 * wave1-sessions.test.js/concurrency-stress.test.js already use for races.
 *
 * Usage:  node server/test/license-state-machine.test.js
 */
'use strict';

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
    let data = {};
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, data };
  };
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function main() {
  console.log('Licensing regression: expiry state machine (Phases 5, 6, 11)');
  console.log('Starting isolated test server (fast sweep interval)...');
  const srv = await startTestServer({ envOverrides: { LICENSE_SWEEP_INTERVAL_MS: '300' } });
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    const signup = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Sweep Test Shop', ownerName: 'Owner Name', mobile: '9856341270', email: 'sweep@example.com', pin: '9999',
    }});
    const tenantId = signup.data.tenantId;
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(tenantId);
    await req('POST', '/api/admin/registrations/' + tenantId + '/approve', { admin: true, body: {} });

    const login = await req('POST', '/api/auth/login', { body: { mobile: '9856341270', pin: '9999' } });
    assert(login.status === 200, 'owner can log in once ACTIVE');
    const token = login.data.token;

    const readBefore = await req('GET', '/api/data', { token });
    assert(readBefore.status === 200, 'reads succeed while ACTIVE');
    const writeBefore = await req('PUT', '/api/data', { token, body: { data: { hello: 'world' }, expectedVersion: 1 } });
    assert(writeBefore.status === 200, 'writes succeed while ACTIVE');

    // ── ACTIVE -> READ_ONLY (expiry passed) ─────────────────────────────────
    db.prepare("UPDATE tenant_licenses SET expires_at = datetime('now', '-1 day') WHERE tenant_id = ?").run(tenantId);
    await sleep(600);
    const lic1 = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(lic1.status === 'READ_ONLY', 'sweep transitions an expired ACTIVE tenant to READ_ONLY');

    const readAfterExpiry = await req('GET', '/api/data', { token });
    assert(readAfterExpiry.status === 200, 'READ_ONLY still allows viewing data (Phase 6: "Allow: View Data")');
    const writeAfterExpiry = await req('PUT', '/api/data', { token, body: { data: { hello: 'blocked' }, expectedVersion: 2 } });
    assert(writeAfterExpiry.status === 403, 'READ_ONLY blocks new writes (Phase 6: "Block: New invoices / Inventory updates / Editing")');
    assert(writeAfterExpiry.data.licenseStatus === 'READ_ONLY', 'the write-block response reports the licenseStatus');
    const addStaffBlocked = await req('POST', '/api/auth/add-staff', { token, body: { displayName: 'Staff', mobile: '9111111199', pin: '1234' } });
    assert(addStaffBlocked.status === 403, 'READ_ONLY also blocks adding staff (a write)');

    const readOnlyHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'STATUS_CHANGED' AND to_status = 'READ_ONLY'").get(tenantId);
    assert(!!readOnlyHistory, 'a STATUS_CHANGED (ACTIVE -> READ_ONLY) history event was logged');

    const stillLoggedIn = await req('GET', '/api/license/status', { token });
    assert(stillLoggedIn.status === 200 && stillLoggedIn.data.license.status === 'READ_ONLY', 'license/status reports READ_ONLY (used to drive the client banner)');

    // ── READ_ONLY -> SUSPENDED (30 days later) ──────────────────────────────
    db.prepare("UPDATE tenant_licenses SET read_only_since = datetime('now', '-31 days') WHERE tenant_id = ?").run(tenantId);
    await sleep(600);
    const lic2 = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(lic2.status === 'SUSPENDED', 'sweep transitions a 30+ day READ_ONLY tenant to SUSPENDED');

    const sessionsAfterSuspend = db.prepare("SELECT COUNT(*) c FROM user_sessions WHERE tenant_id = ? AND status = 'active'").get(tenantId);
    assert(sessionsAfterSuspend.c === 0, 'the sweep kills all sessions when auto-suspending (Phase 6: "Kill sessions")');

    const readWithOldToken = await req('GET', '/api/data', { token });
    assert(readWithOldToken.status === 401, "the old token is rejected outright once its session is killed — stronger than a 403, can't even re-request with it");

    // A fresh login is still technically possible after suspension (login
    // itself checks only mobile+PIN) — this is the realistic path that
    // actually exercises requireLicenseRead's SUSPENDED branch and message.
    const reLogin = await req('POST', '/api/auth/login', { body: { mobile: '9856341270', pin: '9999' } });
    assert(reLogin.status === 200, 'a SUSPENDED tenant can still authenticate (login has no license gate)');
    const readWithNewToken = await req('GET', '/api/data', { token: reLogin.data.token });
    assert(readWithNewToken.status === 403, 'but any subsequent read with the new session is blocked — SUSPENDED blocks reads too, not just writes');
    assert(readWithNewToken.data.error.includes('Subscription expired'), 'SUSPENDED shows the exact spec-required message: "Subscription expired. Please contact administrator."');

    const suspendedHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'STATUS_CHANGED' AND to_status = 'SUSPENDED'").get(tenantId);
    assert(!!suspendedHistory, 'a STATUS_CHANGED (READ_ONLY -> SUSPENDED) history event was logged');

    // ── SUSPENDED -> ARCHIVED (365 days later) ──────────────────────────────
    db.prepare("UPDATE tenant_licenses SET suspended_since = datetime('now', '-366 days') WHERE tenant_id = ?").run(tenantId);
    await sleep(600);
    const lic3 = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(lic3.status === 'ARCHIVED', 'sweep transitions a 365+ day SUSPENDED tenant to ARCHIVED');

    const tenantStillExists = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
    assert(!!tenantStillExists, 'archived tenant row is NOT deleted (Rule #1: never delete customer data)');
    const dataStillExists = db.prepare('SELECT data FROM tenant_data WHERE tenant_id = ?').get(tenantId);
    assert(dataStillExists && JSON.parse(dataStillExists.data).hello === 'world', "archived tenant's actual saved data is untouched — still the legitimate save from before expiry");

    const archivedHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'STATUS_CHANGED' AND to_status = 'ARCHIVED'").get(tenantId);
    assert(!!archivedHistory, 'a STATUS_CHANGED (SUSPENDED -> ARCHIVED) history event was logged');

  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
