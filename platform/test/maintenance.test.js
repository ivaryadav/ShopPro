/**
 * platform/test/maintenance.test.js — Phase 5D: Platform Maintenance &
 * Business Continuity (Z-SUPERADMIN side). Covers policy CRUD, resolution
 * precedence (emergency > specificity), the product-facing bulk pull
 * endpoint, the 3 jobs (Publish/Expiry/Synchronization monitor), allowlists,
 * and validation. ShopERP-side sync/cache/enforcement is covered by
 * server/test/maintenance.test.js — this file only tests what Z-SUPERADMIN
 * itself owns.
 *
 * Usage: node test/maintenance.test.js
 */
'use strict';

const { startTestServer } = require('./testServer');
const jobRunnerService = require('../src/services/jobRunnerService');
const { getDb } = require('../src/database/connection');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Z-SUPERADMIN Phase 5D — Platform Maintenance: integration tests\n');
  const server = await startTestServer();
  const H = { Authorization: 'Bearer ' + server.ownerToken, 'Content-Type': 'application/json' };
  const api = (path, opts) => fetch(server.baseUrl + '/api/platform' + path, {
    method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || H,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // ── Validation ────────────────────────────────────────────────────────
    const noScopeRef = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'product', mode: 'immediate' } });
    assert(noScopeRef.status === 400, 'creating a product-scoped policy without scopeRef is rejected (got ' + noScopeRef.status + ')');
    const badProduct = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'product', scopeRef: 'not-a-real-product', mode: 'immediate' } });
    assert(badProduct.status === 400, 'creating a policy for an unknown product slug is rejected (got ' + badProduct.status + ')');
    const noStart = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'platform', mode: 'scheduled' } });
    assert(noStart.status === 400, 'a scheduled-mode policy without startsAt is rejected (got ' + noStart.status + ')');

    // ── Immediate mode is active the instant it's created ────────────────
    const platformImmediate = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'platform', mode: 'immediate', accessLevel: 'locked', message: 'Platform-wide maintenance' } });
    assert(platformImmediate.status === 201 && platformImmediate.body.policy.status === 'active', 'an immediate-mode platform policy is active immediately, no publish step needed');
    const platformId = platformImmediate.body.policy.id;

    // ── Resolution: platform-wide active window applies with no product/org override ──
    const resolve1 = await api('/maintenance/resolve?productSlug=shoperp&organizationScopeRef=shoperp:999');
    assert(resolve1.body.effective && resolve1.body.effective.scopeType === 'platform', 'resolveEffective falls back to the platform-wide window when no more specific one exists');

    // ── Specificity: a product-scoped window overrides platform-wide for that product ──
    const productWindow = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'product', scopeRef: 'shoperp', mode: 'immediate', accessLevel: 'read_only', message: 'ShopERP read-only window' } });
    const resolve2 = await api('/maintenance/resolve?productSlug=shoperp&organizationScopeRef=shoperp:999');
    assert(resolve2.body.effective.scopeType === 'product' && resolve2.body.effective.accessLevel === 'read_only', 'a product-scoped window is more specific than platform-wide and wins resolution');

    // ── Specificity: an organization-scoped window overrides product for that org ──
    const orgWindow = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'organization', scopeRef: 'shoperp:999', mode: 'immediate', accessLevel: 'locked', message: 'Org-specific lock' } });
    const resolve3 = await api('/maintenance/resolve?productSlug=shoperp&organizationScopeRef=shoperp:999');
    assert(resolve3.body.effective.scopeType === 'organization' && resolve3.body.effective.scopeRef === 'shoperp:999', 'an organization-scoped window is the most specific and wins over product and platform');
    const resolve4 = await api('/maintenance/resolve?productSlug=shoperp&organizationScopeRef=shoperp:1000');
    assert(resolve4.body.effective.scopeType === 'product', 'a DIFFERENT organization (no org-specific window) correctly falls back to the product-scoped window');

    // ── Emergency mode wins over specificity ──────────────────────────────
    const emergencyPlatform = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'platform', mode: 'emergency', accessLevel: 'locked', message: 'EMERGENCY platform lockdown' } });
    assert(emergencyPlatform.status === 201 && emergencyPlatform.body.policy.status === 'active', 'emergency mode is active immediately, like immediate mode');
    const resolve5 = await api('/maintenance/resolve?productSlug=shoperp&organizationScopeRef=shoperp:999');
    assert(resolve5.body.effective.mode === 'emergency' && resolve5.body.effective.scopeType === 'platform', 'a platform-wide EMERGENCY window overrides an organization-scoped NON-emergency window — emergency beats specificity');

    // ── Allowlists ────────────────────────────────────────────────────────
    const allowlistOrgWindow = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'platform', mode: 'immediate', accessLevel: 'locked', message: 'Locked, but one org is exempt', allowlistOrganizations: ['shoperp:42'] } });
    assert(allowlistOrgWindow.status === 201, 'setup: a platform lock with an organization allowlist is created');
    // (Full allowlist BYPASS behavior — i.e. does a request from an allow-
    // listed tenant actually get through — is exercised end-to-end on the
    // ShopERP side, which is where the allowlist is actually consumed by a
    // real request; here we only verify the data round-trips correctly.)
    assert(allowlistOrgWindow.body.policy.allowlistOrganizations.includes('shoperp:42'), 'the allowlisted organization ref round-trips correctly through create');

    // Clean up the emergency/immediate windows created above so they don't interfere with later assertions.
    await api(`/maintenance/policies/${emergencyPlatform.body.policy.id}/deactivate`, { method: 'POST' });
    await api(`/maintenance/policies/${orgWindow.body.policy.id}/deactivate`, { method: 'POST' });
    await api(`/maintenance/policies/${productWindow.body.policy.id}/deactivate`, { method: 'POST' });
    await api(`/maintenance/policies/${platformImmediate.body.policy.id}/deactivate`, { method: 'POST' });
    await api(`/maintenance/policies/${allowlistOrgWindow.body.policy.id}/deactivate`, { method: 'POST' });
    const resolveClean = await api('/maintenance/resolve?productSlug=shoperp&organizationScopeRef=shoperp:999');
    assert(resolveClean.body.effective === null, 'after deactivating every window, resolution correctly reports nothing active');

    // ── Editing, activating, cancelling ──────────────────────────────────
    const editable = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'platform', mode: 'scheduled', accessLevel: 'read_only', startsAt: '2099-01-01T00:00', message: 'far future' } });
    const edited = await api(`/maintenance/policies/${editable.body.policy.id}`, { method: 'PUT', body: { message: 'edited message' } });
    assert(edited.status === 200 && edited.body.policy.message === 'edited message', 'editing a scheduled (not-yet-active) policy succeeds');
    const cannotCancelActive = await api(`/maintenance/policies/${editable.body.policy.id}/activate`, { method: 'POST' });
    const cancelAttempt = await api(`/maintenance/policies/${editable.body.policy.id}/cancel`, { method: 'POST' });
    assert(cancelAttempt.status === 400, 'cancelling an ACTIVE window is rejected — deactivate is the correct action instead (got ' + cancelAttempt.status + ')');
    const stillScheduled = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'platform', mode: 'scheduled', accessLevel: 'locked', startsAt: '2099-01-01T00:00' } });
    const cancelOk = await api(`/maintenance/policies/${stillScheduled.body.policy.id}/cancel`, { method: 'POST' });
    assert(cancelOk.status === 200 && cancelOk.body.policy.status === 'cancelled', 'cancelling a still-scheduled window succeeds');
    await api(`/maintenance/policies/${editable.body.policy.id}/deactivate`, { method: 'POST' });

    // ── Scheduler: Maintenance Publish Job activates a due scheduled window ──
    const dueWindow = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'platform', mode: 'scheduled', accessLevel: 'locked', startsAt: '2099-01-01T00:00', message: 'due window' } });
    getDb().prepare("UPDATE platform_maintenance_windows SET starts_at = datetime('now','-1 minute') WHERE id = ?").run(dueWindow.body.policy.id);
    const publishRun = await jobRunnerService.runNow('maintenance-publish');
    assert(publishRun.lastStatus === 'success', 'Maintenance Publish Job runs successfully');
    const dueAfter = await api(`/maintenance/policies/${dueWindow.body.policy.id}`);
    assert(dueAfter.body.status === 'active', 'the Publish Job activated the window now that its start time has passed');
    const publishHistory = await api('/maintenance/history?limit=20');
    assert(publishHistory.body.entries.some((h) => h.action === 'PUBLISHED'), 'a PUBLISHED history entry was recorded');

    // ── Scheduler: Maintenance Expiry Job expires a past-due active window ──
    getDb().prepare("UPDATE platform_maintenance_windows SET ends_at = datetime('now','-1 minute') WHERE id = ?").run(dueWindow.body.policy.id);
    const expiryRun = await jobRunnerService.runNow('maintenance-expiry');
    assert(expiryRun.lastStatus === 'success', 'Maintenance Expiry Job runs successfully');
    const expiredAfter = await api(`/maintenance/policies/${dueWindow.body.policy.id}`);
    assert(expiredAfter.body.status === 'expired', 'the Expiry Job expired the window now that its end time has passed');
    const expiryHistory = await api('/maintenance/history?limit=20');
    assert(expiryHistory.body.entries.some((h) => h.action === 'EXPIRED'), 'an EXPIRED history entry was recorded');

    // ── Product-facing bulk pull endpoint (API-key authenticated) ─────────
    const activeForPull = await api('/maintenance/policies', { method: 'POST', body: { scopeType: 'product', scopeRef: 'shoperp', mode: 'immediate', accessLevel: 'read_only', message: 'pull test' } });
    const keyResult = await api('/api-keys', { method: 'POST', body: { name: 'maintenance sync test key', permissions: ['view_only'] } });
    const pullNoAuth = await fetch(server.baseUrl + '/api/platform/maintenance/effective?product=shoperp');
    assert(pullNoAuth.status === 401, 'the product-facing pull endpoint requires SOME credential (got ' + pullNoAuth.status + ')');
    const pull = await fetch(server.baseUrl + '/api/platform/maintenance/effective?product=shoperp', { headers: { 'X-Platform-Api-Key': keyResult.body.rawKey } });
    const pullBody = await pull.json();
    assert(pull.status === 200 && pullBody.product && pullBody.product.accessLevel === 'read_only', 'an API key can pull the effective bundle, which includes the active product-scoped window');
    await api(`/maintenance/policies/${activeForPull.body.policy.id}/deactivate`, { method: 'POST' });

    // ── Synchronization Job (staleness monitor) sees the pull we just made ──
    const syncMonitorRun = await jobRunnerService.runNow('maintenance-sync-monitor');
    assert(syncMonitorRun.lastStatus === 'success', 'Maintenance Synchronization Job reports success once a real product pull has been observed via the audit log');

    // ── System Health reflects real maintenance state ────────────────────
    // NOTE: this disposable test server never configures the ShopERP
    // adapter's own env vars (SHOPERP_BASE_URL/SHOPERP_ADMIN_PASSWORD) —
    // that live-adapter proof belongs to shoperp-adapter-e2e.test.js.
    // productsConnected is therefore correctly 0 here; what THIS test
    // verifies is that the pull we made was really observed at all
    // (lastSyncAt), which the health/audit-log integration reports
    // regardless of whether any adapter happens to be configured.
    const health = await api('/health');
    assert(typeof health.body.maintenance.productsConnected === 'number', 'System Health reports a productsConnected count (0 here — no adapter configured in this disposable server)');
    assert(health.body.maintenance.lastSyncAt !== null, 'System Health reports a real lastSyncAt timestamp from the pull made above');

  } finally {
    server.stop();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
