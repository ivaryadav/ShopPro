/**
 * server/src/services/cloudBackupService.js
 *
 * Mirrors local.js's Cloud Backup business rules exactly (local.js:
 * 1751-1784). This is the OFFLINE DESKTOP product's server-side backup
 * bridge — keyed by license-key hash, not tenant_id (see
 * migrations/005_cloud_backup_domain.sql's header for why this table has
 * no tenant scoping at all, unlike every other domain migrated so far).
 *
 * Validation is preserved EXACTLY as local.js has it — deliberately
 * minimal (presence checks only). local.js does not checksum, encrypt,
 * version, or otherwise validate the `data` blob's content server-side
 * (the comment at local.js:1751 notes the client is expected to encrypt
 * before sending) — this service does not add any of that, since doing
 * so would be inventing new behavior, not preserving existing behavior.
 */
'use strict';

const cloudBackupRepository = require('../repositories/cloudBackupRepository');
const { ValidationError, NotFoundError } = require('../errors');

/**
 * Matches POST /api/cloud/backup exactly (local.js:1753-1771) — an
 * upsert: calling this twice for the same keyHash overwrites the first
 * backup, there is no history. This is local.js's real, deliberate design
 * (one backup slot per license), preserved exactly, not a bug.
 * @param {{keyHash:string,shopName?:string,data:string}} params
 */
async function createOrUpdateBackup({ keyHash, shopName, data }) {
  if (!keyHash || !data) throw new ValidationError('keyHash and data required');
  await cloudBackupRepository.upsert({ keyHash, shopName, data });
}

/**
 * Matches GET /api/cloud/restore/:keyHash exactly (local.js:1774-1778).
 * @param {string} keyHash @returns {Promise<{data:string,shopName:string,backedUpAt:Date}>}
 */
async function restoreBackup(keyHash) {
  const row = await cloudBackupRepository.findByKeyHash(keyHash);
  if (!row) throw new NotFoundError('No backup found for this license key');
  return { data: row.data, shopName: row.shop_name, backedUpAt: row.backed_up_at };
}

/**
 * Matches DELETE /api/cloud/backup/:keyHash exactly (local.js:1781-1784)
 * — deliberately NO existence check, matching local.js's own
 * unconditional DELETE (always reports {ok:true}, even if no row
 * existed for that key_hash). Preserved as-is, not "fixed" with a 404.
 * @param {string} keyHash
 */
async function deleteBackup(keyHash) {
  await cloudBackupRepository.remove(keyHash);
}

/** No local.js equivalent endpoint — repository-only, see cloudBackupRepository.js. @returns {Promise<object[]>} */
async function listBackups() {
  return cloudBackupRepository.listAll();
}

module.exports = { createOrUpdateBackup, restoreBackup, deleteBackup, listBackups };
