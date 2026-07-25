/**
 * Licensing regression test — self-service registration (Phase 1).
 * See docs/architecture-review/RegistrationFlow.md for the design this verifies.
 *
 * Runs against an isolated, disposable test server + SQLite file (see
 * server/test/testServer.js) — never touches server/shoperpro.db.
 *
 * Usage:  node server/test/license-registration.test.js
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

async function main() {
  console.log('Licensing regression: self-service registration (Phase 1)');
  const good = {
    shopName: 'Kumar Mobile Repair', ownerName: 'Suresh Kumar', mobile: '9812345670',
    email: 'suresh@example.com', pin: '1234', requestedPlan: 'PREMIUM',
    requestedDevicesBucket: '3-5', requestedModules: ['Billing', 'Repair', 'Reports'],
  };

  // POST /api/auth/signup is rate-limited to 5 requests / 10 min per IP+path
  // (same posture as the legacy /api/auth/register) — split across two
  // isolated servers so no single test-file run trips that limit itself.
  console.log('Starting isolated test server (validation cases)...');
  const srv1 = await startTestServer();
  console.log('Isolated server up: ' + srv1.baseUrl);
  try {
    const req1 = reqFactory(srv1.baseUrl, srv1.adminKey);

    const missing = await req1('POST', '/api/auth/signup', { body: { shopName: 'X' } });
    assert(missing.status === 400, 'signup rejects missing required fields (400)');

    const badMobile = await req1('POST', '/api/auth/signup', { body: { ...good, mobile: '123' } });
    assert(badMobile.status === 400, 'signup rejects a too-short mobile number');

    const badPin = await req1('POST', '/api/auth/signup', { body: { ...good, mobile: '9812345671', pin: '12' } });
    assert(badPin.status === 400, 'signup rejects a too-short PIN');

    const badEmail = await req1('POST', '/api/auth/signup', { body: { ...good, mobile: '9812345672', email: 'not-an-email' } });
    assert(badEmail.status === 400, 'signup rejects an invalid email address');
  } finally {
    srv1.stop();
  }

  console.log('\nStarting isolated test server (behavior cases)...');
  const srv2 = await startTestServer();
  console.log('Isolated server up: ' + srv2.baseUrl + '  |  DB: ' + srv2.dbPath);
  console.log('');
  const req2 = reqFactory(srv2.baseUrl, srv2.adminKey);
  const db = new Database(srv2.dbPath);

  try {
    // Successful signup
    const signup = await req2('POST', '/api/auth/signup', { body: good });
    assert(signup.status === 201, 'signup succeeds with all required fields (201)');
    assert(signup.data.status === 'PENDING_APPROVAL', 'signup response reports PENDING_APPROVAL');
    assert(typeof signup.data.tenantId === 'number', 'signup response includes a tenantId');
    assert(signup.data.token === undefined, 'signup does NOT issue a JWT — the account is not usable until approved');

    const tenantId = signup.data.tenantId;
    const tenantRow = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
    assert(!!tenantRow, 'a tenants row was created');

    const licRow = db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(!!licRow, 'a tenant_licenses row was created');
    assert(licRow.status === 'PENDING_APPROVAL', 'tenant_licenses.status is PENDING_APPROVAL');
    assert(licRow.requested_plan_code === 'PREMIUM', 'requested_plan_code matches what the customer selected');
    assert(licRow.requested_devices_bucket === '3-5', 'requested_devices_bucket is captured');
    assert(JSON.parse(licRow.requested_modules).length === 3, 'requested_modules (capture-only) is stored as a JSON array');

    const dataRow = db.prepare('SELECT * FROM tenant_data WHERE tenant_id = ?').get(tenantId);
    assert(!!dataRow && dataRow.data === '{}', 'an empty tenant_data row was created, matching the legacy register flow shape');

    const userRow = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND role = ?').get(tenantId, 'owner');
    assert(!!userRow, 'an owner user was created');
    assert(!!userRow.email_verify_token_hash && !!userRow.email_verify_expires, 'a hashed email-verify token + expiry was stored');
    assert(!userRow.email_verified_at, 'email is not verified yet at signup time');

    const historyRow = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'REGISTERED'").get(tenantId);
    assert(!!historyRow, 'a REGISTERED license_history event was logged');

    // Duplicate mobile is rejected
    const dup = await req2('POST', '/api/auth/signup', { body: { ...good, shopName: 'Another Shop', mobile: good.mobile, email: 'other@example.com' } });
    assert(dup.status === 409, 'signup rejects a mobile number that is already registered (409)');

    // requestedPlan defaults to TRIAL if omitted
    const noPlan = await req2('POST', '/api/auth/signup', { body: { ...good, mobile: '9812345699', email: 'noplan@example.com', requestedPlan: undefined } });
    assert(noPlan.status === 201, 'signup succeeds without a requestedPlan');
    const noPlanLic = db.prepare('SELECT plan_code FROM tenant_licenses WHERE tenant_id = ?').get(noPlan.data.tenantId);
    assert(noPlanLic.plan_code === 'TRIAL', 'omitting requestedPlan defaults the tenant to the TRIAL plan');

  } finally {
    db.close();
    srv2.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
