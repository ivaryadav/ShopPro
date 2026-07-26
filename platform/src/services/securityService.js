/**
 * platform/src/services/securityService.js — Platform Security Center
 * (Phase 5B): a single overview of MFA adoption, failed logins, locked
 * accounts, active sessions, trusted devices, suspicious activity, recent
 * security events, password age, and a computed Security Score.
 *
 * The score is a simple, clearly-bounded v1 heuristic (documented inline),
 * not a certified security audit metric — it exists to give an operator
 * one directional number, not a compliance certification.
 */
'use strict';

const { getDb } = require('../database/connection');
const auditLogRepository = require('../repositories/platformAuditLogRepository');
const loginFailureRepository = require('../repositories/platformLoginFailureRepository');
const sessionRepository = require('../repositories/platformSessionRepository');
const trustedDeviceRepository = require('../repositories/platformTrustedDeviceRepository');
const policyRepository = require('../repositories/platformPasswordPolicyRepository');

const SECURITY_ACTION_PATTERN = /MFA_|PASSWORD|SESSION|ACCOUNT_LOCKED|API_KEY_|TRUSTED_DEVICE|RECOVERY_CODE/;

function computeScore({ totalUsers, mfaEnabledUsers, forcedMfaNonCompliant, lockedAccounts, oldPasswords }) {
  let score = 100;
  if (totalUsers > 0) score -= Math.round((1 - mfaEnabledUsers / totalUsers) * 30);
  score -= Math.min(forcedMfaNonCompliant * 10, 30);
  score -= Math.min(lockedAccounts * 5, 15);
  score -= Math.min(oldPasswords * 5, 15);
  return Math.max(0, Math.min(100, score));
}

function overview() {
  const db = getDb();
  const policy = policyRepository.get();

  const userStats = db.prepare('SELECT COUNT(*) total, SUM(totp_enabled) mfaEnabled FROM platform_users WHERE is_active = 1').get();
  const totalUsers = userStats.total || 0;
  const mfaEnabledUsers = userStats.mfaEnabled || 0;

  const forcedMfaNonCompliant = db.prepare(`
    SELECT COUNT(*) c FROM platform_users u JOIN platform_roles r ON r.id = u.role_id
    WHERE u.is_active = 1 AND u.totp_enabled = 0 AND r.mfa_required = 1
  `).get().c;

  const lockedAccounts = db.prepare("SELECT COUNT(*) c FROM platform_users WHERE locked_until IS NOT NULL AND locked_until > datetime('now')").get().c;
  const failedLoginsLast24h = db.prepare("SELECT COUNT(*) c FROM platform_login_failures WHERE created_at >= datetime('now','-1 day')").get().c;
  const activeSessions = db.prepare("SELECT COUNT(*) c FROM platform_sessions WHERE status = 'active'").get().c;
  const trustedDevices = trustedDeviceRepository.countActive();

  const oldPasswordsCount = policy.max_age_days
    ? db.prepare("SELECT COUNT(*) c FROM platform_users WHERE is_active = 1 AND password_changed_at < datetime('now', ?)").get(`-${policy.max_age_days} days`).c
    : 0;

  const suspicious = db.prepare(`
    SELECT email, COUNT(*) attempts FROM platform_login_failures
    WHERE created_at >= datetime('now','-1 day') GROUP BY email HAVING attempts >= 3 ORDER BY attempts DESC
  `).all();

  const { rows: recentAudit } = auditLogRepository.list({ page: 1, pageSize: 100 });
  const recentSecurityEvents = recentAudit
    .filter((r) => SECURITY_ACTION_PATTERN.test(r.action))
    .slice(0, 20)
    .map((r) => ({ timestamp: r.created_at, admin: r.admin_email || 'system', action: r.action, detail: r.detail }));

  const score = computeScore({ totalUsers, mfaEnabledUsers, forcedMfaNonCompliant, lockedAccounts, oldPasswords: oldPasswordsCount });

  return {
    mfaStatus: { totalUsers, mfaEnabledUsers, adoptionRate: totalUsers ? Math.round((mfaEnabledUsers / totalUsers) * 100) : 0, forcedMfaNonCompliant },
    failedLoginAttemptsLast24h: failedLoginsLast24h,
    lockedAccounts,
    activeSessions,
    trustedDevices,
    suspiciousLoginActivity: suspicious.map((s) => ({ email: s.email, attemptsLast24h: s.attempts })),
    recentSecurityEvents,
    passwordAge: { oldPasswordsCount, maxAgeDays: policy.max_age_days || null },
    securityScore: score,
  };
}

/** Security Logs — every security-relevant audit action, merged with raw login failures (a distinct table, not duplicated into audit_logs). */
function securityLogs({ page, pageSize }) {
  const db = getDb();
  const { rows } = auditLogRepository.list({ page: 1, pageSize: 500 });
  const auditEvents = rows.filter((r) => SECURITY_ACTION_PATTERN.test(r.action))
    .map((r) => ({ type: 'audit', timestamp: r.created_at, actor: r.admin_email || 'system', action: r.action, detail: r.detail }));
  const failures = db.prepare('SELECT * FROM platform_login_failures ORDER BY created_at DESC LIMIT 500').all()
    .map((f) => ({ type: 'login_failure', timestamp: f.created_at, actor: f.email, action: 'LOGIN_FAILURE', detail: `from ${f.ip || 'unknown IP'}` }));
  const merged = [...auditEvents, ...failures].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const start = (page - 1) * pageSize;
  return { entries: merged.slice(start, start + pageSize), total: merged.length };
}

module.exports = { overview, securityLogs };
