/**
 * Licensing regression test — manual admin suspend/reactivate/kill-sessions
 * (Phase 9). See docs/architecture-review/AdminOperations.md.
 *
 * Usage:  node server/test/license-suspension.test.js
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
  console.log('Licensing regression: manual suspend / reactivate / kill-sessions (Phase 9)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    const signup = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Suspend Test Shop', ownerName: 'Owner Name', mobile: '9889562370', email: 'suspend@example.com', pin: '3456',
    }});
    const tenantId = signup.data.tenantId;
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(tenantId);
    await req('POST', '/api/admin/registrations/' + tenantId + '/approve', { admin: true, body: {} });

    const login = await req('POST', '/api/auth/login', { body: { mobile: '9889562370', pin: '3456' } });
    const token = login.data.token;
    const before = await req('GET', '/api/data', { token });
    assert(before.status === 200, 'reads succeed while ACTIVE');

    // ── Manual suspend ────────────────────────────────────────────────────
    const suspend = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/suspend', { admin: true, body: { reason: 'payment failed' } });
    assert(suspend.status === 200, 'admin can manually suspend a tenant');
    const licAfterSuspend = db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(licAfterSuspend.status === 'SUSPENDED', 'tenant_licenses.status is now SUSPENDED');
    assert(!!licAfterSuspend.suspended_since, 'suspended_since is stamped');

    const sessionCount = db.prepare("SELECT COUNT(*) c FROM user_sessions WHERE tenant_id = ? AND status = 'active'").get(tenantId).c;
    assert(sessionCount === 0, 'manual suspend kills all active sessions immediately');
    const oldTokenBlocked = await req('GET', '/api/data', { token });
    assert(oldTokenBlocked.status === 401, 'the previously-issued token is rejected once its session is killed');

    const suspendHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'STATUS_CHANGED' AND to_status = 'SUSPENDED'").get(tenantId);
    assert(!!suspendHistory && suspendHistory.detail === 'payment failed', 'the suspend reason is recorded in license_history');

    // ── Data is never touched by suspension ──────────────────────────────
    const dataRow = db.prepare('SELECT * FROM tenant_data WHERE tenant_id = ?').get(tenantId);
    assert(!!dataRow, 'tenant_data row still exists after suspension (Rule #1: never delete customer data)');

    // ── Reactivate ────────────────────────────────────────────────────────
    const reactivate = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/reactivate', { admin: true, body: {} });
    assert(reactivate.status === 200, 'admin can manually reactivate a suspended tenant');
    const licAfterReactivate = db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(licAfterReactivate.status === 'ACTIVE', 'tenant_licenses.status is ACTIVE again');
    assert(licAfterReactivate.suspended_since === null, 'suspended_since is cleared on reactivate');
    const reactivateHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'STATUS_CHANGED' AND to_status = 'ACTIVE' AND from_status = 'SUSPENDED'").get(tenantId);
    assert(!!reactivateHistory, 'a STATUS_CHANGED (SUSPENDED -> ACTIVE) history event was logged');

    const reLogin = await req('POST', '/api/auth/login', { body: { mobile: '9889562370', pin: '3456' } });
    assert(reLogin.status === 200, 'owner can log in again after reactivation');
    const afterReactivate = await req('GET', '/api/data', { token: reLogin.data.token });
    assert(afterReactivate.status === 200, 'reads succeed again after reactivation');

    // ── Kill-sessions without a status change (owner suspects a stolen device) ─
    const login2 = await req('POST', '/api/auth/login', { body: { mobile: '9889562370', pin: '3456' } });
    const killSessions = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/kill-sessions', { admin: true, body: {} });
    assert(killSessions.status === 200 && killSessions.data.revoked >= 1, 'admin can kill sessions on demand, independent of any status change');
    const licAfterKill = db.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(licAfterKill.status === 'ACTIVE', 'kill-sessions alone does not change the license status — tenant is still ACTIVE');
    const blockedAfterKill = await req('GET', '/api/data', { token: login2.data.token });
    assert(blockedAfterKill.status === 401, 'the killed session token is rejected, even though the tenant itself is still ACTIVE');
    const killHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'SESSIONS_KILLED'").get(tenantId);
    assert(!!killHistory, 'a SESSIONS_KILLED license_history event was logged');

    // ── Admin notes / call log ────────────────────────────────────────────
    const note = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/notes', { admin: true, body: { note: 'Customer says payment will land next week.' } });
    assert(note.status === 200, 'admin can add a free-text note');
    const noteHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'NOTE_ADDED'").get(tenantId);
    assert(!!noteHistory && noteHistory.detail.includes('next week'), 'the note is recorded in license_history');

    const callNote = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/call-note', { admin: true, body: { note: 'Called, no answer.' } });
    assert(callNote.status === 200, 'admin can log a call ("Call Customer" action)');
    const callHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'CALL_LOGGED'").get(tenantId);
    assert(!!callHistory, 'the call is recorded as a distinct CALL_LOGGED event, separate from a plain note');

    // ── Full audit history is retrievable in one call ────────────────────
    const history = await req('GET', '/api/admin/tenant-licenses/' + tenantId + '/history', { admin: true });
    assert(history.status === 200 && history.data.history.length >= 6, "admin can view the tenant's full audit history (Phase 9: View Audit History)");

  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
