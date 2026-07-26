/**
 * platform/src/jobs/loginFailureRetentionJob.js — Phase 5C. Purges failed
 * login/MFA-challenge records older than a fixed retention window (90
 * days) — this table logs every failed attempt (see platformAuthService's
 * lockout logic) and would otherwise grow forever.
 */
'use strict';

const loginFailureRepository = require('../repositories/platformLoginFailureRepository');

const RETENTION_DAYS = 90;

async function run() {
  const deleted = loginFailureRepository.purgeOlderThan(RETENTION_DAYS);
  return { itemsProcessed: deleted };
}

module.exports = { run };
