/**
 * server/src/services/adminUserService.js
 *
 * Mirrors local.js's User Administration endpoints exactly
 * (local.js:1332-1370). Thin wrappers around Phase 2's EXISTING,
 * unmodified userService.resetPin/setActive and userRepository.findById —
 * this sprint adds the admin-specific existence-check (404) and response
 * shape those endpoints need, without touching a single line of Phase 2's
 * own files. Phase 2 built resetPin/setActive as "service-layer only, no
 * public route yet" specifically anticipating this — see userService.js's
 * own header.
 */
'use strict';

const userRepository = require('../repositories/userRepository');
const userService = require('../services/userService');
const { ValidationError, NotFoundError } = require('../errors');

/**
 * Matches POST /api/admin/reset-user-pin exactly (local.js:1333-1348).
 * @param {number} userId @param {string} newPin
 */
async function resetUserPin(userId, newPin) {
  if (!userId || !newPin) throw new ValidationError('userId and newPin required');
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  await userService.resetPin(userId, newPin); // validates the exact-6-digit PIN format, hashes, persists — matches local.js exactly
  return { userId, name: user.display_name || user.mobile, mobile: user.mobile };
}

/**
 * Matches POST /api/admin/toggle-user exactly (local.js:1350-1370),
 * including the last-active-owner protection.
 * @param {number} userId @param {boolean} active
 */
async function toggleUser(userId, active) {
  if (userId === undefined || active === undefined) throw new ValidationError('userId and active required');
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  await userService.setActive(userId, active); // last-owner guard lives here, matches local.js exactly
  return { userId, name: user.display_name || user.mobile, isActive: active };
}

module.exports = { resetUserPin, toggleUser };
