/**
 * server/src/controllers/cloudBackupController.js — request/response
 * only (ADR-0005). Matches local.js:1753-1784 exactly.
 */
'use strict';

const cloudBackupService = require('../services/cloudBackupService');

/** @type {import('express').RequestHandler} */
async function createOrUpdate(req, res, next) {
  try {
    await cloudBackupService.createOrUpdateBackup(req.body || {});
    res.json({ ok: true });
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function restore(req, res, next) {
  try {
    const result = await cloudBackupService.restoreBackup(req.params.keyHash);
    res.json(result);
  } catch (e) { next(e); }
}

/** @type {import('express').RequestHandler} */
async function remove(req, res, next) {
  try {
    await cloudBackupService.deleteBackup(req.params.keyHash);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { createOrUpdate, restore, remove };
