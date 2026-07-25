/**
 * server/src/services/sessionService.js
 *
 * Business rules for session lifecycle — mirrors server/sessions.js
 * exactly (same TTLs, same refresh-token rotation + grace-window logic,
 * same cleanup thresholds). That file is this service's behavioral source
 * of truth; every constant below matches it verbatim.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sessionRepository = require('../repositories/sessionRepository');
const tenantRepository = require('../repositories/tenantRepository');
const userRepository = require('../repositories/userRepository');
const { NotFoundError } = require('../errors');

const ACCESS_TOKEN_TTL = '15m';
const SESSION_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLEANUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
// See server/sessions.js:18-26 for the full rationale — unchanged here.
const REFRESH_GRACE_MS = 20 * 1000;

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function newSessionId() { return crypto.randomBytes(24).toString('hex'); }
function newRefreshToken() { return crypto.randomBytes(32).toString('hex'); }
function newJwtId() { return crypto.randomBytes(12).toString('hex'); }

/** Dependency-free UA parse — informational only, matches sessions.js exactly. */
function parseUA(uaString) {
  const ua = uaString || '';
  let browser = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  let os = 'Unknown';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}

function signAccessToken(secret, { userId, tenantId, role, shopName, sessionId, jwtId }) {
  return jwt.sign(
    { userId, tenantId, role, shopName, sid: sessionId, jti: jwtId },
    secret,
    { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' }
  );
}

/**
 * @param {string} jwtSecret
 * @param {{user: {id: number, role: string}, tenant: {id: number, shop_name: string}, req: import('express').Request}} ctx
 * @returns {Promise<{accessToken: string, refreshToken: string, sessionId: string}>}
 */
async function createSession(jwtSecret, { user, tenant, req }) {
  const sessionId = newSessionId();
  const jwtId = newJwtId();
  const refreshToken = newRefreshToken();
  const ua = parseUA(req.headers['user-agent']);
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;

  await sessionRepository.create({
    sessionId, tenantId: tenant.id, userId: user.id, jwtId,
    refreshTokenHash: sha256(refreshToken), ipAddress: ip, browser: ua.browser, os: ua.os,
  });

  const accessToken = signAccessToken(jwtSecret, {
    userId: user.id, tenantId: tenant.id, role: user.role, shopName: tenant.shop_name, sessionId, jwtId,
  });
  return { accessToken, refreshToken, sessionId };
}

/**
 * requireAuth calls this after verifying the JWT signature. Matches
 * sessions.js's checkSession() exactly, including the legacy-token
 * (no `sid`) pass-through.
 * @param {{sid?: string}} payload
 * @returns {Promise<{ok: boolean, legacy?: boolean}>}
 */
async function checkSession(payload) {
  if (!payload.sid) return { ok: true, legacy: true };
  const row = await sessionRepository.findStatusBySessionId(payload.sid);
  if (!row || row.status !== 'active') return { ok: false };
  await sessionRepository.touchActivity(payload.sid);
  return { ok: true, legacy: false };
}

/**
 * Matches sessions.js's refreshSession() exactly, including the 20s
 * multi-tab reuse-grace-window logic.
 * @param {string} jwtSecret
 * @param {string} refreshToken
 * @returns {Promise<{ok: boolean, reason?: string, accessToken?: string, refreshToken?: string|null, sessionId?: string}>}
 */
async function refreshSession(jwtSecret, refreshToken) {
  const hash = sha256(refreshToken);
  let row = await sessionRepository.findByRefreshTokenHash(hash);
  let graceHit = false;

  if (!row) {
    const graceCutoff = new Date(Date.now() - REFRESH_GRACE_MS);
    row = await sessionRepository.findByPrevRefreshTokenHash(hash, graceCutoff);
    graceHit = !!row;
  }
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.status !== 'active') return { ok: false, reason: 'revoked' };

  // Resolve tenant/user — a missing row here means the referenced
  // tenant/user was deleted, which cannot happen today (nothing deletes
  // tenants/users), but is checked defensively regardless.
  const tenant = await tenantRepository.findById(row.tenant_id);
  const user = await userRepository.findById(row.user_id);
  if (!tenant || !user) return { ok: false, reason: 'invalid' };

  const newJti = newJwtId();
  if (graceHit) {
    await sessionRepository.updateJwtIdOnly(row.session_id, newJti);
    const accessToken = signAccessToken(jwtSecret, {
      userId: row.user_id, tenantId: row.tenant_id, role: user.role, shopName: tenant.shop_name,
      sessionId: row.session_id, jwtId: newJti,
    });
    return { ok: true, accessToken, refreshToken: null, sessionId: row.session_id };
  }

  const newRefresh = newRefreshToken();
  await sessionRepository.rotateRefreshToken(row.session_id, sha256(newRefresh), newJti);
  const accessToken = signAccessToken(jwtSecret, {
    userId: row.user_id, tenantId: row.tenant_id, role: user.role, shopName: tenant.shop_name,
    sessionId: row.session_id, jwtId: newJti,
  });
  return { ok: true, accessToken, refreshToken: newRefresh, sessionId: row.session_id };
}

/** @param {string} sessionId @returns {Promise<boolean>} */
async function revoke(sessionId) {
  return sessionRepository.revoke(sessionId);
}

/** @param {number} tenantId @returns {Promise<number>} */
async function revokeAllForTenant(tenantId) {
  return sessionRepository.revokeAllForTenant(tenantId);
}

/** @param {string} sessionId @param {string|null} currentPage */
async function heartbeat(sessionId, currentPage) {
  await sessionRepository.touchHeartbeat(sessionId, currentPage);
}

/** @param {number} tenantId @returns {Promise<object[]>} */
async function listForTenant(tenantId) {
  return sessionRepository.listActiveByTenant(tenantId);
}

/**
 * Ownership-checked revoke — matches local.js's
 * POST /api/auth/sessions/:sessionId/revoke exactly (local.js:1074-1081).
 * @param {number} tenantId @param {string} sessionId
 * @throws {AuthenticationError} styled 404 if the session doesn't belong to this tenant (matches local.js's exact choice of 404, not 403, to avoid confirming the session ID exists at all)
 */
async function revokeOwned(tenantId, sessionId) {
  const row = await sessionRepository.findTenantIdBySessionId(sessionId);
  if (!row || row.tenant_id !== tenantId) {
    throw new NotFoundError('Session not found');
  }
  await sessionRepository.revoke(sessionId);
}

/** Matches sessions.js's runCleanup() exactly. @returns {Promise<{expired: number, deleted: number}>} */
async function runCleanup() {
  const idleCutoff = new Date(Date.now() - SESSION_IDLE_EXPIRY_MS);
  const deleteCutoff = new Date(Date.now() - CLEANUP_RETENTION_MS);
  return sessionRepository.runCleanup(idleCutoff, deleteCutoff);
}

module.exports = {
  createSession, checkSession, refreshSession, revoke, revokeAllForTenant,
  heartbeat, listForTenant, revokeOwned, runCleanup, parseUA,
};
