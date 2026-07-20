/**
 * Extended concurrency stress test — 2, 5, 10, 20 simulated concurrent
 * actors, covering:
 *   - concurrent saves / stale writes / conflict detection at scale
 *     (N devices of the SAME tenant racing to save; exactly one must win)
 *   - refresh token races at scale (N tabs racing to refresh the SAME token;
 *     none may be spuriously logged out, exactly one real rotation happens)
 *   - tenant isolation under load (N DIFFERENT tenants all saving at the
 *     exact same moment; every tenant's data must land in its own row only)
 *
 * Tenants here are created directly via the database + server/sessions.js,
 * not through POST /api/auth/register. Reason: license keys are
 * deterministic per (plan, day) — only 6 plans exist, so registering 20+
 * distinct tenants in one run through the real key-issuance flow collides
 * (discovered while first writing this test: the 2nd of 2 tenants failed
 * registration with "key already registered to the 1st"). This test isn't
 * validating licensing — that's wave0/1's job, and they correctly DO go
 * through the real flow — so bypassing it here for pure load generation is
 * the right call, not a shortcut around something that matters for this file.
 *
 * Runs entirely against one isolated, disposable test server + DB file.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require(path.join(__dirname, '..', 'node_modules', 'bcryptjs'));
const sessions = require('../sessions');
const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('    \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('    \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function reqFactory(baseUrl) {
  return async function (method, path_, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(baseUrl + path_, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, data };
  };
}

// Creates a tenant + owner user + tenant_data row + a real session directly
// against the isolated DB, and returns a working {token, refreshToken} pair
// — functionally identical to what a real register/login would produce,
// without going through the collision-prone key-issuance flow.
function createStressTenant(db, jwtSecret, shopName, mobile) {
  const tenant = db.prepare("INSERT INTO tenants (shop_name, status) VALUES (?, 'active') RETURNING *").get(shopName);
  const user = db.prepare(
    "INSERT INTO users (tenant_id, username, display_name, mobile, password_hash, role) VALUES (?,?,?,?,?, 'owner') RETURNING *"
  ).get(tenant.id, mobile, shopName + ' Owner', mobile, bcrypt.hashSync('999000', 10));
  db.prepare("INSERT INTO tenant_data (tenant_id, data, version) VALUES (?, '{}', 1)").run(tenant.id);
  const fakeReq = { headers: { 'user-agent': 'concurrency-stress-test' }, ip: '127.0.0.1' };
  const session = sessions.createSession(db, jwtSecret, { user, tenant, req: fakeReq });
  return { tenantId: tenant.id, token: session.accessToken, refreshToken: session.refreshToken };
}

// ── Level test 1: N devices of ONE tenant race to save concurrently ────────
async function testConcurrentSavesAtScale(req, db, jwtSecret, n) {
  const { token } = createStressTenant(db, jwtSecret, `StressSaveTenant${n}`, `9${String(n).padStart(3, '0')}100001`);
  const requests = Array.from({ length: n }, (_, i) =>
    req('PUT', '/api/data', token, { data: { settings: { writer: i } }, expectedVersion: 1 })
  );
  const results = await Promise.all(requests);
  const winners = results.filter(r => r.status === 200);
  const conflicts = results.filter(r => r.status === 409);
  assert(winners.length === 1, `[n=${n}] concurrent saves: exactly 1 of ${n} wins (200), got ${winners.length}`);
  assert(conflicts.length === n - 1, `[n=${n}] concurrent saves: exactly ${n - 1} of ${n} get a clean 409, got ${conflicts.length}`);
  assert(winners.length + conflicts.length === n, `[n=${n}] concurrent saves: every request got a definitive 200 or 409 — none hung, crashed, or returned something else`);
  const final = await req('GET', '/api/data', token);
  assert(final.data.version === 2, `[n=${n}] final version is exactly 2 (one real write applied, not ${n})`);
  assert(typeof final.data.data.settings.writer === 'number', `[n=${n}] final data is a clean single writer's value, not corrupted`);
}

// ── Level test 2: N tabs race to refresh the SAME token ─────────────────────
async function testRefreshRaceAtScale(req, db, jwtSecret, n) {
  const { refreshToken } = createStressTenant(db, jwtSecret, `StressRefreshTenant${n}`, `9${String(n).padStart(3, '0')}200002`);
  const requests = Array.from({ length: n }, () => req('POST', '/api/auth/refresh', null, { refreshToken }));
  const results = await Promise.all(requests);
  const nonOk = results.filter(r => r.status !== 200);
  assert(nonOk.length === 0, `[n=${n}] refresh race: all ${n} concurrent refreshes of the same token succeed (200) — none spuriously logged out or rate-limited (non-200 statuses seen: ${nonOk.map(r => r.status).join(',') || 'none'})`);
  // typeof check, not just !== null — a malformed/non-200 response could
  // have `refreshToken` be `undefined` (field absent entirely), which
  // `!== null` alone would miscount as "a real rotation happened".
  const realRotations = results.filter(r => r.status === 200 && typeof r.data.refreshToken === 'string').length;
  assert(realRotations === 1, `[n=${n}] refresh race: exactly 1 of ${n} performs a real rotation (gets a new refresh token), the rest get grace-window access-token-only responses, got ${realRotations}`);
  const allHaveValidAccessToken = results.every(r => !!r.data.token);
  assert(allHaveValidAccessToken, `[n=${n}] refresh race: every one of the ${n} responses includes a usable access token`);
}

// ── Level test 3: N DIFFERENT tenants save concurrently — isolation check ──
async function testTenantIsolationUnderLoad(req, db, jwtSecret, n) {
  const tenants = [];
  for (let i = 0; i < n; i++) {
    const shopName = `StressIsoTenant${n}_${i}`;
    const { token } = createStressTenant(db, jwtSecret, shopName, `9${String(n).padStart(2, '0')}${String(i).padStart(2, '0')}30003`);
    tenants.push({ shopName, token, i });
  }
  const results = await Promise.all(tenants.map(t =>
    req('PUT', '/api/data', t.token, { data: { settings: { shopName: t.shopName, uniqueMarker: t.i } }, expectedVersion: 1 })
  ));
  assert(results.every(r => r.status === 200), `[n=${n}] tenant isolation: all ${n} independent tenants save successfully with no cross-interference (different tenants never conflict with each other)`);

  const reads = await Promise.all(tenants.map(t => req('GET', '/api/data', t.token)));
  let allCorrect = true;
  reads.forEach((r, idx) => {
    if (!r.data || !r.data.data || r.data.data.settings.uniqueMarker !== tenants[idx].i || r.data.data.settings.shopName !== tenants[idx].shopName) {
      allCorrect = false;
    }
  });
  assert(allCorrect, `[n=${n}] tenant isolation: every tenant reads back EXACTLY its own data — zero cross-tenant leakage under concurrent load`);
}

async function main() {
  console.log('Extended concurrency stress test — 2 / 5 / 10 / 20 simulated concurrent actors');
  console.log('Each concurrency level gets its own fresh isolated server + DB — deliberately,');
  console.log('not just for cleanliness: /api/auth/refresh is rate-limited (30 req / 5 min,');
  console.log('a real production safeguard against refresh-token brute-forcing). Sharing one');
  console.log('server across all four levels was tried first and made the levels interfere');
  console.log("with each other's request budget (2+5+10+20=37 cumulative refresh calls trips");
  console.log('the 30-request limit partway through) — a test-harness artifact, not a bug in');
  console.log('the session logic itself (confirmed separately: an isolated n=20 refresh race');
  console.log('against a fresh server produces exactly 1 real rotation, every time). Each');
  console.log('level below is therefore its own independent scenario with its own budget,');
  console.log('which is also the more realistic thing to model anyway.\n');

  for (const n of [2, 5, 10, 20]) {
    console.log(`-- Concurrency level: ${n} --`);
    const srv = await startTestServer();
    const req = reqFactory(srv.baseUrl);
    const db = new Database(srv.dbPath);
    try {
      await testConcurrentSavesAtScale(req, db, srv.jwtSecret, n);
      await testRefreshRaceAtScale(req, db, srv.jwtSecret, n);
      await testTenantIsolationUnderLoad(req, db, srv.jwtSecret, n);
    } finally {
      db.close();
      srv.stop();
    }
    console.log('');
  }

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
