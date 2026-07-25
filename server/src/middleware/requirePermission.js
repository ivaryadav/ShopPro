/**
 * server/src/middleware/requirePermission.js
 *
 * Generic authorization gate, replacing local.js's ad hoc
 * `if (req.user.role !== 'owner') return res.status(403)...` checks with a
 * table-driven lookup (docs/adr/0006-table-driven-authorization.md).
 * Seeded so every existing gate's outcome is unchanged — see the
 * migration's seed data and authorization.test.js for the equivalence proof.
 */
'use strict';

const authorizationService = require('../services/authorizationService');
const { AuthorizationError } = require('../errors');

/**
 * @param {string} permissionCode
 * @param {string} [deniedMessage] - matches local.js's exact per-endpoint message when provided
 * @returns {import('express').RequestHandler}
 */
function requirePermission(permissionCode, deniedMessage) {
  return async function (req, res, next) {
    try {
      const allowed = await authorizationService.hasPermission(req.user.role, permissionCode);
      if (!allowed) {
        return next(new AuthorizationError(deniedMessage || 'You are not authorized to perform this action.'));
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { requirePermission };
