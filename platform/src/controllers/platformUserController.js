/**
 * platform/src/controllers/platformUserController.js — Platform Users
 * module + the Support-Center-style actions applied to PLATFORM operators
 * themselves (reset password / unlock / force-logout / login history).
 * Deliberately NOT reaching into any product's own end-customer accounts
 * (a ShopERP shop's PIN, a ZLAB technician's login, etc.) — that would be
 * product-specific business logic inside Z-SUPERADMIN, which Non-Negotiable
 * Principle #2 forbids. Those actions live in organizationController
 * instead, scoped to what the platform actually owns (organizations,
 * products, licenses).
 */
'use strict';

const bcrypt = require('bcryptjs');
const platformAuthService = require('../services/platformAuthService');
const userRepository = require('../repositories/platformUserRepository');
const sessionRepository = require('../repositories/platformSessionRepository');
const loginFailureRepository = require('../repositories/platformLoginFailureRepository');
const auditService = require('../services/auditService');
const { NotFoundError, ValidationError } = require('../errors');

async function list(req, res, next) {
  try { res.json({ users: userRepository.listAll() }); } catch (e) { next(e); }
}
async function create(req, res, next) {
  try {
    const user = await platformAuthService.createUser(req.body);
    auditService.record({ platformUserId: req.platformUser.userId, action: 'PLATFORM_USER_CREATED', detail: user.email, ip: req.ip });
    res.status(201).json({ user: { id: user.id, email: user.email, displayName: user.display_name, roleCode: user.role_code } });
  } catch (e) { next(e); }
}
async function resetPassword(req, res, next) {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) throw new ValidationError('newPassword must be at least 8 characters');
    const user = userRepository.findById(Number(req.params.id));
    if (!user) throw new NotFoundError('Platform user not found');
    userRepository.updatePassword(user.id, bcrypt.hashSync(newPassword, 10));
    auditService.record({ platformUserId: req.platformUser.userId, action: 'PLATFORM_USER_PASSWORD_RESET', detail: user.email, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
}
async function unlock(req, res, next) {
  try {
    const user = userRepository.findById(Number(req.params.id));
    if (!user) throw new NotFoundError('Platform user not found');
    userRepository.clearLock(user.id);
    auditService.record({ platformUserId: req.platformUser.userId, action: 'PLATFORM_USER_UNLOCKED', detail: user.email, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
}
async function forceLogout(req, res, next) {
  try {
    const user = userRepository.findById(Number(req.params.id));
    if (!user) throw new NotFoundError('Platform user not found');
    const revoked = sessionRepository.revokeAllForUser(user.id);
    auditService.record({ platformUserId: req.platformUser.userId, action: 'PLATFORM_USER_FORCE_LOGOUT', detail: `${revoked} session(s) revoked for ${user.email}`, ip: req.ip });
    res.json({ ok: true, revoked });
  } catch (e) { next(e); }
}
async function loginHistory(req, res, next) {
  try {
    const user = userRepository.findById(Number(req.params.id));
    if (!user) throw new NotFoundError('Platform user not found');
    res.json({ sessions: sessionRepository.listForUser(user.id), failedLogins: loginFailureRepository.listForUser(user.id) });
  } catch (e) { next(e); }
}

module.exports = { list, create, resetPassword, unlock, forceLogout, loginHistory };
