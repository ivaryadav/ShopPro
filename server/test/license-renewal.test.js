/**
 * Licensing regression test — renewal (Phase 10).
 * "Update expiry date. Nothing else. No data restore. No migration.
 * Customer logs in and continues exactly where they left off."
 * See docs/architecture-review/RenewalFlow.md.
 *
 * Usage:  node server/test/license-renewal.test.js
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
  console.log('Licensing regression: renewal (Phase 10)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    const signup = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Renewal Test Shop', ownerName: 'Owner Name', mobile: '9867452130', email: 'renew@example.com', pin: '7777',
    }});
    const tenantId = signup.data.tenantId;
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(tenantId);
    await req('POST', '/api/admin/registrations/' + tenantId + '/approve', { admin: true, body: {} });

    const login = await req('POST', '/api/auth/login', { body: { mobile: '9867452130', pin: '7777' } });
    const token = login.data.token;

    // Populate real data — a repair job entry, so renewal's "continues from
    // exactly where they left off" claim has something concrete to verify.
    const save = await req('PUT', '/api/data', { token, body: { data: { repairs: [{ id: 1, device: 'iPhone 12', status: 'in-progress' }] }, expectedVersion: 1 } });
    assert(save.status === 200, 'shop saves real data before expiring');
    const dataBefore = db.prepare('SELECT data, version FROM tenant_data WHERE tenant_id = ?').get(tenantId);

    // Simulate expiry -> READ_ONLY
    db.prepare("UPDATE tenant_licenses SET status = 'READ_ONLY', expires_at = datetime('now', '-1 day'), read_only_since = datetime('now', '-5 days') WHERE tenant_id = ?").run(tenantId);
    const readOnlyRead = await req('GET', '/api/data', { token });
    assert(readOnlyRead.status === 200, 'data is still viewable while expired/READ_ONLY, before renewal');

    // ── Extend by days ────────────────────────────────────────────────────
    const extend = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/extend', { admin: true, body: { days: 30 } });
    assert(extend.status === 200, 'extend succeeds');
    assert(extend.data.reactivated === true, 'extend reports that a blocked (READ_ONLY) tenant was reactivated');

    const licAfter = db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    assert(licAfter.status === 'ACTIVE', 'extend restores status to ACTIVE');
    assert(licAfter.read_only_since === null && licAfter.suspended_since === null, 'extend clears the read_only_since/suspended_since timers');
    const daysOut = Math.round((new Date(licAfter.expires_at).getTime() - Date.now()) / 86400000);
    assert(daysOut === 30 || daysOut === 29, 'expiry date moved ~30 days into the future');

    // ── Nothing else changed ─────────────────────────────────────────────────
    const dataAfter = db.prepare('SELECT data, version FROM tenant_data WHERE tenant_id = ?').get(tenantId);
    assert(dataAfter.data === dataBefore.data, "tenant_data's actual content is byte-identical before and after renewal — renewal never touches it");
    assert(dataAfter.version === dataBefore.version, 'tenant_data version is unchanged by renewal (no implicit write happened)');

    const userCountBefore = db.prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ?').get(tenantId).c;
    assert(userCountBefore === 1, 'sanity: exactly one user before continuing');

    // ── Customer logs in and continues exactly where they left off ─────────
    const reLogin = await req('POST', '/api/auth/login', { body: { mobile: '9867452130', pin: '7777' } });
    assert(reLogin.status === 200, 'owner logs back in successfully after renewal, same mobile+PIN as always');
    const dataAfterLogin = await req('GET', '/api/data', { token: reLogin.data.token });
    assert(dataAfterLogin.status === 200, 'reads work normally again (ACTIVE, not READ_ONLY)');
    assert(dataAfterLogin.data.data.repairs[0].device === 'iPhone 12', 'the repair job entered before expiry is exactly where the shop left it');

    const write = await req('PUT', '/api/data', { token: reLogin.data.token, body: { data: { repairs: [{ id: 1, device: 'iPhone 12', status: 'completed' }] }, expectedVersion: dataAfterLogin.data.version } });
    assert(write.status === 200, 'writes work normally again after renewal — the shop can continue exactly where it left off');

    // ── Extend on a still-active (not yet expired) tenant just pushes the date further ─
    const extend2 = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/extend', { admin: true, body: { days: 10 } });
    assert(extend2.status === 200, 'extending an already-ACTIVE tenant (early renewal) still succeeds');
    assert(extend2.data.reactivated === false, 'extend correctly reports no reactivation was needed — tenant was already ACTIVE');
    const licAfter2 = db.prepare('SELECT expires_at FROM tenant_licenses WHERE tenant_id = ?').get(tenantId);
    const daysFromNow2 = Math.round((new Date(licAfter2.expires_at).getTime() - Date.now()) / 86400000);
    assert(daysFromNow2 === 40 || daysFromNow2 === 39, 'renewing early extends FROM the current expiry date, not from today (30 + 10 days out, not just 10)');

    // ── Extend with an explicit newExpiresAt ────────────────────────────────
    const explicitDate = new Date(Date.now() + 100 * 86400000).toISOString();
    const extend3 = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/extend', { admin: true, body: { newExpiresAt: explicitDate } });
    assert(extend3.status === 200 && extend3.data.expiresAt === explicitDate, 'extend also accepts an explicit newExpiresAt date');

    // ── Extend is rejected for PENDING_APPROVAL / ARCHIVED tenants ──────────
    const signup2 = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Pending Shop', ownerName: 'Someone', mobile: '9867452131', email: 'pending@example.com', pin: '8888',
    }});
    const pendingExtend = await req('POST', '/api/admin/tenant-licenses/' + signup2.data.tenantId + '/extend', { admin: true, body: { days: 30 } });
    assert(pendingExtend.status === 400, 'extend is rejected for a PENDING_APPROVAL tenant (must Approve first)');

    db.prepare("UPDATE tenant_licenses SET status = 'ARCHIVED' WHERE tenant_id = ?").run(tenantId);
    const archivedExtend = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/extend', { admin: true, body: { days: 30 } });
    assert(archivedExtend.status === 400, 'extend is rejected for an ARCHIVED tenant (must Reactivate first)');

  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
