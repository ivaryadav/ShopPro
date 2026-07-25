/**
 * server/src/repositories/paymentRepository.js
 *
 * Persistence only (ADR-0005). Unifies Sale.payments[], RepairJob.payments[],
 * and DB.cashEntries[] — see migrations/002_operations_domain.sql header.
 * The per-context method restriction (no Bank Transfer for sale/repair) is
 * enforced in paymentService, not here (persistence only).
 */
'use strict';

const { withConnection } = require('../database');

/**
 * @param {{tenantId:number,sourceType:'sale'|'repair'|'manual',sourceId:?number,
 *   direction?:'in'|'out',method:string,amount:number,description?:string,paymentDate:string}} data
 * @returns {Promise<object>}
 */
async function create(data) {
  return withConnection(async (conn) => {
    const result = await conn.query(
      `INSERT INTO payments (tenant_id, source_type, source_id, direction, method, amount, description, payment_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.tenantId, data.sourceType, data.sourceId || null, data.direction || 'in',
        data.method, data.amount, data.description || null, data.paymentDate,
      ]
    );
    const rows = await conn.query('SELECT * FROM payments WHERE id = ?', [Number(result.insertId)]);
    return rows[0];
  });
}

/** @param {number} tenantId @param {'sale'|'repair'} sourceType @param {number} sourceId @returns {Promise<object[]>} */
async function listForSource(tenantId, sourceType, sourceId) {
  return withConnection((conn) =>
    conn.query(
      `SELECT id, method, amount, description, payment_date, created_at FROM payments
       WHERE tenant_id = ? AND source_type = ? AND source_id = ? ORDER BY created_at`,
      [tenantId, sourceType, sourceId]
    )
  );
}

/** Matches DB.cashEntries (manual entries only, source_id NULL). @param {number} tenantId @returns {Promise<object[]>} */
async function listManual(tenantId) {
  return withConnection((conn) =>
    conn.query(
      `SELECT id, direction, method, amount, description, payment_date, created_at FROM payments
       WHERE tenant_id = ? AND source_type = 'manual' ORDER BY payment_date DESC, id DESC`,
      [tenantId]
    )
  );
}

/**
 * Deletes every payment row for a given sale/repair — used by
 * saleService.updateSale/repairService's payment update, which (matching
 * local.js's own `s.payments=finalPayments` full-array-replace semantics,
 * ~line 10006) replaces a sale/repair's payment history on edit rather
 * than appending to it.
 * @param {number} tenantId @param {'sale'|'repair'} sourceType @param {number} sourceId
 */
async function deleteForSource(tenantId, sourceType, sourceId) {
  return withConnection((conn) =>
    conn.query('DELETE FROM payments WHERE tenant_id=? AND source_type=? AND source_id=?', [tenantId, sourceType, sourceId])
  );
}

module.exports = { create, listForSource, listManual, deleteForSource };
