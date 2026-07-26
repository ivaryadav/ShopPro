/**
 * server/maintenanceGate.js — Phase 5D enforcement. Resolves the
 * effective maintenance policy from the LOCAL cache only (maintenance_cache,
 * kept fresh by maintenanceSync.js) — never a live call to Z-SUPERADMIN on
 * the request path, which is exactly what "products enforce their locally
 * synced copy" requires.
 *
 * Resolution precedence mirrors platform/src/services/maintenanceService.js
 * exactly (organization > product > platform, but an emergency-mode window
 * at ANY scope wins outright) — duplicated here deliberately rather than
 * trusting one pre-resolved verdict from the sync payload, so ShopERP can
 * always determine the right answer from its own cached raw ingredients
 * even if a future payload shape changes what's considered "current."
 */
'use strict';

const SPECIFICITY = { organization: 0, product: 1, platform: 2 };

function getCachedPayload(db) {
  const row = db.prepare('SELECT payload FROM maintenance_cache WHERE id = 1').get();
  if (!row || !row.payload) return null;
  try { return JSON.parse(row.payload); } catch (e) { return null; }
}

function resolveForTenant(payload, tenantId) {
  if (!payload) return { active: null, upcoming: null };
  const org = payload.organizations && payload.organizations[String(tenantId)];
  const candidates = [org, payload.product, payload.platform].filter(Boolean);
  const emergencyOnes = candidates.filter((c) => c.mode === 'emergency');
  const pool = emergencyOnes.length ? emergencyOnes : candidates;
  pool.sort((a, b) => SPECIFICITY[a.scopeType] - SPECIFICITY[b.scopeType]);
  const upcoming = (payload.upcoming && (payload.upcoming.product || payload.upcoming.platform)) || null;
  return { active: pool[0] || null, upcoming };
}

function isAllowlisted(effective, { mobile, email, tenantScopeRef }) {
  if (!effective) return false;
  const users = effective.allowlistUsers || [];
  if ((mobile && users.includes(mobile)) || (email && users.includes(email))) return true;
  const orgs = effective.allowlistOrganizations || [];
  return !!(tenantScopeRef && orgs.includes(tenantScopeRef));
}

/** Seconds until endsAt, computed entirely in SQLite — never a JS Date parse of a value that may have crossed a sync boundary. */
function retryAfterSeconds(db, endsAt) {
  if (!endsAt) return null;
  const row = db.prepare("SELECT CAST((julianday(?) - julianday('now')) * 86400 AS INTEGER) AS s").get(endsAt);
  return row && row.s > 0 ? row.s : null;
}

/** The one function both the Express gates and the login handler call — same policy, same allowlist logic, evaluated once. */
function checkMaintenance(db, { tenantId, userId }) {
  const payload = getCachedPayload(db);
  const { active, upcoming } = resolveForTenant(payload, tenantId);
  const tenantScopeRef = 'shoperp:' + tenantId;
  if (!active) return { blocked: false, readOnly: false, active: null, upcoming };
  let mobile = null, email = null;
  if (userId) {
    const u = db.prepare('SELECT mobile, email FROM users WHERE id = ?').get(userId);
    if (u) { mobile = u.mobile; email = u.email; }
  }
  if (isAllowlisted(active, { mobile, email, tenantScopeRef })) {
    return { blocked: false, readOnly: false, bypassed: true, active, upcoming };
  }
  return {
    blocked: active.accessLevel === 'locked',
    readOnly: active.accessLevel === 'read_only',
    active, upcoming,
  };
}

function respondBlocked(res, db, result) {
  const retryAfter = result.active.endsAt ? retryAfterSeconds(db, result.active.endsAt) : null;
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  return res.status(503).json({
    error: result.active.message || 'This service is temporarily down for maintenance.',
    maintenanceActive: true,
    accessLevel: result.active.accessLevel,
    message: result.active.message,
    eta: result.active.eta,
    endsAt: result.active.endsAt,
    retryAfterSeconds: retryAfter,
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {{ gateRead: Function, gateWrite: Function, checkForLogin: Function }}
 */
function createGates(db) {
  function gateRead(req, res, next) {
    const result = checkMaintenance(db, { tenantId: req.user.tenantId, userId: req.user.userId });
    if (result.blocked) return respondBlocked(res, db, result);
    next(); // read-only mode still permits reads
  }
  function gateWrite(req, res, next) {
    const result = checkMaintenance(db, { tenantId: req.user.tenantId, userId: req.user.userId });
    if (result.blocked || result.readOnly) return respondBlocked(res, db, result);
    next();
  }
  /** Login has no req.user yet — called inline by the login handler once the tenant is resolved (by mobile), before a session is created. */
  function checkForLogin(tenantId, userId) {
    return checkMaintenance(db, { tenantId, userId });
  }
  return { gateRead, gateWrite, checkForLogin };
}

module.exports = { createGates, checkMaintenance, resolveForTenant, retryAfterSeconds };
