/**
 * server/test/maintenance.test.js — Phase 5D: Platform Maintenance &
 * Business Continuity (ShopERP side). Covers maintenanceGate enforcement
 * (locked/read-only/allowlist, for reads, writes, and login), and the real
 * end-to-end sync loop against a disposable Z-SUPERADMIN instance —
 * including the offline-continuity guarantee: ShopERP keeps enforcing its
 * last known-good cached policy when Z-SUPERADMIN becomes unreachable.
 *
 * Policy CREATION/resolution/scheduler logic is Z-SUPERADMIN's own concern
 * and is covered by platform/test/maintenance.test.js — this file only
 * tests what ShopERP itself owns: the gate, the sync client, the cache.
 *
 * Usage: node test/maintenance.test.js
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { startTestServer: startShopErpServer } = require('./testServer');
const { startTestServer: startPlatformServer } = require(path.join(__dirname, '..', '..', 'platform', 'test', 'testServer.js'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('waitFor: condition never became true within ' + timeoutMs + 'ms');
}

/** Seeds maintenance_cache directly against a running test server's own DB file — same "manipulate the file directly via a fresh connection" technique this repo already uses to fast-forward license transitions in other test files. */
function seedCache(dbPath, payload) {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO maintenance_cache (id, payload, last_synced_at, last_sync_status) VALUES (1, ?, datetime('now'), 'success') ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, last_synced_at = excluded.last_synced_at, last_sync_status = excluded.last_sync_status")
    .run(JSON.stringify(payload));
  db.close();
}
function readCache(dbPath) {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT * FROM maintenance_cache WHERE id = 1').get();
  db.close();
  return row;
}

async function main() {
  console.log('ShopERP Phase 5D — Platform Maintenance: integration tests\n');

  // ═══ Part 1: Gate enforcement, via direct cache seeding (no live Z-SUPERADMIN needed) ═══
  const server = await startShopErpServer();
  try {
    const mob = '95000' + String(Date.now()).slice(-5);
    const signup = await fetch(server.baseUrl + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Maintenance Test Shop', ownerName: 'Owner', mobile: mob, email: `maint${Date.now()}@example.com`, pin: '123456' }),
    }).then((r) => r.json());
    const db = new Database(server.dbPath);
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(signup.tenantId);
    db.close();
    await fetch(server.baseUrl + `/api/admin/registrations/${signup.tenantId}/approve`, { method: 'POST', headers: { 'X-Admin-Key': server.adminKey } });
    const login1 = await fetch(server.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mob, pin: '123456' }) }).then((r) => r.json());
    assert(!!login1.token, 'setup: a real, approved ShopERP tenant can log in normally with no maintenance configured');

    // ── Full lock blocks reads and writes ────────────────────────────────
    seedCache(server.dbPath, { platform: { scopeType: 'platform', mode: 'immediate', accessLevel: 'locked', status: 'active', message: 'Down for maintenance', eta: '30 minutes', endsAt: null, allowlistUsers: [], allowlistOrganizations: [] }, product: null, organizations: {}, upcoming: {} });
    const blockedGet = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + login1.token } });
    assert(blockedGet.status === 503, 'a platform-wide LOCKED window blocks GET /api/data (got ' + blockedGet.status + ')');
    const blockedBody = await blockedGet.json();
    assert(blockedBody.maintenanceActive === true && blockedBody.message === 'Down for maintenance', 'the 503 body carries maintenanceActive + the configured message');
    const blockedPut = await fetch(server.baseUrl + '/api/data', { method: 'PUT', headers: { Authorization: 'Bearer ' + login1.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {}, version: 1 }) });
    assert(blockedPut.status === 503, 'a LOCKED window also blocks PUT /api/data (got ' + blockedPut.status + ')');

    // ── Locked mode blocks LOGIN itself ──────────────────────────────────
    const blockedLogin = await fetch(server.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mob, pin: '123456' }) });
    assert(blockedLogin.status === 503, 'a LOCKED window also blocks a fresh login attempt (got ' + blockedLogin.status + ')');
    const wrongPinDuringLock = await fetch(server.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mob, pin: 'wrong1' }) });
    assert(wrongPinDuringLock.status === 401, 'a WRONG PIN during a lock still gets the generic invalid-credentials response, not a maintenance-shaped one (got ' + wrongPinDuringLock.status + ')');

    // ── Read-only mode blocks writes, allows reads and login ─────────────
    seedCache(server.dbPath, { platform: { scopeType: 'platform', mode: 'immediate', accessLevel: 'read_only', status: 'active', message: 'Read-only maintenance', eta: '', endsAt: null, allowlistUsers: [], allowlistOrganizations: [] }, product: null, organizations: {}, upcoming: {} });
    const readOnlyLogin = await fetch(server.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mob, pin: '123456' }) }).then((r) => r.json());
    assert(!!readOnlyLogin.token, 'read_only mode does NOT block login — a user can still sign in to at least view their data');
    const readOnlyGet = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + readOnlyLogin.token } });
    assert(readOnlyGet.status === 200, 'read_only mode allows GET /api/data (got ' + readOnlyGet.status + ')');
    const readOnlyPut = await fetch(server.baseUrl + '/api/data', { method: 'PUT', headers: { Authorization: 'Bearer ' + readOnlyLogin.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {}, version: 1 }) });
    assert(readOnlyPut.status === 503, 'read_only mode still blocks PUT /api/data (got ' + readOnlyPut.status + ')');

    // ── Allowlisted user bypasses a lock entirely ────────────────────────
    seedCache(server.dbPath, { platform: { scopeType: 'platform', mode: 'immediate', accessLevel: 'locked', status: 'active', message: 'Locked', eta: '', endsAt: null, allowlistUsers: [mob], allowlistOrganizations: [] }, product: null, organizations: {}, upcoming: {} });
    const allowlistedGet = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + login1.token } });
    assert(allowlistedGet.status === 200, 'a user allowlisted by mobile number bypasses a platform-wide lock entirely (got ' + allowlistedGet.status + ')');

    // ── Allowlisted organization bypasses a lock ─────────────────────────
    seedCache(server.dbPath, { platform: { scopeType: 'platform', mode: 'immediate', accessLevel: 'locked', status: 'active', message: 'Locked', eta: '', endsAt: null, allowlistUsers: [], allowlistOrganizations: ['shoperp:' + signup.tenantId] }, product: null, organizations: {}, upcoming: {} });
    const orgAllowlistedGet = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + login1.token } });
    assert(orgAllowlistedGet.status === 200, 'an organization allowlisted by its synthetic ref bypasses a platform-wide lock entirely (got ' + orgAllowlistedGet.status + ')');

    // ── Organization-specific window overrides platform for THAT tenant only ──
    seedCache(server.dbPath, {
      platform: { scopeType: 'platform', mode: 'immediate', accessLevel: 'read_only', status: 'active', message: 'platform read-only', eta: '', endsAt: null, allowlistUsers: [], allowlistOrganizations: [] },
      product: null,
      organizations: { [signup.tenantId]: { scopeType: 'organization', scopeRef: 'shoperp:' + signup.tenantId, mode: 'immediate', accessLevel: 'locked', status: 'active', message: 'this shop specifically is locked', eta: '', endsAt: null, allowlistUsers: [], allowlistOrganizations: [] } },
      upcoming: {},
    });
    const orgSpecificGet = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + login1.token } });
    assert(orgSpecificGet.status === 503, 'an organization-specific LOCKED window overrides a platform-wide READ_ONLY window for that tenant (got ' + orgSpecificGet.status + ')');

    // ── Emergency mode wins over a more specific non-emergency window ────
    seedCache(server.dbPath, {
      platform: { scopeType: 'platform', mode: 'emergency', accessLevel: 'locked', status: 'active', message: 'EMERGENCY', eta: '', endsAt: null, allowlistUsers: [], allowlistOrganizations: [] },
      product: null,
      organizations: { [signup.tenantId]: { scopeType: 'organization', scopeRef: 'shoperp:' + signup.tenantId, mode: 'scheduled', accessLevel: 'read_only', status: 'active', message: 'org read-only', eta: '', endsAt: null, allowlistUsers: [], allowlistOrganizations: [] } },
      upcoming: {},
    });
    const emergencyGet = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + login1.token } });
    assert(emergencyGet.status === 503, 'a platform-wide EMERGENCY window overrides a more specific, non-emergency organization window (got ' + emergencyGet.status + ')');

    // ── Retry-After header ────────────────────────────────────────────────
    seedCache(server.dbPath, { platform: { scopeType: 'platform', mode: 'immediate', accessLevel: 'locked', status: 'active', message: 'locked with ETA', eta: '', endsAt: "9999-01-01 00:00:00", allowlistUsers: [], allowlistOrganizations: [] }, product: null, organizations: {}, upcoming: {} });
    const withRetryAfter = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + login1.token } });
    assert(withRetryAfter.headers.get('retry-after') && Number(withRetryAfter.headers.get('retry-after')) > 0, 'a window with a known endsAt sets a real, positive Retry-After header');

    // ── No maintenance configured at all (empty cache) behaves exactly as before ──
    seedCache(server.dbPath, { platform: null, product: null, organizations: {}, upcoming: {} });
    const clearGet = await fetch(server.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + login1.token } });
    assert(clearGet.status === 200, 'with nothing active in the cache, requests work exactly as before this feature existed (got ' + clearGet.status + ')');

    // ── /api/maintenance/status reports the current state for the frontend ──
    seedCache(server.dbPath, { platform: { scopeType: 'platform', mode: 'immediate', accessLevel: 'read_only', status: 'active', message: 'status check', eta: 'soon', endsAt: null, allowlistUsers: [], allowlistOrganizations: [] }, product: null, organizations: {}, upcoming: {} });
    const statusCheck = await fetch(server.baseUrl + '/api/maintenance/status', { headers: { Authorization: 'Bearer ' + login1.token } }).then((r) => r.json());
    assert(statusCheck.readOnly === true && statusCheck.message === 'status check', 'GET /api/maintenance/status reports the current effective state for the frontend banner/lock-screen logic');

  } finally {
    server.stop();
  }

  // ═══ Part 2: Real end-to-end sync against a disposable Z-SUPERADMIN, including offline continuity ═══
  const platformServer = await startPlatformServer();
  let shopErpServer2;
  try {
    const H = { Authorization: 'Bearer ' + platformServer.ownerToken, 'Content-Type': 'application/json' };
    const keyResult = await fetch(platformServer.baseUrl + '/api/platform/api-keys', { method: 'POST', headers: H, body: JSON.stringify({ name: 'shoperp maintenance sync', permissions: ['view_only'] }) }).then((r) => r.json());
    assert(!!keyResult.rawKey, 'setup: created a real Platform API Key for ShopERP to sync with');

    shopErpServer2 = await startShopErpServer({
      envOverrides: {
        ZSUPERADMIN_BASE_URL: platformServer.baseUrl,
        ZSUPERADMIN_API_KEY: keyResult.rawKey,
        MAINTENANCE_SYNC_INTERVAL_MS: '500',
      },
    });

    // Create a real, active platform-wide maintenance window via Z-SUPERADMIN.
    const created = await fetch(platformServer.baseUrl + '/api/platform/maintenance/policies', {
      method: 'POST', headers: H, body: JSON.stringify({ scopeType: 'platform', mode: 'immediate', accessLevel: 'locked', message: 'real e2e sync test' }),
    }).then((r) => r.json());
    assert(created.policy && created.policy.status === 'active', 'setup: a real maintenance window was created and is active on the Z-SUPERADMIN side');

    // ShopERP's own sync loop (500ms interval, plus one immediate sync at boot) should pick this up for real.
    const mob2 = '96000' + String(Date.now()).slice(-5);
    const signup2 = await fetch(shopErpServer2.baseUrl + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopName: 'E2E Sync Shop', ownerName: 'Owner', mobile: mob2, email: `e2e${Date.now()}@example.com`, pin: '123456' }) }).then((r) => r.json());
    const db2 = new Database(shopErpServer2.dbPath);
    db2.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(signup2.tenantId);
    db2.close();
    await fetch(shopErpServer2.baseUrl + `/api/admin/registrations/${signup2.tenantId}/approve`, { method: 'POST', headers: { 'X-Admin-Key': shopErpServer2.adminKey } });

    await waitFor(() => {
      const cache = readCache(shopErpServer2.dbPath);
      return cache && cache.last_sync_status === 'success' && JSON.parse(cache.payload).platform;
    }, { timeoutMs: 8000 });
    assert(true, 'ShopERP genuinely pulled the real maintenance window from a real Z-SUPERADMIN instance within its own sync loop, with no manual cache seeding');

    const blockedLoginE2e = await fetch(shopErpServer2.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mob2, pin: '123456' }) });
    assert(blockedLoginE2e.status === 503, 'a real request against the real ShopERP instance is genuinely blocked by the policy pulled from the real Z-SUPERADMIN instance (got ' + blockedLoginE2e.status + ')');

    // ── Offline continuity: kill Z-SUPERADMIN, verify ShopERP keeps enforcing the LAST cached policy ──
    platformServer.stop();
    await sleep(700); // let at least one more sync interval elapse while Z-SUPERADMIN is down
    const cacheAfterOutage = readCache(shopErpServer2.dbPath);
    assert(cacheAfterOutage.last_sync_status === 'failure' && !!cacheAfterOutage.last_sync_error, 'once Z-SUPERADMIN is unreachable, the NEXT sync attempt is honestly recorded as a failure with a real error message');
    assert(JSON.parse(cacheAfterOutage.payload).platform && JSON.parse(cacheAfterOutage.payload).platform.status === 'active', 'the sync failure did NOT clear the cached payload — the last known-good policy is still there');
    const stillBlockedAfterOutage = await fetch(shopErpServer2.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mob2, pin: '123456' }) });
    assert(stillBlockedAfterOutage.status === 503, 'ShopERP CONTINUES enforcing the last-synced policy even though Z-SUPERADMIN is now completely unreachable — the core "business continuity" guarantee (got ' + stillBlockedAfterOutage.status + ')');

  } finally {
    if (shopErpServer2) shopErpServer2.stop();
    try { platformServer.stop(); } catch (e) { /* already stopped above */ }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
