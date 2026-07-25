/**
 * server/src/repositories/saleRepository.js
 *
 * Persistence only (ADR-0005). Sale and SaleItem are handled together —
 * a SaleItem has no independent lifecycle apart from its parent Sale
 * (confirmed: local.js never queries/creates one outside a Sale), so one
 * repository owns both tables, matching the practical aggregate boundary
 * rather than a mechanical one-file-per-table split.
 *
 * `paid` is NOT a stored column (see migrations/002_operations_domain.sql —
 * no status/paid field on `sales`; local.js's own `s.paid` is derived by
 * summing payments) — every read here computes it via a join against the
 * unified `payments` table (source_type='sale'), matching local.js's own
 * `s.paid` semantics without duplicating the value in two places.
 *
 * No `remove`/delete function — local.js has no delete-sale capability at
 * all (grepped: no such function exists), only create and edit. Not
 * adding one here preserves that exactly.
 */
'use strict';

const { withConnection } = require('../database');

const SALE_SELECT = `
  SELECT s.id, s.tenant_id, s.invoice_no, s.customer_id, c.name AS customer_name,
         s.subtotal, s.discount, s.total, s.sale_date, s.note, s.created_by,
         s.created_at, s.updated_at,
         COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.source_type='sale' AND p.source_id=s.id), 0) AS paid
  FROM sales s JOIN customers c ON c.id = s.customer_id
`;

/** @param {number} tenantId @param {number} id @returns {Promise<object[]>} */
async function findItems(tenantId, saleId) {
  return withConnection((conn) =>
    conn.query(
      `SELECT si.id, si.product_id, si.product_name, si.price, si.qty
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.tenant_id = ? AND si.sale_id = ?`,
      [tenantId, saleId]
    )
  );
}

/** @param {number} tenantId @returns {Promise<object[]>} */
async function listByTenant(tenantId) {
  return withConnection((conn) =>
    conn.query(`${SALE_SELECT} WHERE s.tenant_id = ? ORDER BY s.sale_date DESC, s.id DESC`, [tenantId])
  );
}

/** @param {number} tenantId @param {number} id @returns {Promise<object|null>} */
async function findById(tenantId, id) {
  const sale = await withConnection(async (conn) => {
    const rows = await conn.query(`${SALE_SELECT} WHERE s.tenant_id = ? AND s.id = ?`, [tenantId, id]);
    return rows[0] || null;
  });
  if (!sale) return null;
  sale.items = await findItems(tenantId, id);
  return sale;
}

/**
 * Matches nextInvoiceNo's self-healing numbering (~line 3952): highest
 * numeric suffix among existing invoice_no values, tenant-scoped.
 * @param {number} tenantId @returns {Promise<number>} highest existing number, or 0
 */
async function maxInvoiceNumber(tenantId) {
  return withConnection(async (conn) => {
    const rows = await conn.query(
      `SELECT invoice_no FROM sales WHERE tenant_id = ? AND invoice_no REGEXP '^INV-[0-9]+$'`,
      [tenantId]
    );
    return rows.reduce((max, r) => {
      const n = parseInt(r.invoice_no.slice(4), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
  });
}

/** @param {number} tenantId @param {string} invoiceNo @returns {Promise<boolean>} */
async function invoiceNoExists(tenantId, invoiceNo) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT 1 FROM sales WHERE tenant_id = ? AND invoice_no = ?', [tenantId, invoiceNo]);
    return rows.length > 0;
  });
}

/**
 * @param {{tenantId:number,invoiceNo:string,customerId:number,subtotal:number,
 *   discount:number,total:number,saleDate:string,note?:string,createdBy?:number,
 *   items:Array<{productId:?number,productName:string,price:number,qty:number}>}} data
 * @returns {Promise<object>}
 */
async function create(data) {
  return withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const result = await conn.query(
        `INSERT INTO sales (tenant_id, invoice_no, customer_id, subtotal, discount, total, sale_date, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.tenantId, data.invoiceNo, data.customerId, data.subtotal, data.discount, data.total, data.saleDate, data.note || null, data.createdBy || null]
      );
      const saleId = Number(result.insertId);
      for (const item of data.items) {
        await conn.query(
          'INSERT INTO sale_items (sale_id, product_id, product_name, price, qty) VALUES (?, ?, ?, ?, ?)',
          [saleId, item.productId, item.productName, item.price, item.qty]
        );
      }
      await conn.commit();
      return saleId;
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  }).then((saleId) => findById(data.tenantId, saleId));
}

/**
 * Replaces the sale's items entirely (matches updateSale's `s.items=saleItems.map(...)`
 * full-replace semantics, ~line 10001) and updates the sale row's own fields.
 * @param {number} tenantId @param {number} id
 * @param {{customerId:number,subtotal:number,discount:number,total:number,saleDate:string,
 *   note?:string,items:Array<{productId:?number,productName:string,price:number,qty:number}>}} data
 */
async function update(tenantId, id, data) {
  await withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      await conn.query(
        `UPDATE sales SET customer_id=?, subtotal=?, discount=?, total=?, sale_date=?, note=?
         WHERE tenant_id=? AND id=?`,
        [data.customerId, data.subtotal, data.discount, data.total, data.saleDate, data.note || null, tenantId, id]
      );
      await conn.query('DELETE FROM sale_items WHERE sale_id = ?', [id]);
      for (const item of data.items) {
        await conn.query(
          'INSERT INTO sale_items (sale_id, product_id, product_name, price, qty) VALUES (?, ?, ?, ?, ?)',
          [id, item.productId, item.productName, item.price, item.qty]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  });
  return findById(tenantId, id);
}

module.exports = { listByTenant, findById, findItems, maxInvoiceNumber, invoiceNoExists, create, update };
