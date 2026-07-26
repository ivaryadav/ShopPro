/**
 * platform/src/services/alertService.js — Alerts & Notifications Center (Phase 5A).
 *
 * Alerts are computed LIVE from current data on every request (expiring
 * licenses, pending registrations, locked platform accounts) rather than
 * pre-materialized by a background job — scheduled job infrastructure is
 * an explicit later milestone. Only read/dismiss state is persisted
 * (platform_alert_state), keyed by a stable alert_key so it survives
 * recomputation. This is a deliberate v1 simplification: state is global
 * to the platform, not per-operator — worth knowing, not hidden.
 */
'use strict';

const { getDb } = require('../database/connection');
const alertStateRepository = require('../repositories/platformAlertStateRepository');
const { listConfiguredAdapters } = require('../adapters');

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

async function computeAlerts() {
  const db = getDb();
  const alerts = [];

  // Local licenses: expired-into-grace (READ_ONLY) is critical; expiring within 7 days is a warning.
  const localLicenses = db.prepare(`
    SELECT l.organization_id, l.product_id, l.status, l.expires_at, o.business_name, p.name AS product_name
    FROM platform_licenses l
    JOIN organizations o ON o.id = l.organization_id
    JOIN platform_products p ON p.id = l.product_id
    WHERE l.status IN ('ACTIVE','READ_ONLY') AND l.expires_at IS NOT NULL
  `).all();
  for (const l of localLicenses) {
    const days = Math.ceil((new Date(l.expires_at).getTime() - Date.now()) / 86400000);
    if (l.status === 'READ_ONLY') {
      alerts.push({
        key: `license-readonly:${l.organization_id}:${l.product_id}`, type: 'license', severity: 'critical',
        title: `${l.business_name} — license expired`, message: `${l.product_name} license entered its grace period on ${l.expires_at}.`,
        organizationId: String(l.organization_id), createdAt: l.expires_at,
      });
    } else if (days <= 7) {
      alerts.push({
        key: `license-expiring:${l.organization_id}:${l.product_id}`, type: 'license', severity: 'warning',
        title: `${l.business_name} — license expiring soon`, message: `${l.product_name} license expires in ${Math.max(days, 0)} day(s).`,
        organizationId: String(l.organization_id), createdAt: new Date().toISOString(),
      });
    }
  }

  // Local pending registrations.
  const pendingOrgs = db.prepare("SELECT id, business_name, created_at FROM organizations WHERE status = 'PENDING_APPROVAL'").all();
  for (const o of pendingOrgs) {
    alerts.push({
      key: `registration-pending:${o.id}`, type: 'registration', severity: 'info',
      title: `${o.business_name} — awaiting approval`, message: 'New registration is pending review.',
      organizationId: String(o.id), createdAt: o.created_at,
    });
  }

  // Locked platform (operator) accounts.
  const locked = db.prepare("SELECT id, email, locked_until FROM platform_users WHERE locked_until IS NOT NULL AND locked_until > datetime('now')").all();
  for (const u of locked) {
    alerts.push({
      key: `account-locked:${u.id}`, type: 'security', severity: 'warning',
      title: 'Platform account locked', message: `${u.email} is locked until ${u.locked_until}.`,
      organizationId: null, createdAt: new Date().toISOString(),
    });
  }

  // Adapter-backed products — aggregate-level alerts (one per product, not
  // per-tenant) to avoid an N+1 call per organization; per-tenant granular
  // alerting is a natural extension once scheduled jobs exist.
  for (const { slug, adapter } of listConfiguredAdapters()) {
    const d = await adapter.getDashboardStats();
    if (d.pendingRegistrations > 0) {
      alerts.push({
        key: `registration-pending:${slug}`, type: 'registration', severity: 'info',
        title: `${slug} — registrations awaiting approval`, message: `${d.pendingRegistrations} registration(s) pending review.`,
        organizationId: null, createdAt: new Date().toISOString(),
      });
    }
    if (d.expiringWithin30Days > 0) {
      alerts.push({
        key: `license-expiring:${slug}`, type: 'license', severity: 'warning',
        title: `${slug} — licenses expiring soon`, message: `${d.expiringWithin30Days} license(s) expiring within 30 days.`,
        organizationId: null, createdAt: new Date().toISOString(),
      });
    }
  }

  const states = alertStateRepository.allStates();
  return alerts.map((a) => {
    const state = states.get(a.key);
    return { ...a, readAt: (state && state.read_at) || null, dismissedAt: (state && state.dismissed_at) || null };
  });
}

async function listAlerts({ includeDismissed } = {}) {
  const all = await computeAlerts();
  const visible = includeDismissed ? all : all.filter((a) => !a.dismissedAt);
  visible.sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  return { alerts: visible, unreadCount: visible.filter((a) => !a.readAt).length };
}

function markRead(alertKey) { alertStateRepository.markRead(alertKey); return { ok: true }; }
function markDismissed(alertKey) { alertStateRepository.markDismissed(alertKey); return { ok: true }; }

module.exports = { listAlerts, markRead, markDismissed };
