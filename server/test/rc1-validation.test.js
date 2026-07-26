/**
 * RC1 End-to-End Product Validation — adversarial testing against the REAL
 * running product (server/local.js). Not a feature test — this file tries
 * to BREAK things: SQL injection, JWT tampering, IDOR/cross-tenant access,
 * concurrency races, rate limiting, and the /api/data whole-blob's real
 * (lack of) server-side business-rule enforcement.
 *
 * Uses the existing isolated testServer.js harness — a disposable SQLite
 * file + random port, torn down at the end. Never touches production data.
 *
 * Usage: node test/rc1-validation.test.js
 */
'use strict';

const Database = require('better-sqlite3');
const { startTestServer } = require('./testServer');

// Test shortcut equivalent to clicking the real emailed verification link —
// same pattern license-admin-approval.test.js already uses.
function verifyEmailDirectly(dbPath, tenantId) {
  const db = new Database(dbPath);
  db.prepare("UPDATE users SET email_verified_at = datetime('now'), email_verify_token_hash = NULL, email_verify_expires = NULL WHERE tenant_id = ?").run(tenantId);
  db.close();
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('RC1 Validation: adversarial testing against server/local.js (the real running product)');
  console.log('');

  const server = await startTestServer();
  const { baseUrl, adminKey } = server;

  try {
    // ── Setup: two independent tenants for isolation testing ──────────────
    const mobA = '90000' + String(Date.now()).slice(-5);
    const signupA = await fetch(baseUrl + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Tenant A Shop', ownerName: 'Owner A', mobile: mobA, email: `a${Date.now()}@example.com`, pin: '123456' }),
    }).then(r => r.json());
    const mobB = '90001' + String(Date.now()).slice(-5);
    const signupB = await fetch(baseUrl + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Tenant B Shop', ownerName: 'Owner B', mobile: mobB, email: `b${Date.now()}@example.com`, pin: '654321' }),
    }).then(r => r.json());
    assert(signupA.tenantId && signupB.tenantId, 'setup: two independent tenants created');

    verifyEmailDirectly(server.dbPath, signupA.tenantId);
    verifyEmailDirectly(server.dbPath, signupB.tenantId);
    const approveA = await fetch(baseUrl + `/api/admin/registrations/${signupA.tenantId}/approve`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } });
    const approveB = await fetch(baseUrl + `/api/admin/registrations/${signupB.tenantId}/approve`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } });
    assert(approveA.status === 200 && approveB.status === 200, 'setup: both tenants approved after email verification');

    const loginA = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobA, pin: '123456' }) }).then(r => r.json());
    const loginB = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobB, pin: '654321' }) }).then(r => r.json());
    assert(!!loginA.token && !!loginB.token, 'setup: both tenants can log in after approval');

    // ── SQL injection attempts (should be structurally impossible — every ──
    // query in local.js uses db.prepare() with ? placeholders, confirmed by
    // static review; this empirically verifies the login path specifically) ─
    const sqliMobile = "' OR '1'='1";
    const sqliLogin = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: sqliMobile, pin: '000000' }) });
    assert(sqliLogin.status === 400 || sqliLogin.status === 401, `SQL injection payload in mobile field is rejected as an invalid login, not executed as SQL (got ${sqliLogin.status})`);

    const sqliSignup = await fetch(baseUrl + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: "Robert'); DROP TABLE tenants;--", ownerName: 'Bobby Tables', mobile: '9' + String(Date.now()).slice(-9), email: `c${Date.now()}@example.com`, pin: '111111' }),
    });
    assert(sqliSignup.status === 201, 'a SQL-injection-shaped shop name is accepted as inert literal text (parameterized query), not executed');
    const tenantsAfterSqli = await fetch(baseUrl + '/api/admin/tenants', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(Array.isArray(tenantsAfterSqli.tenants) && tenantsAfterSqli.tenants.some(t => t.shop_name && t.shop_name.includes('DROP TABLE')), 'the tenants table itself was NOT dropped — the payload is stored as inert text, confirming parameterized queries hold');

    // ── JWT tampering ────────────────────────────────────────────────────
    const [h, p, _sig] = loginA.token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), tenantId: signupB.tenantId })).toString('base64url');
    const forgedToken = `${h}.${forgedPayload}.${_sig}`;
    const forgedResult = await fetch(baseUrl + '/api/data', { headers: { Authorization: `Bearer ${forgedToken}` } });
    assert(forgedResult.status === 401, `a JWT with a tampered tenantId claim (signature no longer valid) is rejected outright (got ${forgedResult.status})`);

    const garbageToken = 'not.a.realtoken';
    const garbageResult = await fetch(baseUrl + '/api/data', { headers: { Authorization: `Bearer ${garbageToken}` } });
    assert(garbageResult.status === 401, 'a structurally invalid bearer token is rejected');

    // ── Cross-tenant isolation (IDOR) ────────────────────────────────────
    await fetch(baseUrl + '/api/data', {
      method: 'PUT', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { secretNote: 'Tenant A private inventory data' }, expectedVersion: 0 }),
    });
    const bDataView = await fetch(baseUrl + '/api/data', { headers: { Authorization: `Bearer ${loginB.token}` } }).then(r => r.json());
    assert(JSON.stringify(bDataView.data).includes('secretNote') === false, "Tenant B's GET /api/data never returns Tenant A's data — isolation enforced by tenant_id-scoped query, not by trusting client input");

    const sessRowsA = await fetch(baseUrl + '/api/auth/sessions', { headers: { Authorization: `Bearer ${loginA.token}` } }).then(r => r.json());
    const aSessionId = Array.isArray(sessRowsA) ? sessRowsA[0]?.session_id : sessRowsA.sessions?.[0]?.session_id;
    if (aSessionId) {
      const crossRevoke = await fetch(baseUrl + `/api/auth/sessions/${aSessionId}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${loginB.token}` } });
      assert(crossRevoke.status === 404, `Tenant B cannot revoke Tenant A's session by guessing/enumerating its ID (got ${crossRevoke.status}, expected 404 — ownership-checked, not just existence-checked)`);
    } else {
      console.log('  \x1b[33m○ SKIP\x1b[0m cross-tenant session-revoke IDOR check — session list shape not recognized, skipping rather than asserting a false result');
    }

    // ── /api/data: real server-side business-rule enforcement (or lack thereof) ─
    // This is the architectural fact motivating the entire RC1 rebuild in
    // server/src/: local.js's server accepts ANY JSON object as the whole
    // shop-data blob, with no field-level validation. Documented as a known,
    // pre-existing characteristic (not a new bug), verified here so the
    // report states it as a demonstrated fact, not an assumption.
    const currentA = await fetch(baseUrl + '/api/data', { headers: { Authorization: `Bearer ${loginA.token}` } }).then(r => r.json());
    const maliciousBlob = {
      inventory: [{ id: 1, name: 'Widget', stock: -9999, price: -500 }],
      sales: [{ id: 'dup-1' }, { id: 'dup-1' }],
      arbitraryUnknownField: { nested: { deeply: 'anything goes' } },
    };
    const putMalicious = await fetch(baseUrl + '/api/data', {
      method: 'PUT', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: maliciousBlob, expectedVersion: currentA.version }),
    });
    assert(putMalicious.status === 200, `PUT /api/data accepts negative stock, negative price, duplicate sale IDs, and arbitrary unknown fields with zero server-side business validation (got ${putMalicious.status}) — this is local.js's real, documented, pre-existing architecture (all such validation lives client-side in app/ShopERP_Pro_v8.html); see report's Architecture Review`);

    // ── Optimistic concurrency race: two simultaneous writes, same version ─
    const beforeRace = await fetch(baseUrl + '/api/data', { headers: { Authorization: `Bearer ${loginA.token}` } }).then(r => r.json());
    const [raceResult1, raceResult2] = await Promise.all([
      fetch(baseUrl + '/api/data', { method: 'PUT', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { writer: 'first' }, expectedVersion: beforeRace.version }) }),
      fetch(baseUrl + '/api/data', { method: 'PUT', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { writer: 'second' }, expectedVersion: beforeRace.version }) }),
    ]);
    const statuses = [raceResult1.status, raceResult2.status].sort();
    assert(statuses[0] === 200 && statuses[1] === 409, `two concurrent PUT /api/data calls with the identical expectedVersion: exactly one wins (200) and one loses (409) — no lost update, no double-apply, the atomic "WHERE version = ?" compare-and-swap holds under real concurrency (got statuses ${statuses.join(',')})`);

    // ── Rate limiting: does it actually trigger? ────────────────────────
    const rlMobile = '9' + String(Date.now()).slice(-9);
    let sawRateLimit = false;
    for (let i = 0; i < 15; i++) {
      const r = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: rlMobile, pin: '000000' }) });
      if (r.status === 429) { sawRateLimit = true; break; }
    }
    assert(sawRateLimit, 'repeated rapid login attempts (15x) from the same source eventually hit a real 429 rate limit, not an unbounded brute-force surface');

    // ── Cloud Backup: corrupted/missing backup handling on the REAL /api/cloud endpoints ─
    const keyHash = 'rc1val-key-' + Date.now();
    const putBackup = await fetch(baseUrl + '/api/cloud/backup', { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ keyHash, shopName: 'Backup Test Shop', data: '{"real":"data"}' }) });
    assert(putBackup.status === 200, 'a real backup can be created via /api/cloud/backup');
    const restoreOk = await fetch(baseUrl + `/api/cloud/restore/${keyHash}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(restoreOk.data === '{"real":"data"}', 'restoring an existing backup returns the exact data written');
    const restoreMissing = await fetch(baseUrl + '/api/cloud/restore/this-key-was-never-created-' + Date.now(), { headers: { 'X-Admin-Key': adminKey } });
    assert(restoreMissing.status === 404, 'restoring a missing/never-created backup 404s cleanly, not a crash or a 500');
    const deleteThenRestore = await fetch(baseUrl + `/api/cloud/backup/${keyHash}`, { method: 'DELETE', headers: { 'X-Admin-Key': adminKey } });
    const restoreAfterDelete = await fetch(baseUrl + `/api/cloud/restore/${keyHash}`, { headers: { 'X-Admin-Key': adminKey } });
    assert(deleteThenRestore.status === 200 && restoreAfterDelete.status === 404, 'delete then restore correctly 404s — the delete was real, not a no-op');
    const unauthedRestore = await fetch(baseUrl + `/api/cloud/restore/${keyHash}`);
    assert(unauthedRestore.status === 401, 'restoring a backup with NO admin key at all is rejected (401), not silently allowed');

    // ── Duplicate registration race (same mobile, fired simultaneously) ──
    const raceMobile = '9' + String(Date.now()).slice(-9);
    const [dup1, dup2] = await Promise.all([
      fetch(baseUrl + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopName: 'Race Shop 1', ownerName: 'Racer 1', mobile: raceMobile, email: `race1${Date.now()}@example.com`, pin: '222222' }) }),
      fetch(baseUrl + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopName: 'Race Shop 2', ownerName: 'Racer 2', mobile: raceMobile, email: `race2${Date.now()}@example.com`, pin: '333333' }) }),
    ]);
    const dupStatuses = [dup1.status, dup2.status].sort();
    assert(dupStatuses[0] === 201 && dupStatuses[1] === 409, `simultaneous signup requests for the identical mobile number: exactly one succeeds (201) and one is rejected (409) via the UNIQUE constraint, never two tenants for the same mobile (got ${dupStatuses.join(',')})`);

    // ── Oversized /api/data blob: a real, growing-over-time production ceiling ─
    // A real, long-running shop's whole-blob PUT /api/data eventually exceeds
    // express.json()'s 5mb limit (RC1 Validation finding: at realistic field
    // sizes, this happens around ~15-20k accumulated sales — an inevitable
    // ceiling for a successful shop, not an edge case). Before this sprint's
    // fix, Express's own PayloadTooLargeError fell through to the default
    // handler, leaking a full server-side stack trace (file paths, line
    // numbers) to the client — since NODE_ENV is never set to 'production'
    // anywhere in this deployment. Fixed with a global error handler
    // returning a clean, generic JSON message, matching every other endpoint's
    // own {error} shape.
    function makeSale(i) {
      return { id: 's' + i, invoiceNo: 'INV-' + String(i).padStart(6, '0'), customerId: 'c' + (i % 5000),
        items: [{ productId: 'p' + (i % 5000), name: 'iPhone 13 Screen Assembly', price: 2500, qty: 1 }],
        subtotal: 2500, discount: 0, total: 2500, date: '2025-06-15', note: '', payments: [{ method: 'Cash', amount: 2500 }], createdBy: 'u1' };
    }
    const bigBlob = { sales: Array.from({ length: 25000 }, (_, i) => makeSale(i)), products: [], customers: [], repairs: [], expenses: [], settings: {} };
    const currentDataA = await fetch(baseUrl + '/api/data', { headers: { Authorization: `Bearer ${loginA.token}` } }).then(r => r.json());
    const oversizedPut = await fetch(baseUrl + '/api/data', {
      method: 'PUT', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: bigBlob, expectedVersion: currentDataA.version }),
    });
    assert(oversizedPut.status === 413, `a request body over express.json()'s 5mb limit is rejected with a clean 413, not a hang or a crash (got ${oversizedPut.status})`);
    const oversizedBody = await oversizedPut.json();
    assert(typeof oversizedBody.error === 'string' && !oversizedBody.error.includes('node_modules') && !JSON.stringify(oversizedBody).includes('.js:'), 'the 413 response is clean JSON with no leaked server-side stack trace or file paths (information-disclosure fix)');
    const healthAfterOversized = await fetch(baseUrl + '/health');
    assert(healthAfterOversized.status === 200, 'the server remains healthy and responsive after rejecting an oversized request — no crash, no hang');

  } finally {
    server.stop();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
