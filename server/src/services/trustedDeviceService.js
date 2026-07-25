/**
 * server/src/services/trustedDeviceService.js
 *
 * Mirrors server/local.js's inline device-trust logic inside
 * POST /api/auth/login exactly (local.js:989-1018).
 *
 * IMPORTANT DEVIATION, documented per the mission's own instruction ("if
 * code and documentation disagree, document it — do not silently change
 * behavior"): local.js reads the per-tenant device_limit from
 * `tenant_licenses.device_limit`, falling back to a fixed default of 2
 * when no license row exists (`lic ? lic.device_limit : 2`,
 * local.js:1000-1001). Since TenantLicense is out of scope for Phase 2
 * (Licensing domain), this service always takes that same fallback path —
 * it is not new behavior, it is the one branch of local.js's own existing
 * logic that doesn't depend on the out-of-scope table. Wiring the real
 * per-plan limit back in is deferred to whichever future phase migrates
 * Licensing (docs/database/MigrationNotes.md).
 */
'use strict';

const trustedDeviceRepository = require('../repositories/trustedDeviceRepository');
const sessionService = require('./sessionService');
const { BusinessRuleError } = require('../errors');

const FALLBACK_DEVICE_LIMIT = 2; // local.js's own "no tenant_licenses row" default

/**
 * @param {{tenantId: number, userId: number, deviceId: string|null|undefined, userAgent: string}} params
 * @throws {BusinessRuleError} DEVICE_LIMIT_REACHED — matches local.js's exact error shape
 */
async function checkAndTrust({ tenantId, userId, deviceId, userAgent }) {
  // Matches local.js:991 exactly: absent deviceId = old client build,
  // byte-identical old behavior (no device-trust logic runs at all).
  if (!deviceId) return;

  const ua = sessionService.parseUA(userAgent);
  const known = await trustedDeviceRepository.findActive(tenantId, userId, deviceId);

  if (known) {
    await trustedDeviceRepository.touchLogin(known.id, ua.browser, ua.os);
    return;
  }

  const deviceLimit = FALLBACK_DEVICE_LIMIT;
  const activeCount = await trustedDeviceRepository.countActiveForTenant(tenantId);
  if (activeCount >= deviceLimit) {
    throw new BusinessRuleError(
      `Device limit reached (${activeCount}/${deviceLimit}). Ask your admin to remove an old device or increase your limit.`,
      'DEVICE_LIMIT_REACHED'
    );
  }
  await trustedDeviceRepository.createIgnoringRace(tenantId, userId, deviceId, ua.browser, ua.os);
}

module.exports = { checkAndTrust, FALLBACK_DEVICE_LIMIT };
