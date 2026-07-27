/**
 * platform/src/services/platformAuthService.js
 *
 * Completely separate identity from ShopERP (or any product): its own
 * table (platform_users), its own JWT secret (PLATFORM_JWT_SECRET), its
 * own session table (platform_sessions). A ShopERP tenant JWT would fail
 * verification here outright (different secret) even if somehow presented
 * — there is no code path that accepts one, by construction.
 *
 * Phase 5B adds MFA to the login flow: password success now branches
 * three ways — (1) MFA enabled and no valid trusted-device token: a
 * short-lived "mfa_pending" token is issued, no session yet, the caller
 * must call challengeMfa(); (2) MFA enabled and a valid trusted-device
 * token was presented: skip straight to a full session; (3) MFA not
 * enabled: a full session is issued immediately, with an informational
 * mfaSetupRequired flag if the user's role forces enrollment. That flag
 * is never trusted from a JWT claim — verifyToken() recomputes it live
 * from the database on every request, so completing MFA setup takes
 * effect immediately without needing to reissue the token.
 */
'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const userRepository = require('../repositories/platformUserRepository');
const roleRepository = require('../repositories/platformRoleRepository');
const sessionRepository = require('../repositories/platformSessionRepository');
const loginFailureRepository = require('../repositories/platformLoginFailureRepository');
const trustedDeviceRepository = require('../repositories/platformTrustedDeviceRepository');
const policyRepository = require('../repositories/platformPasswordPolicyRepository');
const passwordHistoryRepository = require('../repositories/platformPasswordHistoryRepository');
const mfaService = require('./mfaService');
const passwordService = require('./passwordService');
const eventBusService = require('./eventBusService');
const auditService = require('./auditService');
const { AuthenticationError, LockedError, ValidationError } = require('../errors');

const ACCESS_TOKEN_TTL = '12h';
const MFA_PENDING_TOKEN_TTL = '5m';
const TRUSTED_DEVICE_DAYS = 30;
// A fixed, valid-shaped bcrypt hash with no corresponding real password —
// compared against on every "account doesn't exist" path so that branch
// takes the same ~bcrypt-cost time as a real wrong-password check. Without
// this, an unknown email returns in <1ms while a wrong password for a
// real account takes ~15-20ms (bcrypt's cost factor), letting an attacker
// enumerate valid platform-user emails purely by measuring response time —
// confirmed empirically during the Phase 5B.1 security audit (a ~23x gap).
const DUMMY_HASH_FOR_TIMING_EQUALIZATION = bcrypt.hashSync('not-a-real-password', 10);

function isLocked(user) {
  return !!(user.locked_until && new Date(user.locked_until).getTime() > Date.now());
}
function parseUA(uaString) {
  const ua = uaString || '';
  let browser = 'Unknown', os = 'Unknown';
  if (/Chrome/i.test(ua)) browser = 'Chrome'; else if (/Firefox/i.test(ua)) browser = 'Firefox'; else if (/Safari/i.test(ua)) browser = 'Safari'; else if (/Edg/i.test(ua)) browser = 'Edge';
  if (/Windows/i.test(ua)) os = 'Windows'; else if (/Mac/i.test(ua)) os = 'macOS'; else if (/Linux/i.test(ua)) os = 'Linux'; else if (/Android/i.test(ua)) os = 'Android'; else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  return { browser, os };
}
function hashDeviceToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

function completeLogin(user, ip, userAgent, jwtSecret) {
  userRepository.touchLastLogin(user.id);
  const sessionId = crypto.randomBytes(24).toString('hex');
  const jwtId = crypto.randomBytes(12).toString('hex');
  const { browser, os } = parseUA(userAgent);
  sessionRepository.create({ sessionId, userId: user.id, jwtId, ip, browser, os });
  const permissions = roleRepository.permissionsForRole(user.role_id);
  const token = jwt.sign(
    { userId: user.id, email: user.email, roleCode: user.role_code, permissions, sid: sessionId, jti: jwtId },
    jwtSecret, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL }
  );
  auditService.record({ platformUserId: user.id, action: 'PLATFORM_LOGIN', detail: `${user.email} logged in`, ip });
  const mfaSetupRequired = !user.totp_enabled && !!user.role_mfa_required;
  return {
    token,
    user: {
      id: user.id, email: user.email, displayName: user.display_name, roleCode: user.role_code, roleLabel: user.role_label,
      permissions, mfaEnabled: !!user.totp_enabled, mfaSetupRequired,
    },
  };
}

async function login({ email, password, ip, userAgent, trustedDeviceToken }, jwtSecret) {
  if (!email || !password) throw new ValidationError('email and password are required');
  const user = userRepository.findByEmail(email);
  if (!user || !user.is_active) {
    bcrypt.compareSync(password, DUMMY_HASH_FOR_TIMING_EQUALIZATION); // burn the same time a real bcrypt check would take — see constant's comment
    loginFailureRepository.record(user ? user.id : null, email, ip);
    throw new AuthenticationError('Invalid email or password.');
  }
  if (isLocked(user)) {
    throw new LockedError('This account is temporarily locked due to repeated failed login attempts. Try again later.');
  }
  const verified = bcrypt.compareSync(password, user.password_hash);
  if (!verified) {
    const policy = policyRepository.get();
    loginFailureRepository.record(user.id, email, ip);
    const recent = loginFailureRepository.countRecent(email, policy.lockout_window_minutes);
    if (recent >= policy.lockout_threshold) {
      const lockedUntil = new Date(Date.now() + policy.lockout_duration_minutes * 60000).toISOString();
      userRepository.setLockedUntil(email, lockedUntil);
      auditService.record({ action: 'PLATFORM_ACCOUNT_LOCKED', detail: `${recent} failed attempts in ${policy.lockout_window_minutes}m`, ip });
      eventBusService.publish({ eventType: 'user.locked', organizationId: null, payload: { email, lockedUntil, reason: 'failed_login_attempts' } });
    }
    throw new AuthenticationError('Invalid email or password.');
  }

  if (user.totp_enabled) {
    if (trustedDeviceToken) {
      const device = trustedDeviceRepository.findValidByTokenHash(hashDeviceToken(trustedDeviceToken), user.id);
      if (device) {
        trustedDeviceRepository.touch(device.id);
        auditService.record({ platformUserId: user.id, action: 'TRUSTED_DEVICE_LOGIN', detail: `${user.email} via trusted device "${device.device_name}"`, ip });
        return completeLogin(user, ip, userAgent, jwtSecret);
      }
    }
    const mfaToken = jwt.sign({ type: 'mfa_pending', userId: user.id }, jwtSecret, { algorithm: 'HS256', expiresIn: MFA_PENDING_TOKEN_TTL });
    return { mfaRequired: true, mfaToken };
  }

  return completeLogin(user, ip, userAgent, jwtSecret);
}

/** Step 2 of an MFA-gated login — a TOTP code OR a single-use recovery code. Optionally issues a trusted-device token. */
async function challengeMfa({ mfaToken, code, recoveryCode, rememberDevice, ip, userAgent }, jwtSecret) {
  let payload;
  try { payload = jwt.verify(mfaToken, jwtSecret, { algorithms: ['HS256'] }); }
  catch (e) { throw new AuthenticationError('This MFA challenge has expired — please log in again.'); }
  if (payload.type !== 'mfa_pending') throw new AuthenticationError('Invalid MFA challenge.');
  const user = userRepository.findById(payload.userId);
  if (!user || !user.totp_enabled) throw new AuthenticationError('Invalid MFA challenge.');
  // A 5-minute mfaToken can outlive an account becoming locked mid-flow
  // (e.g. from repeated failed challenges below) — re-check on every use.
  if (isLocked(user)) throw new LockedError('This account is temporarily locked due to repeated failed attempts. Try again later.');

  let usedRecoveryCode = false;
  let ok = false;
  if (recoveryCode) { ok = mfaService.consumeRecoveryCode(user.id, recoveryCode); usedRecoveryCode = ok; }
  else if (code) { ok = await mfaService.verifyTotp(user.totp_secret, code); }

  if (!ok) {
    // Reuses the exact same account-lockout primitive a failed PASSWORD
    // attempt does — a stolen password alone (which is what a valid
    // mfaToken implies) must not let an attacker brute-force the second
    // factor indefinitely across repeated challenge calls within the
    // token's 5-minute window.
    const policy = policyRepository.get();
    loginFailureRepository.record(user.id, user.email, ip);
    const recentFailures = loginFailureRepository.countRecent(user.email, policy.lockout_window_minutes);
    if (recentFailures >= policy.lockout_threshold) {
      const lockedUntil = new Date(Date.now() + policy.lockout_duration_minutes * 60000).toISOString();
      userRepository.setLockedUntil(user.email, lockedUntil);
      auditService.record({ platformUserId: user.id, action: 'PLATFORM_ACCOUNT_LOCKED', detail: `${recentFailures} failed MFA/login attempts in ${policy.lockout_window_minutes}m`, ip });
      eventBusService.publish({ eventType: 'user.locked', organizationId: null, payload: { email: user.email, lockedUntil, reason: 'failed_mfa_attempts' } });
    }
    auditService.record({ platformUserId: user.id, action: 'MFA_CHALLENGE_FAILED', detail: user.email, ip });
    throw new AuthenticationError('Invalid authentication code.');
  }
  if (usedRecoveryCode) auditService.record({ platformUserId: user.id, action: 'RECOVERY_CODE_USED', detail: user.email, ip });

  const result = completeLogin(user, ip, userAgent, jwtSecret);
  if (rememberDevice) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const { browser, os } = parseUA(userAgent);
    trustedDeviceRepository.create({
      userId: user.id, tokenHash: hashDeviceToken(rawToken), deviceName: `${browser} on ${os}`, browser, os, ip,
      expiresAt: new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 3600000).toISOString(),
    });
    result.trustedDeviceToken = rawToken;
  }
  return result;
}

function verifyToken(token, jwtSecret) {
  const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  const session = sessionRepository.findBySessionId(payload.sid);
  if (!session || session.status !== 'active') throw new AuthenticationError('Session expired or was signed out elsewhere.');

  const policy = policyRepository.get();
  const expiry = sessionRepository.checkExpiry(payload.sid, policy.session_idle_timeout_minutes, policy.session_absolute_timeout_hours);
  if (expiry && (expiry.idle_expired || expiry.absolute_expired)) {
    sessionRepository.revoke(payload.sid);
    throw new AuthenticationError(expiry.absolute_expired ? 'Session has reached its maximum lifetime. Please log in again.' : 'Session expired due to inactivity. Please log in again.');
  }
  sessionRepository.touch(payload.sid);

  // mfaSetupRequired is ALWAYS recomputed live here, never trusted from any
  // JWT claim — this is what makes completing MFA setup take effect
  // immediately, without needing to reissue or refresh the access token.
  const user = userRepository.findById(payload.userId);
  const mfaSetupRequired = !!(user && !user.totp_enabled && user.role_mfa_required);
  return { ...payload, mfaSetupRequired };
}

async function createUser({ email, displayName, password, roleCode }) {
  if (!email || !password || !roleCode) throw new ValidationError('email, password, and roleCode are required');
  const role = roleRepository.findByCode(roleCode);
  if (!role) throw new ValidationError('Unknown roleCode');
  const existing = userRepository.findByEmail(email);
  if (existing) throw new ValidationError('A platform user with this email already exists');
  passwordService.validateAgainstPolicy(password, policyRepository.get());
  const hash = bcrypt.hashSync(password, 10);
  const user = userRepository.create({ email, displayName, passwordHash: hash, roleId: role.id });
  passwordHistoryRepository.record(user.id, hash);
  return user;
}

module.exports = { login, challengeMfa, verifyToken, createUser, isLocked };
