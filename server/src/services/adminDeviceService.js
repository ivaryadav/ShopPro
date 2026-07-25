/**
 * server/src/services/adminDeviceService.js
 *
 * Mirrors local.js's admin Device Management endpoints exactly
 * (local.js:1613-1652). Uses adminDirectoryRepository (this sprint's own
 * new file) for the trusted_devices reads/writes these actions need,
 * rather than touching Phase 2's trustedDeviceRepository.js — see that
 * repository's file header for the full reasoning. Each mutating action
 * also logs a license_history event via Sprint 1's
 * licenseHistoryRepository, matching local.js's addLicenseHistory calls exactly.
 */
'use strict';

const adminDirectoryRepository = require('../repositories/adminDirectoryRepository');
const licenseHistoryRepository = require('../repositories/licenseHistoryRepository');
const { NotFoundError } = require('../errors');

/** Matches GET /api/admin/tenant-licenses/:tenantId/devices exactly (local.js:1613-1621). @param {number} tenantId */
async function listDevices(tenantId) {
  return adminDirectoryRepository.listDevicesForTenant(tenantId);
}

/** Matches devices/:rowId/remove exactly (local.js:1625-1633) — soft-remove only. @param {number} tenantId @param {number} rowId */
async function removeDevice(tenantId, rowId) {
  const exists = await adminDirectoryRepository.findDeviceRow(tenantId, rowId);
  if (!exists) throw new NotFoundError('Device not found');
  await adminDirectoryRepository.deactivateDevice(rowId);
  await licenseHistoryRepository.record({ tenantId, eventType: 'DEVICE_REMOVED', detail: `device row ${rowId}`, actor: 'admin' });
}

/** Matches devices/reset-all exactly (local.js:1636-1641). @param {number} tenantId */
async function resetAllDevices(tenantId) {
  const reset = await adminDirectoryRepository.deactivateAllDevices(tenantId);
  await licenseHistoryRepository.record({ tenantId, eventType: 'DEVICES_RESET', detail: `${reset} device(s) reset`, actor: 'admin' });
  return { reset };
}

module.exports = { listDevices, removeDevice, resetAllDevices };
