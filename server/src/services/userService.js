/**
 * server/src/services/userService.js
 *
 * Mirrors server/local.js's staff-management business rules exactly.
 * Owner-only enforcement for addStaff lives in middleware
 * (requirePermission('staff:add')), not here — this service assumes the
 * caller is already authorized and focuses on the actual business rules
 * (uniqueness, format, hashing).
 */
'use strict';

const bcrypt = require('bcryptjs');
const userRepository = require('../repositories/userRepository');
const roleRepository = require('../repositories/roleRepository');
const { ValidationError, ConflictError, BusinessRuleError, NotFoundError } = require('../errors');

const BCRYPT_ROUNDS = 10; // matches every bcrypt.hashSync(_, 10) call in local.js

/**
 * Matches local.js's POST /api/auth/add-staff exactly (local.js:1084-1112).
 * @param {{tenantId: number, displayName?: string, mobile: string, pin: string, role?: string}} params
 * @returns {Promise<{id: number, display_name: string, role: string}>}
 */
async function addStaff({ tenantId, displayName, mobile, pin, role }) {
  const mob = (mobile || '').replace(/\D/g, '');
  const roleCode = role || 'staff';

  if (!mob || !pin) {
    throw new ValidationError('Mobile number and PIN required');
  }
  if (!/^\d{4,6}$/.test(pin)) {
    throw new ValidationError('PIN must be 4 to 6 digits');
  }

  const existing = await userRepository.findAnyByMobile(mob);
  if (existing) {
    throw new ConflictError('Mobile number is already registered');
  }

  const roleRow = await roleRepository.findByCode(roleCode);
  if (!roleRow) {
    // local.js has no equivalent guard (it trusts `role` as free text) —
    // this is a genuine, low-risk hardening from the role_id FK, not a
    // behavior change: local.js never accepts any role value other than
    // 'staff'/'owner' from any real client either.
    throw new ValidationError(`Unknown role '${roleCode}'`);
  }

  const passwordHash = bcrypt.hashSync(pin, BCRYPT_ROUNDS);
  const user = await userRepository.create({ tenantId, mobile: mob, displayName, passwordHash, roleId: roleRow.id });
  return { id: user.id, display_name: user.display_name, role: user.role };
}

/**
 * Matches local.js's POST /api/admin/reset-user-pin exactly
 * (local.js:1333-1348), including its OWN, different PIN-format rule
 * (exactly 6 digits — not the 4-6 digit rule addStaff/login use; this is
 * a real, pre-existing inconsistency in local.js, preserved as-is).
 *
 * No public HTTP route exposes this in Phase 2 — the real endpoint is
 * gated by requireAdminKey (AdminCredentials/Super Admin), which is out
 * of scope (Administration domain). This service capability exists for
 * a future phase to wire up once that gate is migrated.
 * @param {number} userId @param {string} newPin
 */
async function resetPin(userId, newPin) {
  if (!/^\d{6}$/.test(newPin)) {
    throw new ValidationError('PIN must be exactly 6 digits');
  }
  const passwordHash = bcrypt.hashSync(newPin, BCRYPT_ROUNDS);
  await userRepository.updatePasswordHash(userId, passwordHash);
}

/**
 * Matches local.js's POST /api/admin/toggle-user exactly (local.js:1351-1370),
 * including the last-active-owner guard. Same "no public route yet" note
 * as resetPin above applies.
 * @param {number} userId @param {boolean} active
 */
async function setActive(userId, active) {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  if (user.role === 'owner' && !active) {
    const ownerCount = await userRepository.countActiveOwners(user.tenant_id);
    if (ownerCount <= 1) {
      throw new BusinessRuleError('Cannot disable the only active owner of a shop.', 'LAST_OWNER_PROTECTED');
    }
  }
  await userRepository.setActive(userId, active);
}

/**
 * Matches local.js's GET /api/data/users exactly (local.js:1740-1749).
 * @param {number} tenantId
 * @returns {Promise<object[]>}
 */
async function listUsers(tenantId) {
  return userRepository.listByTenant(tenantId);
}

module.exports = { addStaff, resetPin, setActive, listUsers, BCRYPT_ROUNDS };
