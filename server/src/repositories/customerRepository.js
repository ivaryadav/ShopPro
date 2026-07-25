/**
 * server/src/repositories/customerRepository.js
 *
 * Persistence only (ADR-0005). Matches app/ShopERP_Pro_v8.html's
 * DB.customers item shape exactly — no balance/loyalty_points/
 * total_purchase (confirmed dead fields, DomainModel.md).
 */
'use strict';

const { withConnection } = require('../database');

const BASE_SELECT = `
  SELECT id, tenant_id, name, phone, email, address, type, note, created_at
  FROM customers
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
 * Matches isPhoneDuplicate (~line 11388): compares digit-only phone,
 * scoped per tenant, excludes the current row when editing.
 * @param {number} tenantId @param {string} phone @param {number} [excludeId]
 * @returns {Promise<object|null>}
 */
async function findByPhone(tenantId, phone, excludeId) {
  return withConnection(async (conn) => {
    const rows = excludeId
      ? await conn.query(
          'SELECT id, name FROM customers WHERE tenant_id = ? AND phone = ? AND id != ?',
          [tenantId, phone, excludeId]
        )
      : await conn.query('SELECT id, name FROM customers WHERE tenant_id = ? AND phone = ?', [tenantId, phone]);
    return rows[0] || null;
  });
}

/**
 * @param {{tenantId:number,name:string,phone:string,email?:string,address?:string,
 *   type?:string,note?:string}} data
 * @returns {Promise<object>}
 */
async function create(data) {
  return withConnection(async (conn) => {
    const result = await conn.query(
      'INSERT INTO customers (tenant_id, name, phone, email, address, type, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [data.tenantId, data.name, data.phone, data.email || null, data.address || null, data.type || 'Regular', data.note || null]
    );
    return findById(data.tenantId, Number(result.insertId));
  });
}

/**
 * @param {number} tenantId @param {number} id
 * @param {{name:string,phone:string,email?:string,address?:string,type?:string,note?:string}} data
 */
async function update(tenantId, id, data) {
  return withConnection(async (conn) => {
    await conn.query(
      'UPDATE customers SET name=?, phone=?, email=?, address=?, type=?, note=? WHERE tenant_id=? AND id=?',
      [data.name, data.phone, data.email || null, data.address || null, data.type || 'Regular', data.note || null, tenantId, id]
    );
    return findById(tenantId, id);
  });
}

module.exports = { listByTenant, findById, findByPhone, create, update };
