/**
 * Wave 0 regression test — optimistic concurrency on /api/data.
 * See docs/architecture-review/ConflictResolution.md for the design this verifies.
 *
 * Runs against an isolated, disposable test server + SQLite file (see
 * server/test/testServer.js / docs/architecture-review/DatabaseIsolationPlan.md)
 * — never touches server/shoperpro.db. No cleanup discipline is required
 * beyond calling stop(): the entire temp DB is deleted when the test ends.
 *
 * Usage:  node server/test/wave0-concurrency.test.js
 */
'use strict';

const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function jsonReq(baseUrl, adminKey) {
  return async function (method, path_, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (typeof body === 'object' && body && body.__adminKey) { headers['X-Admin-Key'] = adminKey; delete body.__adminKey; }
    const r = await fetch(baseUrl + path_, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, data };
  };
}

async function main() {
  console.log('Wave 0 regression: optimistic concurrency on /api/data');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const json = jsonReq(srv.baseUrl, srv.adminKey);
  const Database = require('better-sqlite3');
  const SHOP_NAME = 'Wave0 Test Shop';
  const MOBILE = '9135790000';

  try {
    const gen = await json('POST', '/api/admin/generate-key', null, { __adminKey: true, plan: 'monthly' });
    assert(gen.status === 200 && gen.data.key, 'admin can generate a key');

    const reg = await json('POST', '/api/auth/register', null, {
      shopName: SHOP_NAME, ownerName: 'Wave0 Tester', mobile: MOBILE, pin: '135790', licenseKey: gen.data.key,
    });
    assert(reg.status === 201 && reg.data.token, 'fresh tenant registers successfully');
    const token = reg.data.token;

    const db = new Database(srv.dbPath);
    const tenantId = db.prepare('SELECT id FROM tenants WHERE shop_name = ?').get(SHOP_NAME)?.id;
    db.close();
    assert(!!tenantId, 'test tenant row exists in SQLite');

    // 1. GET should return version 1 for a brand new tenant
    const g1 = await json('GET', '/api/data', token);
    assert(g1.status === 200 && g1.data.version === 1, 'GET /api/data returns version:1 for a fresh tenant');

    // 2. PUT with the correct expectedVersion succeeds and increments
    const p1 = await json('PUT', '/api/data', token, { data: { settings: { shopName: SHOP_NAME } }, expectedVersion: 1 });
    assert(p1.status === 200 && p1.data.version === 2, 'PUT with correct expectedVersion (1) succeeds, returns version:2');

    // 3. PUT with a stale expectedVersion is rejected, not silently applied
    const p2 = await json('PUT', '/api/data', token, { data: { settings: { shopName: 'OVERWRITE ATTEMPT' } }, expectedVersion: 1 });
    assert(p2.status === 409, 'PUT with stale expectedVersion (1, now behind) is rejected with 409');
    assert(p2.data.currentVersion === 2, '409 body reports the real current version (2)');
    assert(p2.data.updatedByName === 'Wave0 Tester', '409 body correctly attributes the last writer');

    // 4. PUT with no expectedVersion at all is also rejected (fail-safe for stale clients)
    const p3 = await json('PUT', '/api/data', token, { data: { settings: { shopName: 'NO VERSION SENT' } } });
    assert(p3.status === 409, 'PUT with missing expectedVersion fails safe into a 409, never a silent write');

    // 5. The rejected writes must not have reached the database
    const g2 = await json('GET', '/api/data', token);
    assert(g2.data.version === 2, 'version is still 2 after both rejected writes');
    assert(g2.data.data.settings.shopName === SHOP_NAME, 'stored data is still the legitimate save, not either overwrite attempt');

    // 6. A correctly-versioned save after a conflict still works (client recovers)
    const p4 = await json('PUT', '/api/data', token, { data: { settings: { shopName: SHOP_NAME, recovered: true } }, expectedVersion: 2 });
    assert(p4.status === 200 && p4.data.version === 3, 'save with the corrected version (2) succeeds after a conflict, returns version:3');

    // 7. Regression: a tenant with NO tenant_data row at all (found in production
    //    during review — tenants #1-4 predated this column set) must still be
    //    able to save. The old INSERT..ON CONFLICT DO UPDATE self-healed this;
    //    the naive UPDATE-only rewrite silently couldn't, forever 409ing such a
    //    tenant. This must never regress.
    {
      const db2 = new Database(srv.dbPath);
      db2.prepare('DELETE FROM tenant_data WHERE tenant_id = ?').run(tenantId);
      db2.close();
      const gRowless = await json('GET', '/api/data', token);
      assert(gRowless.status === 200 && gRowless.data.version === 0, 'GET reports version:0 for a tenant with no tenant_data row');
      const pRowless = await json('PUT', '/api/data', token, { data: { settings: { shopName: SHOP_NAME, healedFromRowless: true } }, expectedVersion: 0 });
      assert(pRowless.status === 200 && pRowless.data.version === 1, 'a row-less tenant can save with expectedVersion:0 — the row is created, not rejected');
      const pRowless2 = await json('PUT', '/api/data', token, { data: { settings: { shopName: SHOP_NAME, secondSave: true } }, expectedVersion: 1 });
      assert(pRowless2.status === 200 && pRowless2.data.version === 2, 'normal versioned saves work immediately after the row is healed');
    }

    // 8. True concurrent writes (Promise.all, not sequential) — the loser must
    //    get a clean 409, never a lost update or corrupted state.
    {
      const [ca, cb] = await Promise.all([
        json('PUT', '/api/data', token, { data: { settings: { shopName: SHOP_NAME, race: 'A' } }, expectedVersion: 2 }),
        json('PUT', '/api/data', token, { data: { settings: { shopName: SHOP_NAME, race: 'B' } }, expectedVersion: 2 }),
      ]);
      const statuses = [ca.status, cb.status].sort();
      assert(statuses[0] === 200 && statuses[1] === 409, 'true concurrent writes: exactly one wins (200), the other gets a clean 409, never both succeeding or both failing');
    }

  } finally {
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
