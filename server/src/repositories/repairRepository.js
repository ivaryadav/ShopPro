/**
 * server/src/repositories/repairRepository.js
 *
 * Persistence only (ADR-0005). Repair and RepairPart handled together —
 * same aggregate-boundary reasoning as saleRepository.js. `paid` is
 * derived from the unified `payments` table (source_type='repair'),
 * matching local.js's own `r.paidAmount` semantics without duplicating it.
 */
'use strict';

const { withConnection } = require('../database');

const REPAIR_SELECT = `
  SELECT r.id, r.tenant_id, r.job_no, r.customer_id, c.name AS customer_name,
         r.device, r.issue, r.status, r.estimated_cost, r.final_cost, r.labour_charge,
         r.received_date, r.estimated_delivery, r.delivered_date, r.warranty_days,
         r.alt_whatsapp, r.note, r.created_by, r.created_at,
         COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.source_type='repair' AND p.source_id=r.id), 0) AS paid
  FROM repairs r JOIN customers c ON c.id = r.customer_id
`;

/** @param {number} tenantId @param {number} repairId @returns {Promise<object[]>} */
async function findParts(tenantId, repairId) {
  return withConnection((conn) =>
    conn.query(
      `SELECT rp.id, rp.product_id, rp.product_name, rp.price, rp.qty
       FROM repair_parts rp JOIN repairs r ON r.id = rp.repair_id
       WHERE r.tenant_id = ? AND rp.repair_id = ?`,
      [tenantId, repairId]
    )
  );
}

/** @param {number} tenantId @returns {Promise<object[]>} */
async function listByTenant(tenantId) {
  return withConnection((conn) =>
    conn.query(`${REPAIR_SELECT} WHERE r.tenant_id = ? ORDER BY r.received_date DESC, r.id DESC`, [tenantId])
  );
}

/** @param {number} tenantId @param {number} id @returns {Promise<object|null>} */
async function findById(tenantId, id) {
  const repair = await withConnection(async (conn) => {
    const rows = await conn.query(`${REPAIR_SELECT} WHERE r.tenant_id = ? AND r.id = ?`, [tenantId, id]);
    return rows[0] || null;
  });
  if (!repair) return null;
  repair.partsUsed = await findParts(tenantId, id);
  return repair;
}

/** Matches nextJobNo's self-healing numbering (~line 3965), tenant-scoped. */
async function maxJobNumber(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query(
      `SELECT job_no FROM repairs WHERE tenant_id = ? AND job_no REGEXP '^JOB-[0-9]+$'`,
      [tenantId]
    );
    return rows.reduce((max, r) => {
      const n = parseInt(r.job_no.slice(4), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
  });
}

/** @param {number} tenantId @param {string} jobNo @returns {Promise<boolean>} */
async function jobNoExists(tenantId, jobNo) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT 1 FROM repairs WHERE tenant_id = ? AND job_no = ?', [tenantId, jobNo]);
    return rows.length > 0;
  });
}

/**
 * @param {{tenantId:number,jobNo:string,customerId:number,device:string,issue:string,
 *   estimatedCost:number,receivedDate:string,estimatedDelivery?:string,warrantyDays:number,
 *   altWhatsapp?:string,note?:string,createdBy?:number}} data
 * @returns {Promise<object>}
 */
async function create(data) {
  const repairId = await withConnection(async (conn) => {
    const result = await conn.query(
      `INSERT INTO repairs (tenant_id, job_no, customer_id, device, issue, status, estimated_cost,
        received_date, estimated_delivery, warranty_days, alt_whatsapp, note, created_by)
       VALUES (?, ?, ?, ?, ?, 'Received', ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.tenantId, data.jobNo, data.customerId, data.device, data.issue, data.estimatedCost,
        data.receivedDate, data.estimatedDelivery || null, data.warrantyDays, data.altWhatsapp || null,
        data.note || null, data.createdBy || null,
      ]
    );
    return Number(result.insertId);
  });
  return findById(data.tenantId, repairId);
}

/**
 * Matches addJobPart's merge-by-productId behavior (~line 11295-11296):
 * increments qty on an existing part row for the same product instead of
 * inserting a duplicate line.
 * @param {number} tenantId @param {number} repairId
 * @param {{productId:number,productName:string,price:number,qty:number}} part
 */
async function addOrMergePart(tenantId, repairId, part) {
  return withConnection(async (conn) => {
    const existing = await conn.query(
      `SELECT rp.id, rp.qty FROM repair_parts rp JOIN repairs r ON r.id = rp.repair_id
       WHERE r.tenant_id = ? AND rp.repair_id = ? AND rp.product_id = ?`,
      [tenantId, repairId, part.productId]
    );
    if (existing[0]) {
      await conn.query('UPDATE repair_parts SET qty = qty + ? WHERE id = ?', [part.qty, existing[0].id]);
    } else {
      await conn.query(
        'INSERT INTO repair_parts (repair_id, product_id, product_name, price, qty) VALUES (?, ?, ?, ?, ?)',
        [repairId, part.productId, part.productName, part.price, part.qty]
      );
    }
  });
}

/**
 * @param {number} tenantId @param {number} repairId @param {number} partId
 * @returns {Promise<object|null>} the removed row (for stock restoration), or null if not found
 */
async function removePart(tenantId, repairId, partId) {
  return withConnection(async (conn) => {
    const rows = await conn.query(
      `SELECT rp.id, rp.product_id, rp.qty FROM repair_parts rp JOIN repairs r ON r.id = rp.repair_id
       WHERE r.tenant_id = ? AND rp.repair_id = ? AND rp.id = ?`,
      [tenantId, repairId, partId]
    );
    const part = rows[0] || null;
    if (part) await conn.query('DELETE FROM repair_parts WHERE id = ?', [partId]);
    return part;
  });
}

/** Matches setJobStatus's free transition (~line 11123-11127), including auto-stamping delivered_date. */
async function updateStatus(tenantId, id, status, deliveredDate) {
  return withConnection((conn) =>
    conn.query('UPDATE repairs SET status=?, delivered_date=COALESCE(delivered_date, ?) WHERE tenant_id=? AND id=?', [
      status, status === 'Delivered' ? deliveredDate : null, tenantId, id,
    ])
  );
}

/** Matches saveJobChanges' auto-calculated final_cost (parts + labour, ~line 11326-11327). */
async function updateFinancials(tenantId, id, labourCharge, finalCost) {
  return withConnection((conn) =>
    conn.query('UPDATE repairs SET labour_charge=?, final_cost=? WHERE tenant_id=? AND id=?', [labourCharge, finalCost, tenantId, id])
  );
}

/**
 * @param {number} tenantId @param {number} id
 * @returns {Promise<object|null>} the repair with its parts (for stock restoration by the
 *   service layer), fetched before the row is deleted — matches deleteJob's
 *   "restore parts to stock, then remove" order (~line 10418-10423)
 */
async function remove(tenantId, id) {
  const repair = await findById(tenantId, id);
  if (!repair) return null;
  await withConnection((conn) => conn.query('DELETE FROM repairs WHERE tenant_id=? AND id=?', [tenantId, id]));
  return repair;
}

module.exports = {
  listByTenant, findById, findParts, maxJobNumber, jobNoExists,
  create, addOrMergePart, removePart, updateStatus, updateFinancials, remove,
};
