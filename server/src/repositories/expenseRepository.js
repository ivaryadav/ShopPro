/**
 * server/src/repositories/expenseRepository.js
 *
 * Persistence only (ADR-0005). Matches saveExpense/deleteExpense
 * (~line 12571/12582) exactly — no paidTo/payment_mode (confirmed dead
 * demo-only fields, DomainModel.md).
 */
'use strict';

const { withConnection } = require('../database');

const BASE_SELECT = 'SELECT id, tenant_id, title, category, amount, expense_date, note, created_at FROM expenses';

/** @param {number} tenantId @returns {Promise<object[]>} */
async function listByTenant(tenantId) {
  return withConnection((conn) =>
    conn.query(`${BASE_SELECT} WHERE tenant_id = ? ORDER BY expense_date DESC, id DESC`, [tenantId])
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
 * @param {{tenantId:number,title:string,category?:string,amount:number,expenseDate:string,note?:string}} data
 * @returns {Promise<object>}
 */
async function create(data) {
  return withConnection(async (conn) => {
    const result = await conn.query(
      'INSERT INTO expenses (tenant_id, title, category, amount, expense_date, note) VALUES (?, ?, ?, ?, ?, ?)',
      [data.tenantId, data.title, data.category || 'Other', data.amount, data.expenseDate, data.note || null]
    );
    return findById(data.tenantId, Number(result.insertId));
  });
}

/** Matches deleteExpense's unconditional hard delete (~line 12586). @param {number} tenantId @param {number} id */
async function remove(tenantId, id) {
  return withConnection((conn) => conn.query('DELETE FROM expenses WHERE tenant_id=? AND id=?', [tenantId, id]));
}

module.exports = { listByTenant, findById, create, remove };
