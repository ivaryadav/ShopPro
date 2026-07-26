/**
 * platform/test/security-suite.test.js — Phase 5B: Platform Security.
 *
 * Covers MFA enrollment/verification/recovery codes/trusted devices,
 * forced-MFA-by-role, session management, password policy + history,
 * API keys, and security audit logging. Runs against a disposable
 * in-process instance via testServer.js, which already completes MFA
 * enrollment for the OWNER (a forced-MFA role) as part of its own setup —
 * see testServer.js's comment on why.
 *
 * Usage: node test/security-suite.test.js
 */
'use strict';

const otplib = require('otplib');
const { startTestServer } = require('./testServer');
const { getDb } = require('../src/database/connection');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Z-SUPERADMIN Phase 5B — Platform Security: integration tests\n');
  const server = await startTestServer();
  const H = { Authorization: 'Bearer ' + server.ownerToken, 'Content-Type': 'application/json' };
  const api = (path, opts) => fetch(server.baseUrl + '/api/platform' + path, {
    method: (opts && opts.method) || 'GET',
    headers: (opts && opts.headers) || H,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // ── MFA login flow (owner is already enrolled by testServer.js) ─────
    const login1 = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: server.ownerEmail, password: server.ownerPassword } });
    assert(login1.body.mfaRequired === true && !!login1.body.mfaToken, 'a correct password for an MFA-enrolled user yields an MFA challenge, not a session');

    const badChallenge = await api('/auth/mfa/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { mfaToken: login1.body.mfaToken, code: '000000' } });
    assert(badChallenge.status === 401, 'a wrong TOTP code is rejected (got ' + badChallenge.status + ')');

    const login2 = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: server.ownerEmail, password: server.ownerPassword } });
    const goodCode = await otplib.generate({ secret: server.ownerMfaSecret });
    const challenge = await api('/auth/mfa/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { mfaToken: login2.body.mfaToken, code: goodCode, rememberDevice: true } });
    assert(!!challenge.body.token && !!challenge.body.trustedDeviceToken, 'a correct TOTP code completes login and, with rememberDevice, issues a trusted-device token');

    // ── Trusted device bypasses MFA on a later login ────────────────────
    const trustedLogin = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: server.ownerEmail, password: server.ownerPassword, trustedDeviceToken: challenge.body.trustedDeviceToken } });
    assert(!!trustedLogin.body.token && !trustedLogin.body.mfaRequired, 'logging in again with a valid trusted-device token skips MFA entirely');

    const wrongDeviceLogin = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: server.ownerEmail, password: server.ownerPassword, trustedDeviceToken: 'not-a-real-token' } });
    assert(wrongDeviceLogin.body.mfaRequired === true, 'an invalid trusted-device token falls through to a normal MFA challenge, not a silent bypass');

    // ── Forced MFA by role ────────────────────────────────────────────────
    const superAdmin = await api('/platform-users', { method: 'POST', body: { email: 'sa@zmaxlab.com', password: 'SuperAdminPass123!', roleCode: 'SUPER_ADMIN' } });
    const saLogin = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: 'sa@zmaxlab.com', password: 'SuperAdminPass123!' } });
    assert(!!saLogin.body.token && saLogin.body.user.mfaSetupRequired === true, 'a SUPER_ADMIN (forced-MFA role) who has not enrolled yet still gets a session, flagged mfaSetupRequired');
    const saH = { Authorization: 'Bearer ' + saLogin.body.token, 'Content-Type': 'application/json' };
    const saBlocked = await fetch(server.baseUrl + '/api/platform/dashboard/stats', { headers: saH });
    assert(saBlocked.status === 403, 'that SUPER_ADMIN is blocked (403) from a normal route until MFA setup completes (got ' + saBlocked.status + ')');
    const saMe = await fetch(server.baseUrl + '/api/platform/auth/me', { headers: saH });
    assert(saMe.status === 200, 'GET /auth/me stays reachable while MFA setup is pending, so the UI can still show who is logged in');
    const support = await api('/platform-users', { method: 'POST', body: { email: 'sup@zmaxlab.com', password: 'SupportPass123!', roleCode: 'SUPPORT' } });
    const supportLogin = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: 'sup@zmaxlab.com', password: 'SupportPass123!' } });
    assert(!!supportLogin.body.token && !supportLogin.body.mfaRequired && !supportLogin.body.user.mfaSetupRequired, 'SUPPORT (not a forced-MFA role) logs in normally with no MFA involved at all');

    // ── Recovery codes: single-use ────────────────────────────────────────
    const login3 = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: server.ownerEmail, password: server.ownerPassword } });
    const recoveryRow = getDb().prepare('SELECT id FROM platform_mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL LIMIT 1').get(server.ownerId);
    assert(!!recoveryRow, 'setup: the owner has at least one unused recovery code from enrollment');
    // We don't have the plaintext of an existing code (only its hash was ever known), so regenerate a known-plaintext set first.
    const regen = await api('/auth/mfa/recovery-codes/regenerate', { method: 'POST', body: { password: server.ownerPassword } });
    assert(Array.isArray(regen.body.recoveryCodes) && regen.body.recoveryCodes.length === 10, 'regenerating recovery codes returns exactly 10 new plaintext codes, shown once');
    const login4 = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: server.ownerEmail, password: server.ownerPassword } });
    const recoveryCode = regen.body.recoveryCodes[0];
    const recoveryChallenge = await api('/auth/mfa/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { mfaToken: login4.body.mfaToken, recoveryCode } });
    assert(!!recoveryChallenge.body.token, 'a valid recovery code completes login in place of a TOTP code');
    const login5 = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { email: server.ownerEmail, password: server.ownerPassword } });
    const reuseAttempt = await api('/auth/mfa/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { mfaToken: login5.body.mfaToken, recoveryCode } });
    assert(reuseAttempt.status === 401, 'the SAME recovery code cannot be used a second time (got ' + reuseAttempt.status + ')');

    // ── Disable MFA requires the current password, and revokes trusted devices ──
    const disableWrongPw = await api('/auth/mfa/disable', { method: 'POST', body: { password: 'totally-wrong' } });
    assert(disableWrongPw.status === 401, 'disabling MFA with the wrong password is rejected (got ' + disableWrongPw.status + ')');
    const devicesBefore = await api('/security/my/trusted-devices');
    assert(devicesBefore.body.devices.some((d) => !d.revoked_at), 'setup: the owner has at least one still-active trusted device before disabling MFA');
    const disableOk = await api('/auth/mfa/disable', { method: 'POST', body: { password: server.ownerPassword } });
    assert(disableOk.status === 200, 'disabling MFA with the correct password succeeds');
    // OWNER is a forced-MFA role, so disabling immediately re-enters the
    // mfaSetupRequired gate (correct — it must not leave a forced role
    // unprotected) which now blocks /security/my/trusted-devices too;
    // verify the revocation directly against the database instead.
    const devicesAfterRows = getDb().prepare('SELECT * FROM platform_trusted_devices WHERE user_id = ?').all(server.ownerId);
    assert(devicesAfterRows.length > 0 && devicesAfterRows.every((d) => !!d.revoked_at), 'disabling MFA also revokes every trusted device tied to that account');
    const ownerReGated = await api('/security/my/trusted-devices');
    assert(ownerReGated.status === 403, 'the owner is correctly re-gated into mfaSetupRequired immediately after disabling a forced role\'s MFA (got ' + ownerReGated.status + ')');
    // Re-enroll so the remaining owner-driven test steps (sessions, policy, API keys) aren't blocked by the gate.
    const reSetup = await api('/auth/mfa/setup', { method: 'POST' });
    const reCode = await otplib.generate({ secret: reSetup.body.secret });
    await api('/auth/mfa/verify', { method: 'POST', body: { code: reCode } });

    // Re-enable for the remaining tests that assume MFA is on (audit logging, etc.) — not strictly required, skip re-enrolling to keep the suite focused.

    // ── Session management ────────────────────────────────────────────────
    const support2H = { Authorization: 'Bearer ' + supportLogin.body.token, 'Content-Type': 'application/json' };
    const sessionsList = await fetch(server.baseUrl + '/api/platform/security/sessions', { headers: H }).then((r) => r.json());
    assert(sessionsList.sessions.some((s) => s.user_email === 'sup@zmaxlab.com'), 'GET /security/sessions (admin-wide) includes the SUPPORT user\'s active session');
    const supportSession = sessionsList.sessions.find((s) => s.user_email === 'sup@zmaxlab.com');
    const revokeResult = await api(`/security/sessions/${supportSession.session_id}/revoke`, { method: 'POST' });
    assert(revokeResult.status === 200, 'an admin can revoke a specific session by ID');
    const afterRevoke = await fetch(server.baseUrl + '/api/platform/dashboard/stats', { headers: support2H });
    assert(afterRevoke.status === 401, 'the revoked session\'s token is now rejected on the very next request (got ' + afterRevoke.status + ')');

    // ── Password policy + history ─────────────────────────────────────────
    const policyBefore = await api('/security/password-policy');
    assert(policyBefore.body.policy.min_length === 8, 'default password policy has min_length 8');
    const tighten = await api('/security/password-policy', { method: 'PUT', body: { minLength: 12, requireSymbol: 1 } });
    assert(tighten.body.policy.min_length === 12 && tighten.body.policy.require_symbol === 1, 'the password policy can be tightened by an admin');
    const weakUser = await api('/platform-users', { method: 'POST', body: { email: 'weak@zmaxlab.com', password: 'password1', roleCode: 'AUDITOR' } });
    assert(weakUser.status === 400, 'creating a platform user with a password that violates the NEW (tightened) policy is rejected (got ' + weakUser.status + ')');
    const strongUser = await api('/platform-users', { method: 'POST', body: { email: 'strong@zmaxlab.com', password: 'Str0ng!Passw0rd#', roleCode: 'AUDITOR' } });
    assert(strongUser.status === 201, 'creating a platform user with a policy-compliant password succeeds (got ' + strongUser.status + ')');
    const strongId = strongUser.body.user.id;
    getDb().prepare("UPDATE platform_users SET locked_until = NULL WHERE id = ?").run(strongId); // ensure clean state for the reset below
    const resetSamePw = await api(`/platform-users/${strongId}/reset-password`, { method: 'POST', body: { newPassword: 'Str0ng!Passw0rd#' } });
    assert(resetSamePw.status === 400, 'resetting a password to the SAME value it already has is rejected by password history (got ' + resetSamePw.status + ')');
    const resetNewPw = await api(`/platform-users/${strongId}/reset-password`, { method: 'POST', body: { newPassword: 'Anoth3r!Passw0rd#' } });
    assert(resetNewPw.status === 200, 'resetting to a genuinely new, policy-compliant password succeeds');

    // Self-service change-password
    const changeWrongCurrent = await api('/auth/change-password', { method: 'POST', body: { currentPassword: 'nope', newPassword: 'Whatever!123456' } });
    assert(changeWrongCurrent.status === 401, 'self-service change-password rejects the wrong current password (got ' + changeWrongCurrent.status + ')');

    // ── API Keys ──────────────────────────────────────────────────────────
    const keyCreate = await api('/api-keys', { method: 'POST', body: { name: 'Monitoring script', permissions: ['view_only'] } });
    assert(!!keyCreate.body.rawKey && keyCreate.body.rawKey.startsWith('zsa_live_'), 'creating an API key returns the full plaintext value exactly once');
    const rawKey = keyCreate.body.rawKey;
    const keyAuthHealth = await fetch(server.baseUrl + '/api/platform/health', { headers: { 'X-Platform-Api-Key': rawKey } });
    assert(keyAuthHealth.status === 200, 'the API key authenticates against a view_only-gated route (got ' + keyAuthHealth.status + ')');
    // /platform-users is deliberately NOT wired to accept API-key auth this
    // phase (only /dashboard/stats and /health are, to prove the mechanism
    // end to end without retrofitting every route) — an API key gets 401
    // there, the same "no recognized credential" outcome a JWT-only route
    // gives anyone without a Bearer token.
    const keyAuthNotWired = await fetch(server.baseUrl + '/api/platform/platform-users', { headers: { 'X-Platform-Api-Key': rawKey } });
    assert(keyAuthNotWired.status === 401, 'an API key is rejected (401) on a route not wired to accept API-key auth at all (got ' + keyAuthNotWired.status + ')');
    const noPermKey = await api('/api-keys', { method: 'POST', body: { name: 'No permissions key', permissions: [] } });
    const noPermAuth = await fetch(server.baseUrl + '/api/platform/health', { headers: { 'X-Platform-Api-Key': noPermKey.body.rawKey } });
    assert(noPermAuth.status === 403, 'an API key granted NO permissions is rejected (403), proving permission-scoping is enforced per key, not just presence of a valid key (got ' + noPermAuth.status + ')');
    const keyId = keyCreate.body.key.id;
    const rotate = await api(`/api-keys/${keyId}/rotate`, { method: 'POST' });
    const oldKeyAfterRotate = await fetch(server.baseUrl + '/api/platform/health', { headers: { 'X-Platform-Api-Key': rawKey } });
    assert(oldKeyAfterRotate.status === 401, 'after rotation, the OLD key value is rejected (got ' + oldKeyAfterRotate.status + ')');
    const newKeyAfterRotate = await fetch(server.baseUrl + '/api/platform/health', { headers: { 'X-Platform-Api-Key': rotate.body.rawKey } });
    assert(newKeyAfterRotate.status === 200, 'the NEW rotated key value works immediately');
    const revoke = await api(`/api-keys/${keyId}/revoke`, { method: 'POST' });
    assert(revoke.status === 200, 'revoking the API key succeeds');
    const afterRevokeKey = await fetch(server.baseUrl + '/api/platform/health', { headers: { 'X-Platform-Api-Key': rotate.body.rawKey } });
    assert(afterRevokeKey.status === 401, 'the revoked key no longer authenticates (got ' + afterRevokeKey.status + ')');
    // Expiry, fast-forwarded the same way this whole engagement backdates timers elsewhere.
    const expKey = await api('/api-keys', { method: 'POST', body: { name: 'Expiring key', permissions: ['view_only'], expiresInDays: 1 } });
    getDb().prepare("UPDATE platform_api_keys SET expires_at = datetime('now','-1 hour') WHERE id = ?").run(expKey.body.key.id);
    const expiredKeyAuth = await fetch(server.baseUrl + '/api/platform/health', { headers: { 'X-Platform-Api-Key': expKey.body.rawKey } });
    assert(expiredKeyAuth.status === 401, 'an expired API key is rejected, evaluated entirely in SQL (got ' + expiredKeyAuth.status + ')');

    // ── Security Center overview + Security Logs ─────────────────────────
    const overview = await api('/security/overview');
    assert(typeof overview.body.securityScore === 'number' && overview.body.securityScore >= 0 && overview.body.securityScore <= 100, 'Security Center overview reports a securityScore in [0,100]');
    assert(typeof overview.body.mfaStatus.totalUsers === 'number' && overview.body.mfaStatus.totalUsers >= 4, 'Security Center overview counts real platform users created in this test');
    assert(overview.body.lockedAccounts === 0 || typeof overview.body.lockedAccounts === 'number', 'Security Center overview reports a lockedAccounts count');

    const logs = await api('/security/logs?pageSize=200');
    const actions = logs.body.entries.map((e) => e.action);
    assert(actions.includes('MFA_DISABLED'), 'Security Logs include MFA_DISABLED');
    assert(actions.includes('RECOVERY_CODES_REGENERATED'), 'Security Logs include RECOVERY_CODES_REGENERATED');
    assert(actions.includes('RECOVERY_CODE_USED'), 'Security Logs include RECOVERY_CODE_USED');
    assert(actions.includes('SESSION_REVOKED'), 'Security Logs include SESSION_REVOKED');
    assert(actions.includes('API_KEY_CREATED') && actions.includes('API_KEY_ROTATED') && actions.includes('API_KEY_REVOKED'), 'Security Logs include the full API key lifecycle');
    assert(actions.includes('PASSWORD_POLICY_UPDATED'), 'Security Logs include PASSWORD_POLICY_UPDATED');
    assert(actions.includes('MFA_CHALLENGE_FAILED'), 'Security Logs include the earlier failed TOTP attempt');

  } finally {
    server.stop();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
