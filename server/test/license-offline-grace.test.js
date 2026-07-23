/**
 * Licensing regression test — offline grace server contract (Phase 7).
 *
 * The actual 15-day offline-grace DECISION LOGIC (comparing lastVerifiedAt +
 * offlineGraceDays against "now" when the network is unreachable) lives
 * entirely client-side in app/ShopERP_Pro_v8.html's pssRefreshLicenseStatus()
 * — there is no browser-driven test runner in this repo (every other test
 * here talks to server/local.js over HTTP). This test scopes itself
 * honestly to what IS server-verifiable: that GET /api/license/status
 * returns the exact fields the client's offline-grace math depends on, and
 * that it updates last_verified_at on every successful call (the
 * "automatically re-verify on reconnect" mechanism). The client math itself
 * is a manual-verification item — see docs/architecture-review/
 * LicensingMigrationPlan.md, matching this repo's existing practice for
 * browser-only checks (e.g. MigrationPlan.md item 3).
 *
 * Usage:  node server/test/license-offline-grace.test.js
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
  console.log('Licensing regression: offline-grace server contract (Phase 7)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    const signup = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Offline Test Shop', ownerName: 'Owner Name', mobile: '9890123456', email: 'offline@example.com', pin: '1357',
    }});
    const tenantId = signup.data.tenantId;
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(tenantId);
    await req('POST', '/api/admin/registrations/' + tenantId + '/approve', { admin: true, body: {} });

    const login = await req('POST', '/api/auth/login', { body: { mobile: '9890123456', pin: '1357' } });
    const token = login.data.token;

    // ── license/status carries every field the client's offline-grace math needs ─
    const status1 = await req('GET', '/api/license/status', { token });
    assert(status1.status === 200, 'license/status succeeds');
    const lic = status1.data.license;
    assert(!!lic, 'response includes the nested license object');
    assert(typeof lic.lastVerifiedAt === 'string', 'license.lastVerifiedAt is present — the offline-grace anchor timestamp');
    assert(typeof lic.offlineGraceDays === 'number' && lic.offlineGraceDays === 15, 'license.offlineGraceDays defaults to 15, per spec');
    assert(typeof lic.status === 'string', 'license.status is present — what the client falls back to using during an offline period');
    assert('expiresAt' in lic && 'daysRemaining' in lic, 'license.expiresAt and daysRemaining are present for the 7-day warning banner math');

    // ── Every successful call re-verifies (updates last_verified_at) ───────
    const lastVerified1 = db.prepare('SELECT last_verified_at FROM tenant_licenses WHERE tenant_id = ?').get(tenantId).last_verified_at;
    await sleep(1100); // SQLite datetime('now') has 1-second resolution
    const status2 = await req('GET', '/api/license/status', { token });
    const lastVerified2 = db.prepare('SELECT last_verified_at FROM tenant_licenses WHERE tenant_id = ?').get(tenantId).last_verified_at;
    assert(lastVerified2 !== lastVerified1, 'last_verified_at advances on every successful license/status call — this IS the "automatically re-verify on reconnect" mechanism');

    // ── offline_grace_days is per-tenant and admin-adjustable at the DB level ─
    db.prepare('UPDATE tenant_licenses SET offline_grace_days = 30 WHERE tenant_id = ?').run(tenantId);
    const status3 = await req('GET', '/api/license/status', { token });
    assert(status3.data.license.offlineGraceDays === 30, 'a customized offline_grace_days value is reported back correctly');

    // ── license/status works regardless of license status (PENDING/READ_ONLY/SUSPENDED) ─
    // — this endpoint's whole purpose is reporting status, not gating on it,
    // exactly so a client mid-grace-period can always learn the real state
    // the moment it reconnects.
    db.prepare("UPDATE tenant_licenses SET status = 'SUSPENDED' WHERE tenant_id = ?").run(tenantId);
    const statusWhileSuspended = await req('GET', '/api/license/status', { token });
    assert(statusWhileSuspended.status === 200, 'license/status still responds even when the tenant is SUSPENDED (never gated itself)');
    assert(statusWhileSuspended.data.license.status === 'SUSPENDED', 'license/status accurately reports SUSPENDED so the client can react immediately on reconnect');

  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
