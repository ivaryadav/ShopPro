/**
 * server/src/repositories/licenseHistoryRepository.js
 *
 * Persistence only (ADR-0005). Matches local.js's addLicenseHistory()
 * exactly (local.js:337-341) — event_type is free text, not an enum,
 * matching local.js's own untyped column.
 */
'use strict';

const { withConnection } = require('../database');

/**
 * @param {{tenantId:number,eventType:string,fromStatus?:string,toStatus?:string,detail?:string,actor?:string}} data
 */
async function record(data) {
  await withConnection((conn) =>
    conn.query(
      'INSERT INTO license_history (tenant_id, event_type, from_status, to_status, detail, actor) VALUES (?, ?, ?, ?, ?, ?)',
      [data.tenantId, data.eventType, data.fromStatus || null, data.toStatus || null, data.detail || '', data.actor || 'system']
    )
  );
}

/** @param {number} tenantId @returns {Promise<object[]>} newest first, matches local.js's ORDER BY created_at DESC */
async function listForTenant(tenantId) {
  return withConnection((conn) =>
    conn.query('SELECT * FROM license_history WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId])
  );
}

module.exports = { record, listForTenant };
