'use strict';

const securityService = require('../services/securityService');
const sessionRepository = require('../repositories/platformSessionRepository');
const trustedDeviceRepository = require('../repositories/platformTrustedDeviceRepository');
const policyRepository = require('../repositories/platformPasswordPolicyRepository');
const auditService = require('../services/auditService');
const { NotFoundError, ValidationError } = require('../errors');

function actor(req) { return { userId: req.platformUser.userId, ip: req.ip }; }

async function overview(req, res, next) { try { res.json(securityService.overview()); } catch (e) { next(e); } }
async function logs(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    res.json(securityService.securityLogs({ page, pageSize }));
  } catch (e) { next(e); }
}

// ── Sessions (admin-wide) ────────────────────────────────────────────────
async function listSessions(req, res, next) { try { res.json({ sessions: sessionRepository.listAllActive() }); } catch (e) { next(e); } }
async function revokeSession(req, res, next) {
  try {
    const ok = sessionRepository.revoke(req.params.sessionId);
    if (!ok) throw new NotFoundError('Session not found or already inactive');
    auditService.record({ platformUserId: req.platformUser.userId, action: 'SESSION_REVOKED', detail: req.params.sessionId, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
}
async function terminateAllSessions(req, res, next) {
  try {
    if (!req.body.reason) throw new ValidationError('reason is required to terminate every active session platform-wide');
    const revoked = sessionRepository.revokeAllActive();
    auditService.record({ platformUserId: req.platformUser.userId, action: 'ALL_SESSIONS_TERMINATED', detail: `${revoked} session(s) — ${req.body.reason}`, ip: req.ip });
    res.json({ ok: true, revoked });
  } catch (e) { next(e); }
}

// ── Trusted devices ───────────────────────────────────────────────────────
async function listAllTrustedDevices(req, res, next) { try { res.json({ devices: trustedDeviceRepository.listAll() }); } catch (e) { next(e); } }
async function myTrustedDevices(req, res, next) { try { res.json({ devices: trustedDeviceRepository.listForUser(req.platformUser.userId) }); } catch (e) { next(e); } }
async function revokeTrustedDevice(req, res, next) {
  try {
    const ok = trustedDeviceRepository.revoke(Number(req.params.id));
    if (!ok) throw new NotFoundError('Trusted device not found or already revoked');
    auditService.record({ platformUserId: req.platformUser.userId, action: 'TRUSTED_DEVICE_REVOKED', detail: `device #${req.params.id}`, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
}
async function revokeMyTrustedDevice(req, res, next) {
  try {
    const mine = trustedDeviceRepository.listForUser(req.platformUser.userId).find((d) => d.id === Number(req.params.id));
    if (!mine) throw new NotFoundError('Trusted device not found');
    trustedDeviceRepository.revoke(mine.id);
    auditService.record({ platformUserId: req.platformUser.userId, action: 'TRUSTED_DEVICE_REVOKED', detail: `self-service — ${mine.device_name}`, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

// ── Password policy ───────────────────────────────────────────────────────
async function getPasswordPolicy(req, res, next) { try { res.json({ policy: policyRepository.get() }); } catch (e) { next(e); } }
async function updatePasswordPolicy(req, res, next) {
  try {
    const updated = policyRepository.update(req.body);
    auditService.record({ platformUserId: req.platformUser.userId, action: 'PASSWORD_POLICY_UPDATED', ip: req.ip });
    res.json({ policy: updated });
  } catch (e) { next(e); }
}

module.exports = {
  overview, logs, listSessions, revokeSession, terminateAllSessions,
  listAllTrustedDevices, myTrustedDevices, revokeTrustedDevice, revokeMyTrustedDevice,
  getPasswordPolicy, updatePasswordPolicy,
};
