/**
 * server/src/repositories/recurringExpenseRepository.js
 *
 * Persistence only (ADR-0005). Matches DB.recurringExpenses' shape
 * exactly (pageRecurring ~line 12311). `last_applied` is only ever
 * written by applyForMonth — no scheduler writes it automatically
 * (explicitly out of scope for this phase).
 */
'use strict';

const { withConnection } = require('../database');

const BASE_SELECT = `
  SELECT id, tenant_id, title, category, amount, note, is_active, last_applied, created_at
  FROM recurring_expenses
`;

/** @param {number} tenantId @returns {Promise<object[]>} */
async function listByTenant(tenantId) {
  return withConnection((conn) => conn.query(`${BASE_SELECT} WHERE tenant_id = ? ORDER BY title`, [tenantId]));
}

/** @param {number} tenantId @param {number} id @returns {Promise<object|null>} */
async function findById(tenantId, id) {
  return withConnection(async (conn) => {
    const rows = await conn.query(`${BASE_SELECT} WHERE tenant_id = ? AND id = ?`, [tenantId, id]);
    return rows[0] || null;
  });
}

/** @param {{tenantId:number,title:string,category?:string,amount:number,note?:string}} data @returns {Promise<object>} */
async function create(data) {
  return withConnection(async (conn) => {
    const result = await conn.query(
      'INSERT INTO recurring_expenses (tenant_id, title, category, amount, note) VALUES (?, ?, ?, ?, ?)',
      [data.tenantId, data.title, data.category || 'Other', data.amount, data.note || null]
    );
    return findById(data.tenantId, Number(result.insertId));
  });
}

/** @param {number} tenantId @param {number} id @param {{title:string,category?:string,amount:number,note?:string}} data */
async function update(tenantId, id, data) {
  return withConnection(async (conn) => {
    await conn.query(
      'UPDATE recurring_expenses SET title=?, category=?, amount=?, note=? WHERE tenant_id=? AND id=?',
      [data.title, data.category || 'Other', data.amount, data.note || null, tenantId, id]
    );
    return findById(tenantId, id);
  });
}

/** Matches toggleRecurring (pageRecurring's ON/OFF switch). @param {number} tenantId @param {number} id @param {boolean} active */
async function setActive(tenantId, id, active) {
  return withConnection((conn) =>
    conn.query('UPDATE recurring_expenses SET is_active=? WHERE tenant_id=? AND id=?', [active ? 1 : 0, tenantId, id])
  );
}

/** Matches applyRecurringExpenses' `re.lastApplied=thisMonth` (~line 12306). @param {number} tenantId @param {number} id @param {string} yyyymm */
async function setLastApplied(tenantId, id, yyyymm) {
  return withConnection((conn) =>
    conn.query('UPDATE recurring_expenses SET last_applied=? WHERE tenant_id=? AND id=?', [yyyymm, tenantId, id])
  );
}

/** @param {number} tenantId @param {number} id */
async function remove(tenantId, id) {
  return withConnection((conn) => conn.query('DELETE FROM recurring_expenses WHERE tenant_id=? AND id=?', [tenantId, id]));
}

module.exports = { listByTenant, findById, create, update, setActive, setLastApplied, remove };
