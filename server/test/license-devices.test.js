/**
 * Licensing regression test — trusted devices + device limit (Phase 8).
 * See docs/architecture-review/LicenseArchitecture.md.
 *
 * Usage:  node server/test/license-devices.test.js
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
  console.log('Licensing regression: trusted devices + device limit (Phase 8)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    const signup = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Device Test Shop', ownerName: 'Owner Name', mobile: '9878451260', email: 'devices@example.com', pin: '2468',
    }});
    const tenantId = signup.data.tenantId;
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(tenantId);
    // start-trial + approve so the tenant has a known device_limit (TRIAL = 2)
    await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/start-trial', { admin: true, body: {} });
    await req('POST', '/api/admin/registrations/' + tenantId + '/approve', { admin: true, body: {} });

    // ── Login with no deviceId at all — byte-identical old behavior ────────
    const noDeviceLogin = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468' } });
    assert(noDeviceLogin.status === 200, 'login without a deviceId still works (old client builds are unaffected)');
    const noDeviceCount = db.prepare('SELECT COUNT(*) c FROM trusted_devices WHERE tenant_id = ?').get(tenantId).c;
    assert(noDeviceCount === 0, 'no trusted_devices row is created when the client sends no deviceId');

    // ── First login with a deviceId auto-trusts it ─────────────────────────
    const login1 = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468', deviceId: 'device-one' } });
    assert(login1.status === 200, 'first login with a new deviceId succeeds');
    const device1 = db.prepare('SELECT * FROM trusted_devices WHERE tenant_id = ? AND device_id = ?').get(tenantId, 'device-one');
    assert(!!device1 && device1.is_active === 1, 'the new device is auto-trusted on first login (Phase 8)');

    // ── Re-login from the same known device just needs the PIN, no new row ─
    const login1Again = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468', deviceId: 'device-one' } });
    assert(login1Again.status === 200, 'subsequent login from the same device succeeds with just PIN (no extra step)');
    const countAfterRelogin = db.prepare('SELECT COUNT(*) c FROM trusted_devices WHERE tenant_id = ? AND device_id = ?').get(tenantId, 'device-one').c;
    assert(countAfterRelogin === 1, 're-logging in from a known device does not create a duplicate row');

    // ── Second distinct device — still within the TRIAL limit of 2 ─────────
    const login2 = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468', deviceId: 'device-two' } });
    assert(login2.status === 200, 'a second distinct device succeeds — TRIAL plan allows 2 devices');
    const deviceCount = db.prepare('SELECT COUNT(*) c FROM trusted_devices WHERE tenant_id = ? AND is_active = 1').get(tenantId).c;
    assert(deviceCount === 2, 'exactly 2 active trusted devices now exist');

    // ── Third distinct device — exceeds the limit, rejected before a session is created ─
    const login3 = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468', deviceId: 'device-three' } });
    assert(login3.status === 403, 'a third distinct device is rejected once the device limit (2) is reached');
    assert(login3.data.code === 'DEVICE_LIMIT_REACHED', 'the rejection carries a machine-readable code');
    assert(login3.data.error.includes('2/2'), 'the rejection message reports the current usage against the limit');
    const noSessionForRejected = db.prepare(`
      SELECT COUNT(*) c FROM user_sessions s JOIN trusted_devices d ON 1=1
      WHERE d.device_id = 'device-three'
    `).get().c;
    const deviceCountAfterReject = db.prepare('SELECT COUNT(*) c FROM trusted_devices WHERE tenant_id = ? AND is_active = 1').get(tenantId).c;
    assert(deviceCountAfterReject === 2, 'the rejected device was never added — still exactly 2 trusted devices');

    // ── Admin: list devices ─────────────────────────────────────────────────
    const list = await req('GET', '/api/admin/tenant-licenses/' + tenantId + '/devices', { admin: true });
    assert(list.status === 200 && list.data.devices.length === 2, 'admin can list all trusted devices for a tenant');
    assert(list.data.devices.every(d => d.mobile === '9878451260'), 'each device entry reports the user it belongs to');

    // ── Admin: remove one device (soft-remove, frees a slot) ────────────────
    const toRemove = list.data.devices.find(d => d.device_id === 'device-one');
    const remove = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/devices/' + toRemove.id + '/remove', { admin: true, body: {} });
    assert(remove.status === 200, 'admin can remove a specific device');
    const removedRow = db.prepare('SELECT is_active FROM trusted_devices WHERE id = ?').get(toRemove.id);
    assert(removedRow.is_active === 0, 'the removed device is soft-removed (is_active=0), not hard-deleted — audit trail preserved');
    const removeHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'DEVICE_REMOVED'").get(tenantId);
    assert(!!removeHistory, 'a DEVICE_REMOVED license_history event was logged');

    // ── Freed slot allows a new device to log in ────────────────────────────
    const login3Retry = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468', deviceId: 'device-three' } });
    assert(login3Retry.status === 200, 'after removing one device, a new device can now log in (the slot was freed)');

    // ── Admin: increase device limit ────────────────────────────────────────
    const setLimit = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/devices/limit', { admin: true, body: { deviceLimit: 5 } });
    assert(setLimit.status === 200 && setLimit.data.deviceLimit === 5, 'admin can increase the device limit');
    const limitHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'DEVICE_LIMIT_CHANGED'").get(tenantId);
    assert(!!limitHistory, 'a DEVICE_LIMIT_CHANGED license_history event was logged');
    const login4 = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468', deviceId: 'device-four' } });
    assert(login4.status === 200, 'a 4th device now succeeds after the limit was raised to 5');

    // ── Admin: reset all devices ─────────────────────────────────────────────
    const resetAll = await req('POST', '/api/admin/tenant-licenses/' + tenantId + '/devices/reset-all', { admin: true, body: {} });
    assert(resetAll.status === 200 && resetAll.data.reset > 0, 'admin can reset all devices for a tenant at once');
    const activeAfterReset = db.prepare('SELECT COUNT(*) c FROM trusted_devices WHERE tenant_id = ? AND is_active = 1').get(tenantId).c;
    assert(activeAfterReset === 0, 'no trusted devices remain active after reset-all');
    const resetHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'DEVICES_RESET'").get(tenantId);
    assert(!!resetHistory, 'a DEVICES_RESET license_history event was logged');
    const loginAfterReset = await req('POST', '/api/auth/login', { body: { mobile: '9878451260', pin: '2468', deviceId: 'device-one' } });
    assert(loginAfterReset.status === 200, 'the same device_id can re-trust itself as if brand-new after a reset');

  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
