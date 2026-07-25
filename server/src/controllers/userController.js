/**
 * server/src/controllers/userController.js
 *
 * Request/response only (ADR-0005). Matches local.js's
 * POST /api/auth/add-staff and GET /api/data/users exactly. Owner-only
 * enforcement for addStaff is applied by requirePermission('staff:add')
 * at the route level, not here.
 */
'use strict';

const userService = require('../services/userService');

/** @type {import('express').RequestHandler} */
async function addStaff(req, res, next) {
  try {
    const { displayName, mobile, pin, role } = req.body || {};
    const user = await userService.addStaff({ tenantId: req.user.tenantId, displayName, mobile, pin, role });
    res.status(201).json({ message: 'Staff added', user });
  } catch (e) {
    next(e);
  }
}

/** @type {import('express').RequestHandler} */
async function listUsers(req, res, next) {
  try {
    const users = await userService.listUsers(req.user.tenantId);
    res.json({ users });
  } catch (e) {
    next(e);
  }
}

module.exports = { addStaff, listUsers };
