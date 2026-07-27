/**
 * platform/src/services/mfaService.js — TOTP-based MFA for Platform Users
 * only (Phase 5B). Standard RFC 6238 TOTP + a standard otpauth:// URI —
 * this is what makes Google Authenticator, Microsoft Authenticator, and
 * Authy all work identically with zero per-app-specific code; they're
 * just three different apps reading the same standard QR code.
 *
 * Tenant/product end-users are completely untouched by this file.
 */
'use strict';

const otplib = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/connection');
const userRepository = require('../repositories/platformUserRepository');
const recoveryCodeRepository = require('../repositories/platformMfaRecoveryCodeRepository');
const trustedDeviceRepository = require('../repositories/platformTrustedDeviceRepository');
const auditService = require('./auditService');
const eventBusService = require('./eventBusService');
const { ValidationError, AuthenticationError } = require('../errors');

function assertPassword(user, password) {
  if (!bcrypt.compareSync(password || '', user.password_hash)) throw new AuthenticationError('Current password is incorrect.');
}

const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'Z-SUPERADMIN';

function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) codes.push(crypto.randomBytes(5).toString('hex').toUpperCase());
  return codes;
}

/** Step 1 of enrollment — generates a new secret (not yet active) + a QR code for it. */
async function beginSetup(userId, email) {
  const secret = await otplib.generateSecret();
  const otpauthUrl = await otplib.generateURI({ issuer: ISSUER, label: email, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  userRepository.setTotpSecret(userId, secret);
  return { secret, otpauthUrl, qrDataUrl };
}

/** Step 2 — confirms the user's authenticator app produces the right code, activates MFA, and issues one-time recovery codes. */
async function confirmSetup(userId, code, actor) {
  const user = userRepository.findById(userId);
  if (!user || !user.totp_secret) throw new ValidationError('No pending MFA setup found for this account — start setup again.');
  const result = await otplib.verify({ token: String(code || ''), secret: user.totp_secret });
  if (!result || !result.valid) throw new ValidationError('Invalid authentication code.');
  const codes = generateRecoveryCodes();
  // Atomic: a crash between enabling TOTP and writing recovery codes would
  // otherwise leave an account with MFA on but zero recovery codes — no
  // way back in if the device is ever lost. Found during the Phase 5B.1
  // security audit's transaction review.
  getDb().transaction(() => {
    userRepository.enableTotp(userId);
    recoveryCodeRepository.replaceAllForUser(userId, codes.map((c) => bcrypt.hashSync(c, 10)));
  })();
  auditService.record({ platformUserId: userId, action: 'MFA_ENABLED', detail: user.email, ip: actor.ip });
  eventBusService.publish({ eventType: 'mfa.enabled', organizationId: null, payload: { platformUserId: userId, email: user.email } });
  return { recoveryCodes: codes };
}

/** Requires the current password — same standard practice every mature console uses before letting a session turn off 2FA. */
function disable(userId, password, actor) {
  const user = userRepository.findById(userId);
  if (!user) throw new ValidationError('User not found');
  assertPassword(user, password);
  const revokedDevices = getDb().transaction(() => {
    userRepository.disableTotp(userId);
    recoveryCodeRepository.deleteAllForUser(userId);
    return trustedDeviceRepository.revokeAllForUser(userId);
  })();
  auditService.record({ platformUserId: userId, action: 'MFA_DISABLED', detail: `${user.email} — ${revokedDevices} trusted device(s) also revoked`, ip: actor.ip });
  return { ok: true };
}

/** Also requires the current password — a stolen session alone shouldn't be able to mint fresh usable recovery codes. */
function regenerateRecoveryCodes(userId, password, actor) {
  const user = userRepository.findById(userId);
  if (!user) throw new ValidationError('User not found');
  assertPassword(user, password);
  const codes = generateRecoveryCodes();
  recoveryCodeRepository.replaceAllForUser(userId, codes.map((c) => bcrypt.hashSync(c, 10)));
  auditService.record({ platformUserId: userId, action: 'RECOVERY_CODES_REGENERATED', detail: user.email, ip: actor.ip });
  return { recoveryCodes: codes };
}

async function verifyTotp(secret, code) {
  const result = await otplib.verify({ token: String(code || ''), secret });
  return !!(result && result.valid);
}

/** Single-use — the first matching unused code is consumed and can never be used again. */
function consumeRecoveryCode(userId, rawCode) {
  const normalized = String(rawCode || '').trim().toUpperCase();
  if (!normalized) return false;
  const candidates = recoveryCodeRepository.listUnusedForUser(userId);
  for (const c of candidates) {
    if (bcrypt.compareSync(normalized, c.code_hash)) { recoveryCodeRepository.markUsed(c.id); return true; }
  }
  return false;
}

module.exports = { beginSetup, confirmSetup, disable, regenerateRecoveryCodes, verifyTotp, consumeRecoveryCode };
