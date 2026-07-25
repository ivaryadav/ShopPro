/**
 * server/src/controllers/authController.js
 *
 * Request/response only (ADR-0005) — every business decision happens in
 * services/authService.js and services/sessionService.js. Response shapes
 * match server/local.js's exactly, field-for-field.
 */
'use strict';

const authService = require('../services/authService');
const sessionService = require('../services/sessionService');
const { ValidationError, AuthenticationError } = require('../errors');

/** @param {string} jwtSecret @returns {import('express').RequestHandler} */
function login(jwtSecret) {
  return async function (req, res, next) {
    try {
      const result = await authService.login(req.body || {}, req, jwtSecret);
      res.json(result);
    } catch (e) {
      next(e);
    }
  };
}

/** @param {string} jwtSecret @returns {import('express').RequestHandler} */
function refresh(jwtSecret) {
  return async function (req, res, next) {
    try {
      const { refreshToken } = req.body || {};
      if (!refreshToken) throw new ValidationError('refreshToken required');
      const result = await sessionService.refreshSession(jwtSecret, refreshToken);
      if (!result.ok) {
        throw new AuthenticationError('Refresh token is invalid or has been revoked. Please log in again.');
      }
      res.json({ token: result.accessToken, refreshToken: result.refreshToken });
    } catch (e) {
      next(e);
    }
  };
}

/** @type {import('express').RequestHandler} */
async function logout(req, res, next) {
  try {
    if (req.user.sid) await sessionService.revoke(req.user.sid);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

/** @type {import('express').RequestHandler} */
async function heartbeat(req, res, next) {
  try {
    if (!req.user.sid) return res.json({ ok: true, legacy: true });
    await sessionService.heartbeat(req.user.sid, (req.body && req.body.currentPage) || null);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
}

module.exports = { login, refresh, logout, heartbeat };
