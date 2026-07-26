/**
 * platform/src/jobs/sessionCleanupJob.js — Phase 5C. Proactively revokes
 * sessions that have exceeded the current password policy's idle/absolute
 * timeout, complementing the LAZY check verifyToken() already does on
 * next use — without this sweep, an abandoned session's row stays
 * status='active' forever unless its token happens to be presented again.
 */
'use strict';

const policyRepository = require('../repositories/platformPasswordPolicyRepository');
const sessionRepository = require('../repositories/platformSessionRepository');

async function run() {
  const policy = policyRepository.get();
  const revoked = sessionRepository.sweepExpired(policy.session_idle_timeout_minutes, policy.session_absolute_timeout_hours);
  return { itemsProcessed: revoked };
}

module.exports = { run };
