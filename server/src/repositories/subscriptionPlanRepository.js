/**
 * server/src/repositories/subscriptionPlanRepository.js
 *
 * Persistence only (ADR-0005). Matches local.js's subscription_plans
 * table exactly (local.js:228-237, seeded 312-314).
 */
'use strict';

const { withConnection } = require('../database');

/** @param {string} code @returns {Promise<object|null>} active plan row, or null */
async function findActiveByCode(code) {
  return withConnection(async (conn) => {
    const rows = await conn.query('SELECT * FROM subscription_plans WHERE code = ? AND is_active = 1', [code]);
    return rows[0] || null;
  });
}

/** @returns {Promise<object[]>} every active plan, sort_order ascending */
async function listActive() {
  return withConnection((conn) =>
    conn.query('SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY sort_order')
  );
}

module.exports = { findActiveByCode, listActive };
