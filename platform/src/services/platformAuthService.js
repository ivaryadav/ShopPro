/**
 * platform/src/services/platformAuthService.js
 *
 * Completely separate identity from ShopERP (or any product): its own
 * table (platform_users), its own JWT secret (PLATFORM_JWT_SECRET), its
 * own session table (platform_sessions). A ShopERP tenant JWT would fail
 * verification here outright (different secret) even if somehow presented
 * — there is no code path that accepts one, by construction.
 */
'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const userRepository = require('../repositories/platformUserRepository');
const roleRepository = require('../repositories/platformRoleRepository');
const sessionRepository = require('../repositories/platformSessionRepository');
const loginFailureRepository = require('../repositories/platformLoginFailureRepository');
const auditService = require('./auditService');
const { AuthenticationError, LockedError, ValidationError } = require('../errors');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MINUTES = 15;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;
const ACCESS_TOKEN_TTL = '12h';

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

async function login({ email, password, ip, userAgent }, jwtSecret) {
  if (!email || !password) throw new ValidationError('email and password are required');
  const user = userRepository.findByEmail(email);
  if (!user || !user.is_active) {
    loginFailureRepository.record(user ? user.id : null, email, ip);
    throw new AuthenticationError('Invalid email or password.');
  }
  if (isLocked(user)) {
    throw new LockedError('This account is temporarily locked due to repeated failed login attempts. Try again later.');
  }
  const verified = bcrypt.compareSync(password, user.password_hash);
  if (!verified) {
    loginFailureRepository.record(user.id, email, ip);
    const recent = loginFailureRepository.countRecent(email, LOCKOUT_WINDOW_MINUTES);
    if (recent >= LOCKOUT_THRESHOLD) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
      userRepository.setLockedUntil(email, lockedUntil);
      auditService.record({ action: 'PLATFORM_ACCOUNT_LOCKED', detail: `${recent} failed attempts in ${LOCKOUT_WINDOW_MINUTES}m`, ip });
    }
    throw new AuthenticationError('Invalid email or password.');
  }
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
  return { token, user: { id: user.id, email: user.email, displayName: user.display_name, roleCode: user.role_code, roleLabel: user.role_label, permissions } };
}

function verifyToken(token, jwtSecret) {
  const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  const session = sessionRepository.findBySessionId(payload.sid);
  if (!session || session.status !== 'active') throw new AuthenticationError('Session expired or was signed out elsewhere.');
  sessionRepository.touch(payload.sid);
  return payload;
}

async function createUser({ email, displayName, password, roleCode }) {
  if (!email || !password || !roleCode) throw new ValidationError('email, password, and roleCode are required');
  const role = roleRepository.findByCode(roleCode);
  if (!role) throw new ValidationError('Unknown roleCode');
  const existing = userRepository.findByEmail(email);
  if (existing) throw new ValidationError('A platform user with this email already exists');
  const hash = bcrypt.hashSync(password, 10);
  return userRepository.create({ email, displayName, passwordHash: hash, roleId: role.id });
}

module.exports = { login, verifyToken, createUser, isLocked };
