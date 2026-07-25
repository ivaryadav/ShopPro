/**
 * server/src/repositories/stockMovementRepository.js
 *
 * Persistence only (ADR-0005). New capability (no current data to
 * migrate) — see migrations/002_operations_domain.sql header for the
 * exact write-path mapping to local.js's 4 stock-mutation call sites.
 */
'use strict';

const { withConnection } = require('../database');

/**
 * @param {{tenantId:number,productId:?number,delta:number,reason:string,
 *   referenceType?:string,referenceId?:number,note?:string,createdBy?:number}} data
 * @returns {Promise<void>}
 */
async function record(data) {
  await withConnection((conn) =>
    conn.query(
      `INSERT INTO stock_movements (tenant_id, product_id, delta, reason, reference_type, reference_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.tenantId, data.productId, data.delta, data.reason,
        data.referenceType || null, data.referenceId || null, data.note || null, data.createdBy || null,
      ]
    )
  );
}

/** @param {number} tenantId @param {number} productId @returns {Promise<object[]>} */
async function listByProduct(tenantId, productId) {
  return withConnection((conn) =>
    conn.query(
      `SELECT id, product_id, delta, reason, reference_type, reference_id, note, created_by, created_at
       FROM stock_movements WHERE tenant_id = ? AND product_id = ? ORDER BY created_at DESC`,
      [tenantId, productId]
    )
  );
}

module.exports = { record, listByProduct };
