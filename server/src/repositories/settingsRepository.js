/**
 * server/src/repositories/settingsRepository.js
 *
 * Persistence only (ADR-0005). Configuration stays JSON per ADR-0008 —
 * this is the one repository in the Operations domain that reads/writes
 * a JSON blob rather than normalized columns, by deliberate design, not
 * an inconsistency.
 */
'use strict';

const { withConnection } = require('../database');

/** @param {number} tenantId @returns {Promise<object>} parsed settings, or {} if no row exists yet */
async function get(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT settings_json FROM tenant_settings WHERE tenant_id = ?', [tenantId]);
    if (!rows[0]) return {};
    const raw = rows[0].settings_json;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  });
}

/**
 * Upserts the full settings object (matches local.js's PUT /api/data
 * whole-blob-replace semantics for DB.settings — no partial merge).
 * @param {number} tenantId @param {object} settings
 * @returns {Promise<object>}
 */
async function put(tenantId, settings) {
  const json = JSON.stringify(settings || {});
  await withConnection((conn) =>
    conn.query(
      `INSERT INTO tenant_settings (tenant_id, settings_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
      [tenantId, json]
    )
  );
  return settings;
}

module.exports = { get, put };
