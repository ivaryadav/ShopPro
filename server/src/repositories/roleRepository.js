/**
 * server/src/repositories/roleRepository.js
 *
 * Persistence only. See docs/adr/0006-table-driven-authorization.md for why
 * this table exists and what it's seeded with (exactly 'owner'/'staff' —
 * the hosted server's own role enum, not the desktop app's).
 */
'use strict';

const { withConnection } = require('../database');

/** @param {string} code @returns {Promise<{id: number, code: string, label: string}|null>} */
async function findByCode(code) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT * FROM roles WHERE code = ?', [code]);
    return rows[0] || null;
  });
}

/** @param {number} id @returns {Promise<object|null>} */
async function findById(id) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT * FROM roles WHERE id = ?', [id]);
    return rows[0] || null;
  });
}

module.exports = { findByCode, findById };
