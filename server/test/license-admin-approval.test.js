/**
 * Licensing regression test — admin approval + plan assignment (Phases 2-4).
 * See docs/architecture-review/RegistrationFlow.md and AdminOperations.md for
 * the design this verifies.
 *
 * Usage:  node server/test/license-admin-approval.test.js
 */
'use strict';

const crypto = require('crypto');
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

async function verifyEmailDirectly(db, tenantId) {
  // Test shortcut equivalent to clicking the real emailed link — see
  // license-email-verification.test.js for the actual token-flow coverage.
  db.prepare("UPDATE users SET email_verified_at = datetime('now'), email_verify_token_hash = NULL, email_verify_expires = NULL WHERE tenant_id = ?").run(tenantId);
}

async function main() {
  console.log('Licensing regression: admin approval + plan assignment (Phases 2-4)');

  // POST /api/auth/signup is rate-limited to 5 requests / 10 min per IP+path —
  // split across two isolated servers (2 signups, then 4) so no single run
  // trips that limit itself.
  console.log('Starting isolated test server (approve/reject flow)...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl + '  |  DB: ' + srv.dbPath);
  console.log('');

  const req = reqFactory(srv.baseUrl, srv.adminKey);
  const db = new Database(srv.dbPath);

  try {
    // ── Setup: two pending signups ──────────────────────────────────────────
    const s1 = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Approve Me Shop', ownerName: 'Deepak Rao', mobile: '9845612370',
      email: 'deepak@example.com', pin: '1111', requestedPlan: 'BASIC',
    }});
    const s2 = await req('POST', '/api/auth/signup', { body: {
      shopName: 'Reject Me Shop', ownerName: 'Meena Iyer', mobile: '9845612371',
      email: 'meena@example.com', pin: '2222',
    }});
    const t1 = s1.data.tenantId, t2 = s2.data.tenantId;

    // ── Registrations queue ──────────────────────────────────────────────────
    const queue = await req('GET', '/api/admin/registrations', { admin: true });
    assert(queue.status === 200, 'admin can fetch the registrations queue');
    assert(queue.data.registrations.length === 2, 'both pending signups appear in the queue');
    const entry1 = queue.data.registrations.find(r => r.tenantId === t1);
    assert(entry1.shopName === 'Approve Me Shop', 'queue entry reports shop name');
    assert(entry1.ownerName === 'Deepak Rao', 'queue entry reports owner name');
    assert(entry1.mobile === '9845612370' && entry1.email === 'deepak@example.com', 'queue entry reports mobile + email');
    assert(entry1.requestedPlan === 'BASIC', 'queue entry reports requested plan');
    assert(entry1.emailVerified === false, 'queue entry reports email not yet verified');
    assert(!!entry1.registeredAt, 'queue entry reports a registration date');

    // ── Approve blocked until email verified ────────────────────────────────
    const approveTooSoon = await req('POST', '/api/admin/registrations/' + t1 + '/approve', { admin: true, body: {} });
    assert(approveTooSoon.status === 400, 'approve is rejected before the owner has verified their email');

    await verifyEmailDirectly(db, t1);
    await verifyEmailDirectly(db, t2);

    // ── Approve with nothing pre-assigned — auto-defaults to 14-day TRIAL ───
    const approve1 = await req('POST', '/api/admin/registrations/' + t1 + '/approve', { admin: true, body: {} });
    assert(approve1.status === 200 && approve1.data.status === 'ACTIVE', 'approve succeeds once email is verified, tenant becomes ACTIVE');
    const lic1 = db.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(t1);
    assert(lic1.plan_code === 'TRIAL' && lic1.billing_cycle === 'trial', 'approve auto-defaults to TRIAL when nothing was pre-assigned');
    assert(!!lic1.expires_at, 'auto-defaulted trial has an expiry date set');
    const daysLeft1 = Math.round((new Date(lic1.expires_at).getTime() - Date.now()) / 86400000);
    assert(daysLeft1 === 14 || daysLeft1 === 13, 'auto-defaulted trial expires ~14 days out');
    assert(!!lic1.license_key && /^SHOP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(lic1.license_key), 'approve also generates a SHOP-XXXX-XXXX-XXXX license key');
    const approvedHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'APPROVED'").get(t1);
    assert(!!approvedHistory, 'an APPROVED license_history event was logged');

    // ── Approving twice is rejected ──────────────────────────────────────────
    const approveAgain = await req('POST', '/api/admin/registrations/' + t1 + '/approve', { admin: true, body: {} });
    assert(approveAgain.status === 400, 'approving an already-ACTIVE tenant is rejected');

    // ── Reject → ARCHIVED ─────────────────────────────────────────────────────
    const reject = await req('POST', '/api/admin/registrations/' + t2 + '/reject', { admin: true, body: { reason: 'duplicate signup' } });
    assert(reject.status === 200 && reject.data.status === 'ARCHIVED', 'reject moves the tenant to ARCHIVED');
    const rejectedHistory = db.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'REJECTED'").get(t2);
    assert(!!rejectedHistory && rejectedHistory.detail === 'duplicate signup', 'a REJECTED license_history event was logged with the given reason');
    const t2Row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(t2);
    assert(!!t2Row, 'rejected tenant row is NOT deleted — data is retained (Rule #1)');
    const t2Data = db.prepare('SELECT * FROM tenant_data WHERE tenant_id = ?').get(t2);
    assert(!!t2Data, 'rejected tenant_data row is NOT deleted');

    const queueAfter = await req('GET', '/api/admin/registrations', { admin: true });
    assert(queueAfter.data.registrations.length === 0, 'both tenants have left the PENDING_APPROVAL queue');
  } finally {
    db.close();
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\nStarting isolated test server (plan assignment / key generation)...');
  const srv2 = await startTestServer();
  console.log('Isolated server up: ' + srv2.baseUrl + '  |  DB: ' + srv2.dbPath);
  console.log('');
  const req2 = reqFactory(srv2.baseUrl, srv2.adminKey);
  const db2 = new Database(srv2.dbPath);

  try {
    // ── Assign-plan (explicit) ────────────────────────────────────────────────
    const s3 = await req2('POST', '/api/auth/signup', { body: {
      shopName: 'Premium Shop', ownerName: 'Rita Nair', mobile: '9845612372', email: 'rita@example.com', pin: '3333',
    }});
    const t3 = s3.data.tenantId;
    await verifyEmailDirectly(db2, t3);
    const assign = await req2('POST', '/api/admin/tenant-licenses/' + t3 + '/assign-plan', { admin: true, body: { planCode: 'PREMIUM', billingCycle: 'yearly' } });
    assert(assign.status === 200, 'assign-plan succeeds');
    assert(assign.data.planCode === 'PREMIUM' && assign.data.billingCycle === 'yearly', 'assign-plan applies the requested plan/cycle');
    assert(assign.data.deviceLimit === 5, "assign-plan uses PREMIUM's default device_limit (5) when no override given");
    await req2('POST', '/api/admin/registrations/' + t3 + '/approve', { admin: true, body: {} });
    const lic3 = db2.prepare('SELECT * FROM tenant_licenses WHERE tenant_id = ?').get(t3);
    assert(lic3.plan_code === 'PREMIUM', 'approve keeps a pre-assigned plan rather than overriding it with the TRIAL default');

    // ── Assign-plan with a device-limit override ─────────────────────────────
    const s4 = await req2('POST', '/api/auth/signup', { body: {
      shopName: 'Custom Limit Shop', ownerName: 'Farhan Ali', mobile: '9845612373', email: 'farhan@example.com', pin: '4444',
    }});
    const t4 = s4.data.tenantId;
    const assignOverride = await req2('POST', '/api/admin/tenant-licenses/' + t4 + '/assign-plan', { admin: true, body: { planCode: 'BASIC', billingCycle: 'monthly', deviceLimitOverride: 10 } });
    assert(assignOverride.data.deviceLimit === 10, 'assign-plan honors an explicit deviceLimitOverride');

    // ── Generate-license: format + uniqueness + regenerate ───────────────────
    const s5 = await req2('POST', '/api/auth/signup', { body: {
      shopName: 'Key Gen Shop', ownerName: 'Priya Das', mobile: '9845612374', email: 'priya@example.com', pin: '5555',
    }});
    const t5 = s5.data.tenantId;
    const gen1 = await req2('POST', '/api/admin/tenant-licenses/' + t5 + '/generate-license', { admin: true, body: {} });
    assert(gen1.status === 200 && /^SHOP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(gen1.data.licenseKey), 'generate-license produces a SHOP-XXXX-XXXX-XXXX key');
    const genAgain = await req2('POST', '/api/admin/tenant-licenses/' + t5 + '/generate-license', { admin: true, body: {} });
    assert(genAgain.status === 409, 'generating again without regenerate:true is rejected (409) — key already exists');
    const regen = await req2('POST', '/api/admin/tenant-licenses/' + t5 + '/generate-license', { admin: true, body: { regenerate: true } });
    assert(regen.status === 200 && regen.data.licenseKey !== gen1.data.licenseKey, 'regenerate:true replaces the key with a new, different one');
    const allKeys = db2.prepare('SELECT license_key FROM tenant_licenses WHERE license_key IS NOT NULL').all().map(r => r.license_key);
    assert(new Set(allKeys).size === allKeys.length, 'every generated license key in the database is unique');

    // ── Start-trial shortcut ──────────────────────────────────────────────────
    const s6 = await req2('POST', '/api/auth/signup', { body: {
      shopName: 'Trial Shortcut Shop', ownerName: 'Kiran Shah', mobile: '9845612375', email: 'kiran@example.com', pin: '6666',
    }});
    const t6 = s6.data.tenantId;
    const trial = await req2('POST', '/api/admin/tenant-licenses/' + t6 + '/start-trial', { admin: true, body: {} });
    assert(trial.status === 200 && trial.data.planCode === 'TRIAL' && trial.data.deviceLimit === 2, 'start-trial sets a 2-device TRIAL plan');
    const trialHistory = db2.prepare("SELECT * FROM license_history WHERE tenant_id = ? AND event_type = 'TRIAL_STARTED'").get(t6);
    assert(!!trialHistory, 'a TRIAL_STARTED license_history event was logged');

  } finally {
    db2.close();
    srv2.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
