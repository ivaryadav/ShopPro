'use strict';

const organizationService = require('../services/organizationService');

function actor(req) { return { userId: req.platformUser.userId, email: req.platformUser.email, ip: req.ip }; }

async function list(req, res, next) { try { res.json(await organizationService.listOrganizations(req.query)); } catch (e) { next(e); } }
async function create(req, res, next) { try { res.status(201).json({ organization: organizationService.createOrganization(req.body, actor(req)) }); } catch (e) { next(e); } }
async function getOne(req, res, next) { try { res.json(await organizationService.getOrganization(req.params.id)); } catch (e) { next(e); } }
async function attachProduct(req, res, next) { try { res.json(await organizationService.attachProduct(req.params.id, req.body.productSlug, actor(req))); } catch (e) { next(e); } }

// ── Support Center actions ───────────────────────────────────────────────
async function approve(req, res, next) { try { res.json(await organizationService.approve(req.params.id, actor(req))); } catch (e) { next(e); } }
async function suspend(req, res, next) { try { res.json(await organizationService.suspend(req.params.id, req.body.reason, actor(req))); } catch (e) { next(e); } }
async function deviceList(req, res, next) { try { res.json({ devices: await organizationService.listDevices(req.params.id) }); } catch (e) { next(e); } }
async function deviceRevoke(req, res, next) { try { res.json(await organizationService.revokeDevice(req.params.id, req.params.deviceId, actor(req))); } catch (e) { next(e); } }
async function deviceRename(req, res, next) { try { res.json(await organizationService.renameDevice(req.params.id, req.params.deviceId, req.body.deviceName, actor(req))); } catch (e) { next(e); } }
async function sendEmail(req, res, next) {
  try { res.json(await organizationService.sendEmail(req.params.id, req.body.type, req.body, actor(req))); } catch (e) { next(e); }
}

// ── Security / support actions (adapter-backed organizations only) ───────
async function unlockAccount(req, res, next) { try { res.json(await organizationService.unlockAccount(req.params.id, actor(req))); } catch (e) { next(e); } }
async function forcePasswordReset(req, res, next) { try { res.json(await organizationService.forcePasswordReset(req.params.id, actor(req))); } catch (e) { next(e); } }
async function killSessions(req, res, next) { try { res.json(await organizationService.killSessions(req.params.id, actor(req))); } catch (e) { next(e); } }
async function loginHistory(req, res, next) { try { res.json({ logins: await organizationService.getLoginHistory(req.params.id) }); } catch (e) { next(e); } }
async function failedLogins(req, res, next) { try { res.json({ failedLogins: await organizationService.getFailedLogins(req.params.id) }); } catch (e) { next(e); } }

// ── Organization 360 Workspace (Phase 5A) ────────────────────────────────
async function notesList(req, res, next) { try { res.json({ notes: organizationService.listNotes(req.params.id) }); } catch (e) { next(e); } }
async function notesAdd(req, res, next) { try { res.status(201).json({ note: organizationService.addNote(req.params.id, req.body.note, actor(req)) }); } catch (e) { next(e); } }
async function renewals(req, res, next) { try { res.json(await organizationService.getRenewals(req.params.id)); } catch (e) { next(e); } }
async function security(req, res, next) { try { res.json(await organizationService.getSecurity(req.params.id)); } catch (e) { next(e); } }
async function activity(req, res, next) { try { res.json(await organizationService.getActivityTimeline(req.params.id)); } catch (e) { next(e); } }

// ── Organization 360 Expansion (Phase 5E) ────────────────────────────────
async function subscription(req, res, next) { try { res.json(await organizationService.getSubscription(req.params.id, req.query.productId ? Number(req.query.productId) : undefined)); } catch (e) { next(e); } }
async function usage(req, res, next) { try { res.json(await organizationService.getUsage(req.params.id)); } catch (e) { next(e); } }
async function billing(req, res, next) { try { res.json(organizationService.getBilling(req.params.id)); } catch (e) { next(e); } }
async function licenseHistory(req, res, next) { try { res.json({ history: await organizationService.getLicenseHistory(req.params.id) }); } catch (e) { next(e); } }
async function renewalHistory(req, res, next) { try { res.json({ history: await organizationService.getRenewalHistory(req.params.id) }); } catch (e) { next(e); } }

module.exports = {
  list, create, getOne, attachProduct, approve, suspend, deviceList, deviceRevoke, deviceRename, sendEmail,
  unlockAccount, forcePasswordReset, killSessions, loginHistory, failedLogins,
  notesList, notesAdd, renewals, security, activity,
  subscription, usage, billing, licenseHistory, renewalHistory,
};
