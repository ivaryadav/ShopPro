/**
 * server/src/repositories/inventoryRepository.js
 *
 * Persistence only (ADR-0005). Matches app/ShopERP_Pro_v8.html's
 * DB.inventory item shape and stock-mutation semantics exactly (see
 * migrations/002_operations_domain.sql header for the full mapping).
 * Stock changes use atomic SQL (`stock = GREATEST(0, stock ± ?)`) instead
 * of read-then-write in JS — a real hardening against concurrent writes
 * local.js's single in-process array never had to worry about, while
 * preserving the exact same clamp-at-zero semantics.
 */
'use strict';

const { withConnection } = require('../database');

const BASE_SELECT = `
  SELECT id, tenant_id, name, category, sku, imei, cost_price, sell_price,
         stock, min_stock, unit, created_at, updated_at
  FROM inventory_items
`;

/** @param {number} tenantId @returns {Promise<object[]>} */
async function listByTenant(tenantId) {
  return withConnection((conn) =>
    conn.query(`${BASE_SELECT} WHERE tenant_id = ? ORDER BY name`, [tenantId])
  );
}

/** @param {number} tenantId @param {number} id @returns {Promise<object|null>} */
async function findById(tenantId, id) {
  return withConnection(async (conn) => {
    const rows = await conn.query(`${BASE_SELECT} WHERE tenant_id = ? AND id = ?`, [tenantId, id]);
    return rows[0] || null;
  });
}

/**
 * Matches saveProduct's duplicate-IMEI check (~line 9069): scoped per
 * tenant, excludes the current row when editing.
 * @param {number} tenantId @param {string} imei @param {number} [excludeId]
 * @returns {Promise<object|null>}
 */
async function findByImei(tenantId, imei, excludeId) {
  return withConnection(async (conn) => {
    const rows = excludeId
      ? await conn.query(
          'SELECT id, name FROM inventory_items WHERE tenant_id = ? AND imei = ? AND id != ?',
          [tenantId, imei, excludeId]
        )
      : await conn.query('SELECT id, name FROM inventory_items WHERE tenant_id = ? AND imei = ?', [tenantId, imei]);
    return rows[0] || null;
  });
}

/**
 * @param {{tenantId:number,name:string,category?:string,sku?:string,imei?:string,
 *   costPrice:number,sellPrice:number,stock:number,minStock:number,unit?:string}} data
 * @returns {Promise<object>}
 */
async function create(data) {
  return withConnection(async (conn) => {
    const result = await conn.query(
      `INSERT INTO inventory_items
        (tenant_id, name, category, sku, imei, cost_price, sell_price, stock, min_stock, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.tenantId, data.name, data.category || null, data.sku || null, data.imei || null,
        data.costPrice, data.sellPrice, data.stock, data.minStock, data.unit || 'pcs',
      ]
    );
    return findById(data.tenantId, Number(result.insertId));
  });
}

/**
 * @param {number} tenantId @param {number} id
 * @param {{name:string,category?:string,sku?:string,imei?:string,costPrice:number,
 *   sellPrice:number,stock:number,minStock:number}} data
 */
async function update(tenantId, id, data) {
  return withConnection(async (conn) => {
    await conn.query(
      `UPDATE inventory_items SET name=?, category=?, sku=?, imei=?, cost_price=?, sell_price=?,
        stock=?, min_stock=? WHERE tenant_id=? AND id=?`,
      [
        data.name, data.category || null, data.sku || null, data.imei || null,
        data.costPrice, data.sellPrice, data.stock, data.minStock, tenantId, id,
      ]
    );
    return findById(tenantId, id);
  });
}

/**
 * Atomic decrement, clamped at 0 — matches `p.stock=Math.max(0,p.stock-item.qty)`
 * (saveSale:10074, updateSale:9981, addJobPart:11297) exactly.
 * @param {number} tenantId @param {number} id @param {number} qty
 */
async function decrementStock(tenantId, id, qty) {
  return withConnection((conn) =>
    conn.query('UPDATE inventory_items SET stock = GREATEST(0, stock - ?) WHERE tenant_id=? AND id=?', [qty, tenantId, id])
  );
}

/**
 * Atomic increment — matches `prod.stock+=orig.qty`/`p.stock+=qty` restore
 * paths (updateSale:9976, deleteJob:10421, removeJobPart:11304) exactly.
 * @param {number} tenantId @param {number} id @param {number} qty
 */
async function incrementStock(tenantId, id, qty) {
  return withConnection((conn) =>
    conn.query('UPDATE inventory_items SET stock = stock + ? WHERE tenant_id=? AND id=?', [qty, tenantId, id])
  );
}

/**
 * Matches doAdjustStock's 'set' branch (`p.stock=Math.max(0,qty)`, ~line 9151).
 * @param {number} tenantId @param {number} id @param {number} stock
 */
async function setStock(tenantId, id, stock) {
  return withConnection((conn) =>
    conn.query('UPDATE inventory_items SET stock = GREATEST(0, ?) WHERE tenant_id=? AND id=?', [stock, tenantId, id])
  );
}

/**
 * Matches deleteProduct's unconditional hard delete (~line 9160) — see
 * migrations/002_operations_domain.sql header for why child FKs are
 * ON DELETE SET NULL rather than RESTRICT/CASCADE.
 * @param {number} tenantId @param {number} id
 */
async function remove(tenantId, id) {
  return withConnection((conn) =>
    conn.query('DELETE FROM inventory_items WHERE tenant_id=? AND id=?', [tenantId, id])
  );
}

module.exports = {
  listByTenant, findById, findByImei, create, update,
  decrementStock, incrementStock, setStock, remove,
};
