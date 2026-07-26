'use strict';

const platformAuthService = require('../services/platformAuthService');

function login(jwtSecret) {
  return async function (req, res, next) {
    try {
      const result = await platformAuthService.login({
        email: req.body.email, password: req.body.password, ip: req.ip, userAgent: req.headers['user-agent'],
      }, jwtSecret);
      res.json(result);
    } catch (e) { next(e); }
  };
}
async function me(req, res) {
  res.json({ user: req.platformUser });
}

module.exports = { login, me };
