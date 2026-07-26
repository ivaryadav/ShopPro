'use strict';

const platformAuthService = require('../services/platformAuthService');
const mfaService = require('../services/mfaService');
const passwordService = require('../services/passwordService');

function login(jwtSecret) {
  return async function (req, res, next) {
    try {
      const result = await platformAuthService.login({
        email: req.body.email, password: req.body.password, ip: req.ip, userAgent: req.headers['user-agent'],
        trustedDeviceToken: req.body.trustedDeviceToken,
      }, jwtSecret);
      res.json(result);
    } catch (e) { next(e); }
  };
}
function mfaChallenge(jwtSecret) {
  return async function (req, res, next) {
    try {
      const result = await platformAuthService.challengeMfa({
        mfaToken: req.body.mfaToken, code: req.body.code, recoveryCode: req.body.recoveryCode,
        rememberDevice: !!req.body.rememberDevice, ip: req.ip, userAgent: req.headers['user-agent'],
      }, jwtSecret);
      res.json(result);
    } catch (e) { next(e); }
  };
}
async function me(req, res) {
  res.json({ user: req.platformUser });
}
async function mfaSetup(req, res, next) {
  try { res.json(await mfaService.beginSetup(req.platformUser.userId, req.platformUser.email)); } catch (e) { next(e); }
}
async function mfaVerify(req, res, next) {
  try { res.json(await mfaService.confirmSetup(req.platformUser.userId, req.body.code, { ip: req.ip })); } catch (e) { next(e); }
}
async function mfaDisable(req, res, next) {
  try { res.json(mfaService.disable(req.platformUser.userId, req.body.password, { ip: req.ip })); } catch (e) { next(e); }
}
async function mfaRegenerateRecoveryCodes(req, res, next) {
  try { res.json(mfaService.regenerateRecoveryCodes(req.platformUser.userId, req.body.password, { ip: req.ip })); } catch (e) { next(e); }
}
async function changePassword(req, res, next) {
  try { res.json(passwordService.changeOwnPassword(req.platformUser.userId, req.body.currentPassword, req.body.newPassword, { ip: req.ip })); } catch (e) { next(e); }
}

module.exports = { login, mfaChallenge, me, mfaSetup, mfaVerify, mfaDisable, mfaRegenerateRecoveryCodes, changePassword };
