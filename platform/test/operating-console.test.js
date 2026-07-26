/**
 * platform/test/operating-console.test.js — Phase 5A: Platform Operations.
 *
 * Covers the capabilities added on top of the Platform Foundation: the
 * Organization 360 Workspace (Notes/Renewals/Security/Activity Timeline),
 * System Health, the Alerts & Notifications Center, and Reports & Trends.
 * Runs against a disposable in-process instance via testServer.js.
 *
 * Usage: node test/operating-console.test.js
 */
'use strict';

const { startTestServer } = require('./testServer');
const { getDb } = require('../src/database/connection');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Z-SUPERADMIN Phase 5A — Platform Operations: integration tests\n');
  const server = await startTestServer();
  const H = { Authorization: 'Bearer ' + server.ownerToken, 'Content-Type': 'application/json' };

  try {
    // ── Unauthenticated liveness probe ──────────────────────────────────
    const healthz = await fetch(server.baseUrl + '/healthz').then((r) => r.json());
    assert(healthz.status === 'ok' && typeof healthz.uptime === 'number', 'GET /healthz is unauthenticated and reports ok status + uptime');

    // ── System Health (authenticated) ───────────────────────────────────
    const health = await fetch(server.baseUrl + '/api/platform/health', { headers: H }).then((r) => r.json());
    assert(health.platformStatus === 'operational', 'System Health reports platformStatus operational');
    assert(health.database.status === 'ok', 'System Health reports database status ok');
    assert(Array.isArray(health.services) && health.services.some((s) => s.slug === 'shoperp'), 'System Health lists the shoperp product service');
    assert(health.jobs.count === 0 && typeof health.jobs.note === 'string', 'System Health honestly reports zero scheduled jobs configured (a later milestone), not fake data');
    assert(health.version.platform && health.version.node, 'System Health reports platform + Node version information');
    const unauthedHealth = await fetch(server.baseUrl + '/api/platform/health');
    assert(unauthedHealth.status === 401, 'GET /api/platform/health requires authentication (got ' + unauthedHealth.status + ')');

    // ── Set up a local organization + product + near-expiry license ─────
    const org = await fetch(server.baseUrl + '/api/platform/organizations', {
      method: 'POST', headers: H, body: JSON.stringify({ businessName: 'Acme Diagnostics' }),
    }).then((r) => r.json()).then((d) => d.organization);
    assert(!!org.id, 'setup: a local organization was created (defaults to PENDING_APPROVAL)');

    const attach = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/products`, {
      method: 'POST', headers: H, body: JSON.stringify({ productSlug: 'shoperp' }),
    }).then((r) => r.json());
    const productId = attach.products.find((p) => p.productSlug === 'shoperp').productId;
    assert(!!productId, 'setup: shoperp product attached to the local organization with an auto-created TRIAL license');

    // Backdate the license directly (same fast-forward technique this whole engagement's test suites already use) to exercise expiry-driven alerts/renewals without waiting real time.
    getDb().prepare("UPDATE platform_licenses SET status='ACTIVE', expires_at = datetime('now','+3 days') WHERE organization_id=? AND product_id=?").run(org.id, productId);

    // ── Organization 360: Renewals ───────────────────────────────────────
    const renewals = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/renewals`, { headers: H }).then((r) => r.json());
    const renewalLic = renewals.licenses.find((l) => l.productId === productId);
    assert(!!renewalLic && renewalLic.urgent === true, 'Renewals view flags a license expiring in 3 days as urgent (<=30 days)');

    // ── Organization 360: Internal Notes ─────────────────────────────────
    const noteCreate = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/notes`, {
      method: 'POST', headers: H, body: JSON.stringify({ note: 'Customer called about onboarding — scheduled a follow-up.' }),
    }).then((r) => r.json());
    assert(noteCreate.note && noteCreate.note.authorEmail === server.ownerEmail, 'Internal Notes: a note is created and attributed to the acting platform user');
    const notesList = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/notes`, { headers: H }).then((r) => r.json());
    assert(notesList.notes.length === 1 && notesList.notes[0].note.includes('onboarding'), 'Internal Notes: the note round-trips on GET');
    const emptyNote = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/notes`, { method: 'POST', headers: H, body: JSON.stringify({ note: '   ' }) });
    assert(emptyNote.status === 400, 'Internal Notes: a blank note is rejected (got ' + emptyNote.status + ')');

    // ── Organization 360: Security (local org — no adapter identity system) ──
    const security = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/security`, { headers: H }).then((r) => r.json());
    assert(Array.isArray(security.loginHistory) && Array.isArray(security.failedLogins) && Array.isArray(security.securityEvents), 'Security view returns well-shaped empty arrays for a locally-managed organization, not a crash');

    // ── Organization 360: Activity Timeline merges audit + notes ─────────
    await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/approve`, { method: 'POST', headers: H });
    const activity = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/activity`, { headers: H }).then((r) => r.json());
    assert(activity.timeline.some((e) => e.type === 'note'), 'Activity Timeline includes the internal note');
    assert(activity.timeline.some((e) => e.type === 'audit'), 'Activity Timeline includes the audit-logged approve action');
    const sorted = activity.timeline.every((e, i) => i === 0 || new Date(activity.timeline[i - 1].timestamp) >= new Date(e.timestamp));
    assert(sorted, 'Activity Timeline is sorted newest-first across merged sources');

    // ── Alerts & Notifications Center ────────────────────────────────────
    const alerts1 = await fetch(server.baseUrl + '/api/platform/alerts', { headers: H }).then((r) => r.json());
    const expiryAlert = alerts1.alerts.find((a) => a.key === `license-expiring:${org.id}:${productId}`);
    assert(!!expiryAlert && expiryAlert.severity === 'warning', 'Alerts Center computes a warning-severity alert for the license expiring in 3 days');
    assert(alerts1.unreadCount >= 1, 'Alerts Center reports at least one unread alert');

    // A second, separate org with an expired-into-grace license produces a critical alert.
    const org2 = await fetch(server.baseUrl + '/api/platform/organizations', { method: 'POST', headers: H, body: JSON.stringify({ businessName: 'Beta Clinic' }) }).then((r) => r.json()).then((d) => d.organization);
    const attach2 = await fetch(server.baseUrl + `/api/platform/organizations/${org2.id}/products`, { method: 'POST', headers: H, body: JSON.stringify({ productSlug: 'shoperp' }) }).then((r) => r.json());
    const productId2 = attach2.products.find((p) => p.productSlug === 'shoperp').productId;
    getDb().prepare("UPDATE platform_licenses SET status='READ_ONLY', expires_at = datetime('now','-1 day') WHERE organization_id=? AND product_id=?").run(org2.id, productId2);
    const alerts2 = await fetch(server.baseUrl + '/api/platform/alerts', { headers: H }).then((r) => r.json());
    const readOnlyAlert = alerts2.alerts.find((a) => a.key === `license-readonly:${org2.id}:${productId2}`);
    assert(!!readOnlyAlert && readOnlyAlert.severity === 'critical', 'Alerts Center computes a critical-severity alert for a license already in its grace period');
    assert(alerts2.alerts[0].severity === 'critical', 'Alerts are sorted critical-first');
    const pendingAlert = alerts2.alerts.find((a) => a.key === `registration-pending:${org2.id}`);
    assert(!!pendingAlert && pendingAlert.severity === 'info', 'Alerts Center also surfaces the still-pending second organization as an info alert');

    const markRead = await fetch(server.baseUrl + `/api/platform/alerts/${encodeURIComponent(expiryAlert.key)}/read`, { method: 'POST', headers: H }).then((r) => r.json());
    assert(markRead.ok === true, 'Marking an alert read succeeds');
    const alerts3 = await fetch(server.baseUrl + '/api/platform/alerts', { headers: H }).then((r) => r.json());
    assert(alerts3.alerts.find((a) => a.key === expiryAlert.key).readAt !== null, 'The read alert now reports a readAt timestamp on recomputation');

    const dismiss = await fetch(server.baseUrl + `/api/platform/alerts/${encodeURIComponent(readOnlyAlert.key)}/dismiss`, { method: 'POST', headers: H }).then((r) => r.json());
    assert(dismiss.ok === true, 'Dismissing an alert succeeds');
    const alerts4 = await fetch(server.baseUrl + '/api/platform/alerts', { headers: H }).then((r) => r.json());
    assert(!alerts4.alerts.some((a) => a.key === readOnlyAlert.key), 'A dismissed alert is excluded from the default (non-includeDismissed) list');
    const alerts4WithDismissed = await fetch(server.baseUrl + '/api/platform/alerts?includeDismissed=true', { headers: H }).then((r) => r.json());
    assert(alerts4WithDismissed.alerts.some((a) => a.key === readOnlyAlert.key && a.dismissedAt), 'includeDismissed=true still surfaces the dismissed alert with its dismissedAt set');

    // ── Reports & Trends ──────────────────────────────────────────────────
    const trends = await fetch(server.baseUrl + '/api/platform/reports/trends', { headers: H }).then((r) => r.json());
    assert(Array.isArray(trends.customerGrowth) && trends.customerGrowth.length >= 1, 'Reports: customerGrowth returns a real, non-empty monthly series');
    assert(Array.isArray(trends.registrationTrends) && trends.registrationTrends.reduce((s, m) => s + m.count, 0) >= 2, 'Reports: registrationTrends counts real organizations created in this test (>=2)');
    assert(typeof trends.licenseTrends === 'object', 'Reports: licenseTrends returns a status->count breakdown');
    assert(Array.isArray(trends.productUsage) && trends.productUsage.some((p) => p.product === 'shoperp' || p.product === 'ShopERP'), 'Reports: productUsage includes shoperp with real organization counts');
    assert(Array.isArray(trends.activityMetrics), 'Reports: activityMetrics returns a real per-day array (may be empty on a fresh instance, never fabricated)');

  } finally {
    server.stop();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
