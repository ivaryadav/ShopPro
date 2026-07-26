/**
 * platform/src/services/passwordService.js — configurable Password
 * Policies (Phase 5B): complexity rules, reuse history, and the two real
 * places a Platform User's password is ever set — self-service change and
 * admin-driven reset. Both paths, plus initial account creation, go
 * through the same validateAgainstPolicy()/checkHistory() so nothing can
 * bypass policy by using a different endpoint.
 */
'use strict';

const bcrypt = require('bcryptjs');
const userRepository = require('../repositories/platformUserRepository');
const historyRepository = require('../repositories/platformPasswordHistoryRepository');
const policyRepository = require('../repositories/platformPasswordPolicyRepository');
const auditService = require('./auditService');
const { ValidationError, AuthenticationError } = require('../errors');

function validateAgainstPolicy(password, policy) {
  const missing = [];
  if (!password || password.length < policy.min_length) missing.push(`at least ${policy.min_length} characters`);
  if (policy.require_uppercase && !/[A-Z]/.test(password || '')) missing.push('an uppercase letter');
  if (policy.require_lowercase && !/[a-z]/.test(password || '')) missing.push('a lowercase letter');
  if (policy.require_number && !/[0-9]/.test(password || '')) missing.push('a number');
  if (policy.require_symbol && !/[^A-Za-z0-9]/.test(password || '')) missing.push('a symbol');
  if (missing.length) throw new ValidationError('Password must contain ' + missing.join(', ') + '.');
}
function checkHistory(userId, newPassword, historyCount) {
  if (!historyCount) return;
  const recent = historyRepository.recentForUser(userId, historyCount);
  for (const r of recent) {
    if (bcrypt.compareSync(newPassword, r.password_hash)) {
      throw new ValidationError(`This password was used recently — choose one you haven't used in your last ${historyCount} password(s).`);
    }
  }
}
/** Validates, archives the OLD hash to history, then sets the new one. Shared by every password-setting path. */
function setPassword(userId, newPassword, policy) {
  const p = policy || policyRepository.get();
  validateAgainstPolicy(newPassword, p);
  checkHistory(userId, newPassword, p.history_count);
  const user = userRepository.findById(userId);
  if (user.password_hash) historyRepository.record(userId, user.password_hash);
  const newHash = bcrypt.hashSync(newPassword, 10);
  userRepository.updatePassword(userId, newHash);
  return newHash;
}
function changeOwnPassword(userId, currentPassword, newPassword, actor) {
  const user = userRepository.findById(userId);
  if (!user) throw new ValidationError('User not found');
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) throw new AuthenticationError('Current password is incorrect.');
  setPassword(userId, newPassword);
  auditService.record({ platformUserId: userId, action: 'PLATFORM_PASSWORD_CHANGED', detail: user.email, ip: actor.ip });
  return { ok: true };
}
function adminResetPassword(targetUserId, newPassword, actor) {
  const user = userRepository.findById(targetUserId);
  if (!user) throw new ValidationError('User not found');
  setPassword(targetUserId, newPassword);
  auditService.record({ platformUserId: actor.userId, action: 'PLATFORM_USER_PASSWORD_RESET', detail: user.email, ip: actor.ip });
  return { ok: true };
}

module.exports = { validateAgainstPolicy, checkHistory, setPassword, changeOwnPassword, adminResetPassword };
