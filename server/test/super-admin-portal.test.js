/**
 * Super Admin Portal (v1.0) — integration tests against server/local.js,
 * covering the mission's explicit testing list: Approve Registration,
 * Reject Registration, License Extension, Suspend License, Device Revoke,
 * Password Reset, Search, Filters, Export (data-layer), Audit Log — plus
 * the genuinely new endpoints this portal adds: dashboard-stats, the
 * customers list (search/filter/sort/pagination), customer detail,
 * account lockout/unlock, force-password-reset, login history, failed
 * logins, device rename, and email actions.
 *
 * Approve/Reject/Extend/Suspend/Device-Revoke already have deep coverage
 * in license-admin-approval.test.js / license-state-machine.test.js /
 * license-suspension.test.js / license-devices.test.js — this file adds
 * ONE assertion each confirming the NEW Super Admin Portal endpoints see
 * the same state those existing flows produce (i.e. the portal is reading
 * real data, not a parallel/stale view), rather than re-testing the
 * underlying business rules a second time.
 *
 * Uses the existing isolated testServer.js harness — a disposable SQLite
 * file + random port, torn down at the end. Never touches production data.
 *
 * Usage: node test/super-admin-portal.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startTestServer } = require('./testServer');

// Static regression check for a real XSS gap found and fixed during this
// build: several new Customer Detail action buttons embedded
// `JSON.stringify(shopName)` directly inside an onclick="..." HTML
// attribute. shopName has no character restriction at signup, so a shop
// name like `x"><script>...` would emit a raw, unescaped `"` that closes
// the attribute early, letting the browser parse the rest as live HTML —
// confirmed exploitable with a live reproduction before the fix. Fixed by
// wrapping every such call in esc(...) too (esc(JSON.stringify(...))),
// which HTML-entity-encodes the quotes JSON.stringify itself never
// escapes. This check ensures no future edit reintroduces a bare,
// unescaped JSON.stringify(b.___) inside the Customer Detail modal.
function checkNoUnescapedJsonStringifyInOnclick() {
  const htmlPath = path.join(__dirname, '..', '..', 'app', 'ShopERP_Pro_v8.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('function admPageSaasDashboard');
  const end = html.indexOf('function admPageSettings');
  const block = html.slice(start, end);
  const unescaped = [];
  let idx = block.indexOf('JSON.stringify(');
  while (idx !== -1) {
    const precedingChars = block.slice(Math.max(0, idx - 4), idx);
    if (precedingChars !== 'esc(') unescaped.push(block.slice(idx, idx + 40));
    idx = block.indexOf('JSON.stringify(', idx + 1);
  }
  return unescaped;
}

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

async function signupAndApprove(baseUrl, adminKey, dbPath, { shopName, ownerName, mobile, email, pin }) {
  const signup = await fetch(baseUrl + '/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopName, ownerName, mobile, email, pin }),
  }).then(r => r.json());
  verifyEmailDirectly(dbPath, signup.tenantId);
  await fetch(baseUrl + `/api/admin/registrations/${signup.tenantId}/approve`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } });
  return signup.tenantId;
}

async function main() {
  console.log('Super Admin Portal (v1.0): integration tests against server/local.js');
  console.log('');

  const unescapedJsonStringify = checkNoUnescapedJsonStringifyInOnclick();
  assert(unescapedJsonStringify.length === 0, `no bare, unescaped JSON.stringify(...) calls remain inside the Customer Detail modal's onclick attributes (a shop name containing \`x"><script>\` was confirmed to break out of the attribute and inject live HTML before this fix)${unescapedJsonStringify.length ? ' — found: ' + unescapedJsonStringify.join(' | ') : ''}`);

  const server = await startTestServer();
  const { baseUrl, adminKey } = server;

  try {
    // ── Setup: two approved tenants, one pending registration ────────────
    const mobA = '95000' + String(Date.now()).slice(-5);
    const tenantA = await signupAndApprove(baseUrl, adminKey, server.dbPath, {
      shopName: 'Portal Test Shop A', ownerName: 'Anita Sharma', mobile: mobA, email: `a${Date.now()}@example.com`, pin: '111111',
    });
    const mobB = '95001' + String(Date.now()).slice(-5);
    const tenantB = await signupAndApprove(baseUrl, adminKey, server.dbPath, {
      shopName: 'Portal Test Shop B', ownerName: 'Bilal Khan', mobile: mobB, email: `b${Date.now()}@example.com`, pin: '222222',
    });
    const mobPending = '95002' + String(Date.now()).slice(-5);
    const pendingSignup = await fetch(baseUrl + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Portal Pending Shop', ownerName: 'Chetan Rao', mobile: mobPending, email: `c${Date.now()}@example.com`, pin: '333333' }),
    }).then(r => r.json());
    verifyEmailDirectly(server.dbPath, pendingSignup.tenantId);
    assert(!!tenantA && !!tenantB && !!pendingSignup.tenantId, 'setup: two approved tenants + one email-verified pending registration created');

    // ── Dashboard stats ──────────────────────────────────────────────────
    const stats = await fetch(baseUrl + '/api/admin/dashboard-stats', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(stats.totalShops === 3, `dashboard-stats reports the correct total shop count (got ${stats.totalShops})`);
    assert(stats.pendingRegistrations === 1, `dashboard-stats reports exactly 1 pending registration (got ${stats.pendingRegistrations})`);
    assert(stats.activeLicenses === 2, `dashboard-stats reports exactly 2 active licenses (got ${stats.activeLicenses})`);
    assert(Array.isArray(stats.recentRegistrations) && stats.recentRegistrations.length === 3, 'dashboard-stats includes all 3 shops in recentRegistrations (last 10)');
    const noAuthStats = await fetch(baseUrl + '/api/admin/dashboard-stats');
    assert(noAuthStats.status === 401, 'dashboard-stats requires a valid admin session (401 without X-Admin-Key)');

    // ── Approve Registration (mission's explicit test item) ──────────────
    const approve = await fetch(baseUrl + `/api/admin/registrations/${pendingSignup.tenantId}/approve`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(approve.ok && approve.status === 'ACTIVE', 'Approve Registration: the pending shop is now ACTIVE');
    const detailAfterApprove = await fetch(baseUrl + `/api/admin/customers/${pendingSignup.tenantId}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(detailAfterApprove.license.status === 'ACTIVE', 'the new Customer Detail endpoint reflects the approval immediately');

    // ── Reject Registration (mission's explicit test item) ───────────────
    const mobReject = '95003' + String(Date.now()).slice(-5);
    const rejectSignup = await fetch(baseUrl + '/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Portal Reject Shop', ownerName: 'Deepa Iyer', mobile: mobReject, email: `d${Date.now()}@example.com`, pin: '444444' }),
    }).then(r => r.json());
    verifyEmailDirectly(server.dbPath, rejectSignup.tenantId);
    const reject = await fetch(baseUrl + `/api/admin/registrations/${rejectSignup.tenantId}/reject`, { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'duplicate signup' }) }).then(r => r.json());
    assert(reject.ok && reject.status === 'ARCHIVED', 'Reject Registration: the shop is now ARCHIVED');

    // ── Customers list: search, filters, sort, pagination ────────────────
    const searchByOwner = await fetch(baseUrl + '/api/admin/customers?q=Anita', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(searchByOwner.customers.length === 1 && searchByOwner.customers[0].tenantId === tenantA, 'Search: finds Tenant A by owner name alone');
    const searchByShop = await fetch(baseUrl + '/api/admin/customers?q=Shop+B', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(searchByShop.customers.some(c => c.tenantId === tenantB), 'Search: finds Tenant B by (partial) shop name');
    const searchByMobile = await fetch(baseUrl + '/api/admin/customers?q=' + mobA, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(searchByMobile.customers.some(c => c.tenantId === tenantA), 'Search: finds Tenant A by mobile number');

    const filterActive = await fetch(baseUrl + '/api/admin/customers?status=ACTIVE', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(filterActive.customers.every(c => c.status === 'ACTIVE') && filterActive.customers.length >= 3, 'Filters: status=ACTIVE returns only ACTIVE tenants');
    const filterArchived = await fetch(baseUrl + '/api/admin/customers?status=ARCHIVED', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(filterArchived.customers.length === 1 && filterArchived.customers[0].tenantId === rejectSignup.tenantId, 'Filters: status=ARCHIVED returns exactly the rejected shop');
    const filterPlan = await fetch(baseUrl + '/api/admin/customers?plan=TRIAL', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(filterPlan.customers.every(c => c.planCode === 'TRIAL'), 'Filters: plan=TRIAL returns only TRIAL-plan tenants');

    const sortedAsc = await fetch(baseUrl + '/api/admin/customers?sort=shopName&dir=asc&status=ACTIVE', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    const names = sortedAsc.customers.map(c => c.shopName);
    const sortedCopy = [...names].sort();
    assert(JSON.stringify(names) === JSON.stringify(sortedCopy), 'Sort: shopName ascending is genuinely sorted, not just returned in insertion order');

    const page1 = await fetch(baseUrl + '/api/admin/customers?pageSize=2&page=1', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    const page2 = await fetch(baseUrl + '/api/admin/customers?pageSize=2&page=2', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(page1.customers.length === 2 && page1.total >= 4, 'Pagination: pageSize=2 returns exactly 2 rows with the real total count');
    assert(page2.customers.length >= 1 && page1.customers[0].tenantId !== page2.customers[0].tenantId, 'Pagination: page 2 returns different rows than page 1');

    // A SQL-injection-shaped sort column is rejected via the sort whitelist,
    // not passed through to ORDER BY — falls back to the safe default.
    const sqliSort = await fetch(baseUrl + "/api/admin/customers?sort=" + encodeURIComponent("shopName; DROP TABLE tenants;--"), { headers: { 'X-Admin-Key': adminKey } });
    assert(sqliSort.status === 200, 'a SQL-injection-shaped `sort` query param does not crash the endpoint (whitelist-mapped, never interpolated raw)');
    const tenantsStillExist = await fetch(baseUrl + '/api/admin/customers', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(tenantsStillExist.total >= 4, 'the tenants table was NOT dropped by the SQL-injection-shaped sort attempt');

    // ── License Extension (mission's explicit test item) ─────────────────
    const extend = await fetch(baseUrl + `/api/admin/tenant-licenses/${tenantA}/extend`, { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 30 }) }).then(r => r.json());
    assert(extend.ok, 'License Extension: extend endpoint succeeds');
    const detailAfterExtend = await fetch(baseUrl + `/api/admin/customers/${tenantA}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(detailAfterExtend.license.expiresAt === extend.expiresAt, 'the new Customer Detail endpoint reflects the extended expiry immediately');

    // ── Suspend License (mission's explicit test item) ────────────────────
    const suspend = await fetch(baseUrl + `/api/admin/tenant-licenses/${tenantB}/suspend`, { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'payment overdue' }) }).then(r => r.json());
    assert(suspend.ok, 'Suspend License: suspend endpoint succeeds');
    const listSuspended = await fetch(baseUrl + '/api/admin/customers?status=SUSPENDED', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(listSuspended.customers.some(c => c.tenantId === tenantB), 'the Customers list\'s status filter correctly shows the newly-suspended tenant');
    await fetch(baseUrl + `/api/admin/tenant-licenses/${tenantB}/reactivate`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } }); // restore for later assertions

    // ── Device Revoke (mission's explicit test item) ──────────────────────
    await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobA, pin: '111111', deviceId: 'portal-test-device-1' }) });
    const devicesBefore = await fetch(baseUrl + `/api/admin/tenant-licenses/${tenantA}/devices`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    const deviceRowId = devicesBefore.devices[0].id;
    const revoke = await fetch(baseUrl + `/api/admin/tenant-licenses/${tenantA}/devices/${deviceRowId}/remove`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(revoke.ok, 'Device Revoke: remove endpoint succeeds');
    const detailAfterRevoke = await fetch(baseUrl + `/api/admin/customers/${tenantA}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(detailAfterRevoke.devices.find(d => d.id === deviceRowId).isActive === false, 'the new Customer Detail endpoint shows the device as revoked (isActive:false)');

    // ── Device Rename (new) ────────────────────────────────────────────
    const rename = await fetch(baseUrl + `/api/admin/customers/${tenantA}/devices/${deviceRowId}/rename`, { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'Front Counter Tablet' }) }).then(r => r.json());
    assert(rename.ok && rename.deviceName === 'Front Counter Tablet', 'Device Rename: sets the device name');
    const idorRename = await fetch(baseUrl + `/api/admin/customers/${tenantB}/devices/${deviceRowId}/rename`, { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'Hijacked' }) });
    assert(idorRename.status === 404, 'Device Rename is tenant-scoped: Tenant B cannot rename Tenant A\'s device row by ID (IDOR check)');

    // ── Password Reset (mission's explicit test item, both variants) ────
    const owner = await fetch(baseUrl + `/api/admin/customers/${tenantA}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    const ownerId = owner.activity.users.find(u => u.role === 'owner').id;
    const manualReset = await fetch(baseUrl + '/api/admin/reset-user-pin', { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: ownerId, newPin: '999999' }) }).then(r => r.json());
    assert(manualReset.ok, 'Password Reset (manual PIN): reset-user-pin endpoint succeeds');
    const loginWithResetPin = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobA, pin: '999999' }) });
    assert(loginWithResetPin.status === 200, 'the manually-reset PIN genuinely works for a real login');
    const forceReset = await fetch(baseUrl + `/api/admin/customers/${tenantA}/force-password-reset`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(forceReset.ok && /^\d{6}$/.test(forceReset.newPin), 'Force Password Reset: generates a real 6-digit PIN');
    const loginWithForcedPin = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobA, pin: forceReset.newPin }) });
    assert(loginWithForcedPin.status === 200, 'the force-reset PIN genuinely works for a real login');

    // ── Account lockout + Unlock Account ─────────────────────────────────
    for (let i = 0; i < 5; i++) {
      await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobB, pin: 'wrong1' }) });
    }
    const lockedOut = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobB, pin: '222222' }) });
    assert(lockedOut.status === 423, `after 5 failed attempts, even the CORRECT PIN is rejected with 423 (account locked) (got ${lockedOut.status})`);
    const failedLogins = await fetch(baseUrl + `/api/admin/customers/${tenantB}/failed-logins`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(failedLogins.failedLogins.length === 5, `Failed Login Attempts view shows exactly 5 recorded failures (got ${failedLogins.failedLogins.length})`);
    const detailLocked = await fetch(baseUrl + `/api/admin/customers/${tenantB}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(detailLocked.activity.accountLocked === true, 'Customer Detail correctly reports accountLocked:true');
    const unlock = await fetch(baseUrl + `/api/admin/customers/${tenantB}/unlock`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(unlock.ok, 'Unlock Account: unlock endpoint succeeds');
    const loginAfterUnlock = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobB, pin: '222222' }) });
    assert(loginAfterUnlock.status === 200, 'after Unlock Account, the correct PIN logs in successfully again');

    // ── Login History (new) ───────────────────────────────────────────
    const loginHistory = await fetch(baseUrl + `/api/admin/customers/${tenantB}/login-history`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(loginHistory.logins.length >= 1, 'Login History reflects at least the successful post-unlock login');

    // ── Email actions (new) — SMTP is fake in this harness, so we assert
    // the endpoints are reachable and fail cleanly (502), not that mail is
    // actually delivered (no real SMTP server exists in this test env). ─
    const welcomeEmail = await fetch(baseUrl + `/api/admin/customers/${tenantA}/email/welcome`, { method: 'POST', headers: { 'X-Admin-Key': adminKey } });
    assert(welcomeEmail.status === 502, 'Send Welcome Email: reachable, fails cleanly (502) against the harness\'s fake SMTP host — not a crash');
    const customEmailMissingBody = await fetch(baseUrl + `/api/admin/customers/${tenantA}/email/custom`, { method: 'POST', headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert(customEmailMissingBody.status === 400, 'Send Custom Email validates subject/body are required');

    // ── Audit Log (mission's explicit test item) ──────────────────────
    const auditForA = await fetch(baseUrl + `/api/admin/audit-log?tenantId=${tenantA}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    const eventTypes = auditForA.entries.map(e => e.eventType);
    assert(eventTypes.includes('EXTENDED'), 'Audit Log includes the EXTENDED event for Tenant A');
    assert(eventTypes.includes('PASSWORD_RESET'), 'Audit Log includes PASSWORD_RESET events (both manual and forced resets)');
    assert(eventTypes.includes('DEVICE_RENAMED'), 'Audit Log includes the DEVICE_RENAMED event');
    assert(auditForA.entries.every(e => e.tenantId === tenantA), 'Audit Log filtered by tenantId returns ONLY that tenant\'s events');
    const auditByEventType = await fetch(baseUrl + '/api/admin/audit-log?eventType=ACCOUNT_LOCKED', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(auditByEventType.entries.length >= 1 && auditByEventType.entries.every(e => e.eventType === 'ACCOUNT_LOCKED'), 'Audit Log filtered by eventType returns only matching events (Tenant B\'s lockout)');

    // ── Export (data-layer): the customers endpoint returns everything the ─
    // frontend's CSV/Excel/PDF export functions need, in one response ─────
    const exportData = await fetch(baseUrl + '/api/admin/customers?pageSize=100', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    const exportableFields = ['shopName', 'ownerName', 'email', 'mobile', 'licenseKey', 'planCode', 'status', 'createdAt', 'expiresAt', 'lastLogin', 'devicesUsed', 'deviceLimit'];
    assert(exportData.customers.length > 0 && exportableFields.every(f => Object.prototype.hasOwnProperty.call(exportData.customers[0], f)), 'Export: the customers list response contains every field the CSV/Excel/PDF export functions render');

    // ── Global Search across shop/owner/email/mobile/license/GST ─────────
    const globalSearch = await fetch(baseUrl + '/api/admin/search?q=Bilal', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(globalSearch.results.some(r => r.tenantId === tenantB), 'Global Search finds Tenant B by owner name');
    const globalSearchByLicenseKey = await fetch(baseUrl + '/api/admin/search?q=' + encodeURIComponent(exportData.customers.find(c => c.tenantId === tenantA).licenseKey.slice(0, 8)), { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(globalSearchByLicenseKey.results.some(r => r.tenantId === tenantA), 'Global Search finds Tenant A by a partial license key');
    const emptySearch = await fetch(baseUrl + '/api/admin/search', { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(Array.isArray(emptySearch.results) && emptySearch.results.length === 0, 'Global Search with no query returns an empty result set, not every tenant');

    // ── XSS-shaped shop name: server stores/returns it verbatim (correct — ─
    // sanitization is a rendering-time concern, not a storage-time one), and
    // the customers/search/detail endpoints all return it as plain JSON
    // (never pre-rendered HTML), so there is no server-side HTML-injection
    // surface regardless of what the frontend does with it. ──────────────
    const xssShopName = 'x"><script>alert(1)</script>';
    const mobXss = '95004' + String(Date.now()).slice(-5);
    const xssTenantId = await signupAndApprove(baseUrl, adminKey, server.dbPath, {
      shopName: xssShopName, ownerName: 'XSS Test Owner', mobile: mobXss, email: `xss${Date.now()}@example.com`, pin: '555555',
    });
    const xssDetail = await fetch(baseUrl + `/api/admin/customers/${xssTenantId}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json());
    assert(xssDetail.business.shopName === xssShopName, 'the server stores and returns an XSS-shaped shop name completely verbatim, as plain JSON — no server-side mangling, and (per the static check above) the frontend now HTML-escapes it safely at render time');

  } finally {
    server.stop();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
