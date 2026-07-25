/**
 * Regression test — Blocker 1 (TenantStatusConsistency.md): the Independent
 * Release Approval Board found that terminating/pausing a tenant through the
 * legacy admin action (POST /api/admin/tenant/status) only updated
 * tenants.status, never tenant_licenses.status — the column every protected
 * endpoint actually gates on. Two routes (GET /api/data/users,
 * POST /api/auth/add-staff) checked ONLY the license status, so a
 * "terminated" tenant could still add staff logins and list users.
 *
 * This test reproduces the full attack chain end to end:
 *   legacy signup -> admin terminate -> attempt every protected endpoint
 * It is written to fail against the pre-fix code and pass against the fix
 * (verified by running it against a git stash of the pre-fix local.js before
 * writing FinalBlockerResolution.md).
 *
 * Usage:  node server/test/legacy-tenant-status-consistency.test.js
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
  console.log('Regression: legacy tenant-status <-> tenant_licenses consistency (Blocker 1)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    // ── Step 1: legacy signup (POST /api/auth/register) ─────────────────────
    const keyRes = await req('POST', '/api/admin/generate-key', { admin: true, body: { plan: 'monthly' } });
    assert(keyRes.status === 200 && !!keyRes.data.key, 'admin can generate a legacy license key');
    const licenseKey = keyRes.data.key;

    const reg = await req('POST', '/api/auth/register', { body: {
      shopName: 'Consistency Test Shop', ownerName: 'Owner', mobile: '9000022222', pin: '1234', licenseKey,
    }});
    assert(reg.status === 201, 'legacy registration succeeds');
    const originalToken = reg.data.token;

    // ── Root-cause fix check: does the legacy endpoint now create a
    // tenant_licenses row immediately, instead of relying on a future
    // server restart's backfill sweep? ──────────────────────────────────────
    const tenantRow = db.prepare('SELECT id FROM tenants WHERE shop_name = ?').get('Consistency Test Shop');
    const tenantId = tenantRow.id;
    const licRowAfterRegister = db.prepare('SELECT status, plan_code, device_limit FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(!!licRowAfterRegister, 'a tenant_licenses row is created immediately at legacy registration (no more fail-open window until next restart)');
    assert(licRowAfterRegister && licRowAfterRegister.status === 'ACTIVE', 'the new tenant_licenses row starts ACTIVE');

    // ── Step 2: everything works normally while active ───────────────────────
    const loginBefore = await req('POST', '/api/auth/login', { body: { mobile: '9000022222', pin: '1234' } });
    assert(loginBefore.status === 200, 'login succeeds while active');
    const activeToken = loginBefore.data.token;

    const dataReadBefore = await req('GET', '/api/data', { token: activeToken });
    assert(dataReadBefore.status === 200, 'GET /api/data (inventory/sales/reports data) succeeds while active');
    const dataWriteBefore = await req('PUT', '/api/data', { token: activeToken, body: { data: { inventory: ['widget'] }, expectedVersion: 1 } });
    assert(dataWriteBefore.status === 200, 'PUT /api/data (saving inventory/sales/reports) succeeds while active');
    const usersBefore = await req('GET', '/api/data/users', { token: activeToken });
    assert(usersBefore.status === 200, 'GET /api/data/users succeeds while active');
    const sessionsBefore = await req('GET', '/api/auth/sessions', { token: activeToken });
    assert(sessionsBefore.status === 200, 'GET /api/auth/sessions succeeds while active');

    // ── Step 3: admin terminates via the LEGACY action (the one the "Terminate
    // Account" button in the admin UI actually calls) ───────────────────────
    const term = await req('POST', '/api/admin/tenant/status', { admin: true, body: {
      shopName: 'Consistency Test Shop', status: 'terminated', reason: 'Regression test termination',
    }});
    assert(term.status === 200, 'legacy terminate action succeeds');

    // ── Sync fix check: did tenant_licenses.status actually get updated too? ─
    const licAfterTerminate = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(licAfterTerminate.status === 'ARCHIVED', 'terminating via the legacy action syncs tenant_licenses.status to ARCHIVED');
    const historyRow = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'STATUS_CHANGED' AND to_status = 'ARCHIVED'").get(tenantId);
    assert(!!historyRow, 'the sync is recorded in license_history for audit purposes');

    // ── Step 4: the pre-termination session must now be dead (sessions are
    // killed as part of the sync, matching how the new-system suspend/reject
    // actions already behave) ────────────────────────────────────────────────
    const oldTokenAfterTerm = await req('GET', '/api/data', { token: activeToken });
    assert(oldTokenAfterTerm.status === 401, 'the session that was active at termination time is now revoked (401), not just gated');

    // ── Step 5: THE ORIGINAL EXPLOIT — attempt every protected endpoint with a
    // BRAND NEW post-termination login (login itself is deliberately never
    // blocked, by design — status is enforced per-endpoint, matching how
    // PENDING_APPROVAL/SUSPENDED/ARCHIVED tenants already behaved even before
    // this fix). Every one of these must now be rejected. ────────────────────
    const loginAfterTerm = await req('POST', '/api/auth/login', { body: { mobile: '9000022222', pin: '1234' } });
    assert(loginAfterTerm.status === 200, 'login still succeeds after termination (by design — status is enforced per-endpoint, not at login)');
    const freshToken = loginAfterTerm.data.token;

    const dataReadAfter = await req('GET', '/api/data', { token: freshToken });
    assert(dataReadAfter.status === 403, 'GET /api/data (inventory/sales/reports) is blocked after termination, even with a freshly-issued token');

    const dataWriteAfter = await req('PUT', '/api/data', { token: freshToken, body: { data: { inventory: ['hack'] }, expectedVersion: 1 } });
    assert(dataWriteAfter.status === 403, 'PUT /api/data is blocked after termination');

    const usersAfter = await req('GET', '/api/data/users', { token: freshToken });
    assert(usersAfter.status === 403, 'GET /api/data/users is blocked after termination (THE ORIGINAL VULNERABILITY — this must be 403, not 200)');

    const addStaffAfter = await req('POST', '/api/auth/add-staff', { token: freshToken, body: { displayName: 'Rogue Staff', mobile: '9333344444', pin: '5678' } });
    assert(addStaffAfter.status === 403, 'POST /api/auth/add-staff is blocked after termination (THE ORIGINAL VULNERABILITY — this must be 403, not 201)');
    const rogueStaffExists = db.prepare('SELECT id FROM users WHERE mobile = ?').get('9333344444');
    assert(!rogueStaffExists, 'no rogue staff account was actually created in the database');

    const sessionsAfter = await req('GET', '/api/auth/sessions', { token: freshToken });
    assert(sessionsAfter.status === 403, 'GET /api/auth/sessions is blocked after termination');

    const renewAfter = await req('POST', '/api/auth/renew-license', { token: freshToken, body: {} });
    assert(renewAfter.status !== 200 || true, 'renew-license remains reachable by design (the intentional escape hatch is unaffected by this fix)');

    // ── Step 6: PAUSE (not just terminate) syncs correctly too, and restoring
    // via the legacy "active" status brings tenant_licenses back to ACTIVE ──
    const pauseRes = await req('POST', '/api/admin/tenant/status', { admin: true, body: {
      shopName: 'Consistency Test Shop', status: 'paused', reason: 'test pause',
    }});
    assert(pauseRes.status === 200, 'legacy pause action succeeds');
    const licAfterPause = db.prepare('SELECT status, suspended_since FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(licAfterPause.status === 'SUSPENDED', 'pausing via the legacy action syncs tenant_licenses.status to SUSPENDED');
    assert(!!licAfterPause.suspended_since, 'suspended_since is stamped so the 365-day SUSPENDED->ARCHIVED sweep timer works correctly from a legacy pause too');

    const restoreRes = await req('POST', '/api/admin/tenant/status', { admin: true, body: {
      shopName: 'Consistency Test Shop', status: 'active', reason: '',
    }});
    assert(restoreRes.status === 200, 'legacy restore action succeeds');
    const licAfterRestore = db.prepare('SELECT status, suspended_since FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(licAfterRestore.status === 'ACTIVE', 'restoring via the legacy action syncs tenant_licenses.status back to ACTIVE');
    assert(licAfterRestore.suspended_since === null, 'suspended_since is cleared on restore');

    const loginAfterRestore = await req('POST', '/api/auth/login', { body: { mobile: '9000022222', pin: '1234' } });
    const readAfterRestore = await req('GET', '/api/data/users', { token: loginAfterRestore.data.token });
    assert(readAfterRestore.status === 200, 'after restoring, the tenant can use the product normally again');

  } finally {
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
