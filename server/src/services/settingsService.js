/**
 * server/src/services/settingsService.js
 *
 * Configuration stays JSON per ADR-0008 — no column-level business rules
 * to enforce here (DB.settings is an unstructured, tenant-editable blob
 * today; this phase does not add validation local.js never had, since
 * doing so would be inventing a schema for Configuration, the exact
 * thing ADR-0008 decided not to do).
 */
'use strict';

const settingsRepository = require('../repositories/settingsRepository');

async function getSettings(tenantId) {
  return settingsRepository.get(tenantId);
}

/** Matches PUT /api/data's whole-object-replace semantics for DB.settings. */
async function putSettings(tenantId, settings) {
  return settingsRepository.put(tenantId, settings);
}

module.exports = { getSettings, putSettings };
