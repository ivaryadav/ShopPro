/**
 * server/src/services/tenantService.js
 *
 * Mirrors server/local.js's requireActive() business rule exactly, EXCEPT
 * for the license_expiry/license_plan check — those columns are Licensing-
 * domain data, out of scope for Phase 2 (docs/database/MigrationNotes.md).
 * Only the paused/terminated check is ported. This is a real, deliberate,
 * documented behavioral gap versus local.js — not a silent omission.
 */
'use strict';

const tenantRepository = require('../repositories/tenantRepository');
const { AuthorizationError, NotFoundError } = require('../errors');

/**
 * @param {number} tenantId
 * @throws {NotFoundError} if the tenant doesn't exist
 * @throws {AuthorizationError} if paused or terminated (matches local.js's exact messages/status fields)
 */
async function assertActive(tenantId) {
  const t = await tenantRepository.findStatusById(tenantId);
  if (!t) throw new NotFoundError('Tenant not found');
  if (t.status === 'paused') {
    throw new AuthorizationError('Account paused', { status: 'paused', reason: t.suspend_reason || '' });
  }
  if (t.status === 'terminated') {
    throw new AuthorizationError('Account terminated', { status: 'terminated', reason: t.suspend_reason || '' });
  }
  // NOTE: local.js also checks license_expiry/license_plan here for legacy
  // key-based tenants. Not ported — Licensing domain, out of scope.
}

module.exports = { assertActive };
