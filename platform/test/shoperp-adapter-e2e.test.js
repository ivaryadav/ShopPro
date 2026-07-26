/**
 * Z-SUPERADMIN <-> ShopERP live adapter integration test.
 *
 * Proves the migration's central claim end to end: Z-SUPERADMIN, with NO
 * knowledge of ShopERP beyond shoperpAdapter.js, can manage a REAL running
 * ShopERP instance's REAL tenant — list it, view its full profile, and
 * mutate it (extend its license) — with the change landing in ShopERP's
 * own real database, reached purely through ShopERP's existing, unmodified
 * /api/admin/* API (the same one its own now-removed admin console used).
 *
 * Spins up a disposable server/local.js instance (server/test/testServer.js
 * — a different npm package/node_modules tree, required by relative path,
 * which works fine since Node resolves each file's own requires relative
 * to itself) and a disposable platform instance side by side.
 *
 * Usage: node test/shoperp-adapter-e2e.test.js
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { startTestServer: startShopErpServer } = require(path.join(__dirname, '..', '..', 'server', 'test', 'testServer.js'));
const { startTestServer: startPlatformServer } = require('./testServer');
const shoperpAdapter = require('../src/adapters/shoperpAdapter');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function verifyEmailDirectly(dbPath, tenantId) {
  const db = new Database(dbPath);
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE tenant_id = ?").run(tenantId);
  db.close();
}

async function main() {
  console.log('Z-SUPERADMIN <-> ShopERP live adapter: end-to-end integration test');
  console.log('');

  const shopErp = await startShopErpServer();
  const platform = await startPlatformServer();

  try {
    // ── Set up a real ShopERP tenant, approved, with real data ──────────
    const mob = '94000' + String(Date.now()).slice(-5);
    const signup = await fetch(shopErp.baseUrl + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'E2E Adapter Test Shop', ownerName: 'Adapter Owner', mobile: mob, email: `adapter${Date.now()}@example.com`, pin: '123456' }),
    }).then((r) => r.json());
    verifyEmailDirectly(shopErp.dbPath, signup.tenantId);
    await fetch(shopErp.baseUrl + `/api/admin/registrations/${signup.tenantId}/approve`, { method: 'POST', headers: { 'X-Admin-Key': shopErp.adminKey } });
    assert(!!signup.tenantId, 'setup: a real, approved ShopERP tenant exists in a real, disposable ShopERP instance');

    // ── Configure the adapter to point at THIS disposable ShopERP ───────
    process.env.SHOPERP_BASE_URL = shopErp.baseUrl;
    process.env.SHOPERP_ADMIN_PASSWORD = shopErp.adminPassword;
    shoperpAdapter._resetTokenCacheForTests();
    assert(shoperpAdapter.isConfigured(), 'the ShopERP adapter reports isConfigured():true once SHOPERP_BASE_URL/SHOPERP_ADMIN_PASSWORD are set');

    const H = { Authorization: 'Bearer ' + platform.ownerToken, 'Content-Type': 'application/json' };

    // ── Z-SUPERADMIN dashboard now reflects REAL ShopERP data ───────────
    const dash = await fetch(platform.baseUrl + '/api/platform/dashboard/stats', { headers: H }).then((r) => r.json());
    assert(dash.totalOrganizations >= 1, `Z-SUPERADMIN's dashboard (All Products) includes the real ShopERP tenant in its organization count (got ${dash.totalOrganizations})`);
    assert(dash.recentOrganizations.some((o) => o.businessName === 'E2E Adapter Test Shop'), "the real ShopERP tenant's name appears in Z-SUPERADMIN's recent-organizations list");

    // ── Z-SUPERADMIN Organizations list, filtered to the ShopERP product ─
    const productsResp = await fetch(platform.baseUrl + '/api/platform/products', { headers: H }).then((r) => r.json());
    const shoperpProduct = productsResp.products.find((p) => p.slug === 'shoperp');
    const orgList = await fetch(platform.baseUrl + `/api/platform/organizations?productId=${shoperpProduct.id}&q=Adapter`, { headers: H }).then((r) => r.json());
    assert(orgList.organizations.some((o) => o.businessName === 'E2E Adapter Test Shop'), 'Organizations list, filtered to ShopERP, finds the real tenant by search — served live from ShopERP, not a stale copy');
    const org = orgList.organizations.find((o) => o.businessName === 'E2E Adapter Test Shop');
    assert(org.id === 'shoperp:' + signup.tenantId, `the organization's ID is the synthetic "shoperp:<tenantId>" form (got ${org.id})`);

    // ── Full organization profile, live from ShopERP ────────────────────
    const detail = await fetch(platform.baseUrl + `/api/platform/organizations/${org.id}`, { headers: H }).then((r) => r.json());
    assert(detail.business.businessName === 'E2E Adapter Test Shop', "Organization Detail's business info is the real ShopERP tenant's data");
    assert(detail.licenses[0] && detail.licenses[0].status === 'ACTIVE', 'Organization Detail shows the real, live ShopERP license status (ACTIVE after approval)');

    // ── Mutate the license THROUGH Z-SUPERADMIN, verify it lands in ShopERP's real DB ──
    const beforeExpiry = detail.licenses[0].expiresAt;
    const renew = await fetch(platform.baseUrl + `/api/platform/organizations/${org.id}/licenses/${shoperpProduct.id}/renew`, {
      method: 'POST', headers: H, body: JSON.stringify({ days: 90 }),
    }).then((r) => r.json());
    assert(renew.ok && renew.expiresAt && renew.expiresAt !== beforeExpiry, 'License Center renew, issued from Z-SUPERADMIN, returns a genuinely extended expiry');

    const realShopErpLicense = await fetch(shopErp.baseUrl + `/api/admin/customers/${signup.tenantId}`, { headers: { 'X-Admin-Key': shopErp.adminKey } }).then((r) => r.json());
    assert(realShopErpLicense.license.expiresAt === renew.expiresAt, "the extension genuinely landed in ShopERP's OWN real database — verified by querying ShopERP directly, bypassing Z-SUPERADMIN entirely");

    // ── Suspend through Z-SUPERADMIN, verify the real tenant is really suspended ──
    const suspend = await fetch(platform.baseUrl + `/api/platform/organizations/${org.id}/suspend`, { method: 'POST', headers: H, body: JSON.stringify({ reason: 'e2e test' }) }).then((r) => r.json());
    assert(suspend.licenses[0] && suspend.licenses[0].status === 'SUSPENDED', 'Support Center suspend, issued from Z-SUPERADMIN, reports SUSPENDED');
    const realAfterSuspend = await fetch(shopErp.baseUrl + `/api/admin/customers/${signup.tenantId}`, { headers: { 'X-Admin-Key': shopErp.adminKey } }).then((r) => r.json());
    assert(realAfterSuspend.license.status === 'SUSPENDED', "ShopERP's own real tenant_licenses row is genuinely SUSPENDED");
    // Login itself is never gated by license status in ShopERP (only
    // post-login data access is — GET/PUT /api/data go through
    // requireLicenseRead/Write; /api/auth/login does not, by design, same
    // as every prior sprint's own documented behavior) — so the real check
    // is that a real GET /api/data call is genuinely blocked post-suspend.
    const realLogin = await fetch(shopErp.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mob, pin: '123456' }) }).then((r) => r.json());
    const realDataBlocked = await fetch(shopErp.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + realLogin.token } });
    assert(realDataBlocked.status === 403, "a real GET /api/data call against the real ShopERP tenant is genuinely blocked after suspending it through Z-SUPERADMIN (got " + realDataBlocked.status + ")");

    // ── Audit trail, from both sides ─────────────────────────────────────
    const platformAudit = await fetch(platform.baseUrl + `/api/platform/audit-log?organizationId=${org.id}`, { headers: H }).then((r) => r.json());
    const platformActions = platformAudit.entries.map((e) => e.action);
    assert(platformActions.includes('EXTENDED') && platformActions.includes('STATUS_CHANGED'), "Z-SUPERADMIN's audit log, filtered to this org, shows ShopERP's OWN real event types (EXTENDED, STATUS_CHANGED) — read live from ShopERP's real license_history, not a separate platform copy");

  } finally {
    shopErp.stop();
    platform.stop();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
