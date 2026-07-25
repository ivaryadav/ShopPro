/**
 * server/src/services/authService.js
 *
 * Mirrors server/local.js's POST /api/auth/login exactly
 * (local.js:965-1037), including its anti-enumeration posture: the
 * generic failure message and status code are identical whether the
 * mobile number doesn't exist or the PIN is wrong, and the real reason is
 * only ever logged server-side (docs/independent-audit/IndependentSecurityReview.md §4).
 * Never change this to a more "helpful" per-case message.
 */
'use strict';

const bcrypt = require('bcryptjs');
const userRepository = require('../repositories/userRepository');
const trustedDeviceService = require('./trustedDeviceService');
const sessionService = require('./sessionService');
const { AuthenticationError, ValidationError } = require('../errors');
const { getLogger } = require('../logging');

const GENERIC_LOGIN_FAILURE = 'Invalid mobile number or PIN.';

/**
 * @param {{mobile: string, pin: string, deviceId?: string}} credentials
 * @param {import('express').Request} req
 * @param {string} jwtSecret
 * @returns {Promise<{token: string, refreshToken: string, shopName: string, username: string, role: string}>}
 * @throws {ValidationError} if mobile/pin missing
 * @throws {AuthenticationError} GENERIC_LOGIN_FAILURE for both "no such account" and "wrong PIN" — never distinguishable
 */
async function login({ mobile, pin, deviceId }, req, jwtSecret) {
  const logger = getLogger();
  const mob = (mobile || '').replace(/\D/g, '');
  if (!mob || !pin) {
    throw new ValidationError('Mobile number and PIN are required');
  }

  const row = await userRepository.findActiveByMobile(mob);
  if (!row) {
    logger.warn('[Auth] Login failed', { reason: 'mobile not registered' });
    throw new AuthenticationError(GENERIC_LOGIN_FAILURE);
  }
  if (!bcrypt.compareSync(pin, row.password_hash)) {
    logger.warn('[Auth] Login failed', { reason: 'incorrect PIN', tenantId: row.tenant_id, userId: row.id });
    throw new AuthenticationError(GENERIC_LOGIN_FAILURE);
  }

  // Device-limit enforcement — only when deviceId is sent, matching
  // local.js exactly (absent = old client build, unaffected).
  await trustedDeviceService.checkAndTrust({
    tenantId: row.tenant_id, userId: row.id, deviceId, userAgent: req.headers['user-agent'],
  });

  await userRepository.touchLastLogin(row.id);

  const tenant = { id: row.tenant_id, shop_name: row.shop_name };
  const user = { id: row.id, role: row.role };
  const session = await sessionService.createSession(jwtSecret, { user, tenant, req });

  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    shopName: row.shop_name,
    username: row.display_name || row.username,
    role: row.role,
    // local.js also returns licenseExpiry/licensePlan here, read from
    // tenants.license_expiry/license_plan — Licensing-domain columns, out
    // of scope for Phase 2 (docs/database/MigrationNotes.md). Returned as
    // null/'monthly' to match local.js's OWN fallback values for the
    // "tenantInfo lookup found nothing" case (local.js:1030-1031) — not a
    // new default invented for this phase.
    licenseExpiry: null,
    licensePlan: 'monthly',
  };
}

module.exports = { login, GENERIC_LOGIN_FAILURE };
