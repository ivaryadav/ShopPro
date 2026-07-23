/**
 * Licensing regression test — automatic backfill for pre-existing tenants
 * + backward compatibility of every legacy endpoint.
 * See docs/architecture-review/LicensingMigrationPlan.md and
 * DatabaseDesign.md for the design this verifies.
 *
 * Simulates a real deploy: boot once (pre-feature shape), insert legacy-only
 * tenants directly (as if they'd registered via the OLD /api/auth/register
 * before this feature ever existed), then reboot the SAME DB file — this
 * second boot's automatic backfill (server/local.js) must create a correct
 * tenant_licenses row for each one, and every legacy endpoint must keep
 * working exactly as before, completely untouched.
 *
 * Usage:  node server/test/license-backfill-regression.test.js
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const license = require('../license');
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
  console.log('Licensing regression: automatic backfill + legacy endpoint compatibility');
  const dbPath = path.join(os.tmpdir(), `shoperpro-backfill-test-${crypto.randomBytes(8).toString('hex')}.db`);
  console.log('DB: ' + dbPath);
  console.log('');

  try {
    // ── Boot 1: fresh file, just to create the schema ─────────────────────
    console.log('Boot 1 (fresh file, schema only)...');
    let srv = await startTestServer({ envOverrides: { DB_PATH: dbPath } });
    srv.stop();
    await sleep(300);

    // ── Insert legacy-shape tenants directly, as the OLD register endpoint
    //    would have, well before this feature existed — no tenant_licenses
    //    row for any of them. ────────────────────────────────────────────
    const db = new Database(dbPath);
    const activeKey = license.generateKey(license.WEB_LICENSE_MID, 'yearly');
    const activeKeyHash = crypto.createHash('sha256').update(activeKey.toUpperCase()).digest('hex');
    const activeTenant = db.prepare(
      `INSERT INTO tenants (shop_name, status, license_key_hash, license_expiry, license_plan) VALUES (?,?,?,?,?) RETURNING *`
    ).get('Legacy Active Shop', 'active', activeKeyHash, '2099-12-31', 'yearly');
    db.prepare(
      `INSERT INTO users (tenant_id, username, display_name, mobile, password_hash, role) VALUES (?,?,?,?,?,?)`
    ).run(activeTenant.id, '9900112233', 'Legacy Owner', '9900112233', bcrypt.hashSync('1234', 10), 'owner');
    db.prepare('INSERT INTO tenant_data (tenant_id, data) VALUES (?,?)').run(activeTenant.id, JSON.stringify({ inventory: ['legacy item'] }));

    const pausedTenant = db.prepare(
      `INSERT INTO tenants (shop_name, status, suspend_reason, license_plan) VALUES (?,?,?,?) RETURNING *`
    ).get('Legacy Paused Shop', 'paused', 'overdue invoice', 'monthly');
    db.prepare('INSERT INTO tenant_data (tenant_id, data) VALUES (?,?)').run(pausedTenant.id, '{}');

    const terminatedTenant = db.prepare(
      `INSERT INTO tenants (shop_name, status, license_plan) VALUES (?,?,?) RETURNING *`
    ).get('Legacy Terminated Shop', 'terminated', 'weird-legacy-plan-value');
    db.prepare('INSERT INTO tenant_data (tenant_id, data) VALUES (?,?)').run(terminatedTenant.id, '{}');

    const preExistingLicRows = db.prepare('SELECT COUNT(*) c FROM tenant_licenses').get().c;
    assert(preExistingLicRows === 0, 'sanity: no tenant_licenses rows exist yet for the manually-inserted legacy tenants');
    db.close();

    // ── Boot 2: same file — this is where the automatic backfill runs ──────
    console.log('Boot 2 (same file — triggers automatic backfill)...');
    srv = await startTestServer({ envOverrides: { DB_PATH: dbPath } });
    const req = reqFactory(srv.baseUrl, srv.adminKey);
    const db2 = new Database(dbPath);

    // ── Backfill correctness ────────────────────────────────────────────────
    const activeLic = db2.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(activeTenant.id);
    assert(!!activeLic, 'a tenant_licenses row now exists for the pre-existing ACTIVE legacy tenant');
    assert(activeLic.status === 'ACTIVE', "legacy status 'active' maps to the new status 'ACTIVE'");
    assert(activeLic.device_limit === 5, 'backfilled tenants get device_limit=5, not BASIC\'s default of 2 (avoids locking out an existing shop\'s own devices)');
    assert(activeLic.expires_at === '2099-12-31', "backfilled expires_at matches the legacy tenant's license_expiry exactly");
    assert(activeLic.billing_cycle === 'yearly', "a recognized legacy license_plan ('yearly') is carried over as billing_cycle");
    assert(!!activeLic.license_key && /^SHOP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(activeLic.license_key), 'a fresh SHOP-XXXX-XXXX-XXXX key was generated for the backfilled tenant');
    assert(!!activeLic.last_verified_at, 'last_verified_at is stamped at backfill time');

    const pausedLic = db2.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(pausedTenant.id);
    assert(pausedLic.status === 'SUSPENDED', "legacy status 'paused' maps to the new status 'SUSPENDED'");

    const terminatedLic = db2.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(terminatedTenant.id);
    assert(terminatedLic.status === 'ARCHIVED', "legacy status 'terminated' maps to the new status 'ARCHIVED'");
    assert(terminatedLic.billing_cycle === 'monthly', "an unrecognized legacy license_plan value ('weird-legacy-plan-value') falls back to 'monthly', not left invalid");

    const backfillHistory = db2.prepare("SELECT COUNT(*) c FROM license_history WHERE event_type = 'BACKFILLED'").get().c;
    assert(backfillHistory === 3, 'a BACKFILLED license_history event was logged for each of the 3 pre-existing tenants');

    // ── Legacy columns are frozen — untouched by the backfill ───────────────
    const activeTenantAfter = db2.prepare('SELECT * FROM tenants WHERE id = ?').get(activeTenant.id);
    assert(activeTenantAfter.status === 'active', "the legacy tenants.status column is untouched ('active', still lowercase) — old code paths keep working");
    assert(activeTenantAfter.license_key_hash === activeKeyHash, 'the legacy tenants.license_key_hash is untouched');

    // ── Rebooting again (3rd boot) does not create duplicate rows ───────────
    srv.stop();
    await sleep(300);
    db2.close();
    const srv3 = await startTestServer({ envOverrides: { DB_PATH: dbPath } });
    const db3 = new Database(dbPath);
    const licCountAfterReboot = db3.prepare('SELECT COUNT(*) c FROM tenant_licenses').get().c;
    assert(licCountAfterReboot === 3, 'a third boot against the same file does not create duplicate tenant_licenses rows (idempotent backfill)');
    const req3 = reqFactory(srv3.baseUrl, srv3.adminKey);

    // ── Legacy /api/auth/login still works, completely unchanged ───────────
    const legacyLogin = await req3('POST', '/api/auth/login', { body: { mobile: '9900112233', pin: '1234' } });
    assert(legacyLogin.status === 200, 'the legacy owner can still log in with mobile+PIN exactly as before');
    const legacyToken = legacyLogin.data.token;

    // ── The new license gates don't break legacy tenants that were already ACTIVE ─
    const legacyRead = await req3('GET', '/api/data', { token: legacyToken });
    assert(legacyRead.status === 200, 'the backfilled-ACTIVE legacy tenant can still read its data normally');
    assert(legacyRead.data.data.inventory[0] === 'legacy item', "the legacy tenant's actual pre-existing data is intact and unchanged");

    // ── Legacy /api/auth/verify-license still works, completely unchanged ───
    const verifyLicense = await req3('POST', '/api/auth/verify-license', { body: { licenseKey: activeKey } });
    assert(verifyLicense.status === 200 && verifyLicense.data.found === true, 'the legacy verify-license lookup still works with the original real key');
    assert(verifyLicense.data.shopName === 'Legacy Active Shop', 'verify-license reports the correct legacy shop');

    // ── Legacy /api/admin/web-users still works, completely unchanged ───────
    const webUsers = await req3('GET', '/api/admin/web-users', { admin: true });
    assert(webUsers.status === 200, 'the legacy admin web-users listing still works');
    const legacyShopEntry = webUsers.data.shops.find(s => s.shopName === 'Legacy Active Shop');
    assert(!!legacyShopEntry && legacyShopEntry.shopStatus === 'active', 'web-users still reports the legacy shop_status field exactly as before (lowercase, from tenants.status)');

    // ── Legacy /api/admin/tenant/status (pause/restore) still works ─────────
    const restorePaused = await req3('POST', '/api/admin/tenant/status', { admin: true, body: { shopName: 'Legacy Paused Shop', status: 'active' } });
    assert(restorePaused.status === 200, 'the legacy admin pause/restore endpoint still works, completely unaffected by the new tenant_licenses table');
    const pausedTenantAfter = db3.prepare('SELECT status FROM tenants WHERE id = ?').get(pausedTenant.id);
    assert(pausedTenantAfter.status === 'active', "the legacy restore actually flipped tenants.status back to 'active'");
    // Note: this legacy action intentionally does NOT touch tenant_licenses —
    // the two systems are independent by design (decision #9 in the plan).
    const pausedLicAfter = db3.prepare('SELECT status FROM tenant_licenses WHERE tenant_id = ?').get(pausedTenant.id);
    assert(pausedLicAfter.status === 'SUSPENDED', 'tenant_licenses.status is untouched by the legacy admin action — the two status systems are independent for legacy tenants');

    // ── A brand-new signup, unaffected by any of the legacy tenants above ───
    const newSignup = await req3('POST', '/api/auth/signup', { body: {
      shopName: 'Brand New Shop', ownerName: 'New Owner', mobile: '9900112299', email: 'newowner@example.com', pin: '5555',
    }});
    assert(newSignup.status === 201, 'the new self-service signup flow works normally alongside pre-existing legacy tenants');

    srv3.stop();
    db3.close();

  } finally {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    console.log('\nTemp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
