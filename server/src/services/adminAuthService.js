/**
 * server/src/services/adminAuthService.js
 *
 * Mirrors local.js's Administration login/session mechanism exactly
 * (local.js:482-517, 1191-1232): a real password login (bcrypt, with
 * automatic upgrade from the legacy single-round-sha256 scheme) exchanged
 * for a short-lived, random, in-memory session token — replacing the old
 * "static X-Admin-Key compared every request" model. This is Administration's
 * OWN credential/session system, entirely separate from the tenant-user
 * JWT auth Phase 2 built (requireAuth/sessionService) — building it is not
 * "touching Authentication," it's completing the one piece of
 * Administration's own auth this sprint's mission requires.
 */
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const adminCredentialRepository = require('../repositories/adminCredentialRepository');
const { AuthenticationError, ValidationError } = require('../errors');

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // matches local.js:492 exactly
const BCRYPT_ROUNDS = 10; // matches every bcrypt.hashSync(_, 10) call in local.js

/** @type {Map<string, number>} token -> expiresAt (ms) — matches local.js:493's module-level Map exactly */
const _adminSessions = new Map();

/** Matches local.js:494-498 exactly. @returns {string} */
function issueAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  _adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}

/**
 * Matches requireAdminKey's validation logic exactly (local.js:505-517):
 * timing-safe compare against every non-expired session token, pruning
 * expired ones as it goes.
 * @param {string} key @returns {boolean}
 */
function isValidAdminSession(key) {
  const keyBuf = Buffer.from(key || '', 'utf8');
  const now = Date.now();
  for (const [token, expiresAt] of _adminSessions) {
    if (expiresAt <= now) { _adminSessions.delete(token); continue; }
    const tokenBuf = Buffer.from(token, 'utf8');
    if (keyBuf.length === tokenBuf.length && crypto.timingSafeEqual(keyBuf, tokenBuf)) {
      return true;
    }
  }
  return false;
}

/**
 * Seeds admin_credentials from the ADMIN_KEY env var on first boot only —
 * matches local.js:321 exactly (idempotent, never overwrites an existing row).
 * @param {string} adminKeySeed
 */
async function ensureSeeded(adminKeySeed) {
  await adminCredentialRepository.ensureSeeded(adminKeySeed);
}

/**
 * Matches POST /api/admin/login exactly (local.js:1197-1232): bcrypt if
 * already migrated, else legacy single-round sha256 with automatic
 * transparent upgrade to bcrypt on successful legacy verification.
 *
 * Status-code note: local.js returns 400 for a missing password, 401 for
 * a wrong one, 500 for a missing admin_credentials row (a genuine
 * misconfiguration that should never occur once boot-seeding runs).
 * The missing-password case is reproduced exactly (ValidationError, 400)
 * since it's plain input validation, not security-sensitive. The
 * missing-row case uses AuthenticationError (401) rather than exposing
 * local.js's distinct 'Admin credentials not configured' message —
 * Phase 1's errorHandler deliberately never leaks internal-state messages
 * to the caller (errors.test.js), and this scenario should be unreachable
 * in a correctly-booted system, so preserving that security posture here
 * was judged more valuable than matching an edge-case status code exactly.
 * @param {string} password @returns {Promise<string>} the new admin session token
 */
async function login(password) {
  if (!password) throw new ValidationError('Invalid credentials');
  const row = await adminCredentialRepository.get();
  if (!row) throw new AuthenticationError('Invalid credentials');

  let verified = false;
  if (row.algo === 'bcrypt') {
    verified = bcrypt.compareSync(password, row.password_hash);
  } else {
    const candidate = crypto.createHash('sha256').update(password).digest('hex');
    const candidateBuf = Buffer.from(candidate, 'utf8');
    const storedBuf = Buffer.from(row.password_hash, 'utf8');
    verified = candidateBuf.length === storedBuf.length && crypto.timingSafeEqual(candidateBuf, storedBuf);
    if (verified) {
      const newHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
      await adminCredentialRepository.updateHash(newHash, 'bcrypt');
    }
  }

  if (!verified) throw new AuthenticationError('Invalid credentials');
  return issueAdminSession();
}

/** Test-only: discards every in-memory admin session. */
function _resetForTests() {
  _adminSessions.clear();
}

module.exports = { ensureSeeded, login, isValidAdminSession, issueAdminSession, _resetForTests };
