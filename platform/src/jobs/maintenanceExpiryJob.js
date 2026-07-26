/**
 * platform/src/jobs/maintenanceExpiryJob.js — Phase 5D. Active windows
 * whose end time has passed transition to 'expired', so products'
 * next sync correctly stops enforcing them without any operator action.
 */
'use strict';

const windowRepository = require('../repositories/platformMaintenanceWindowRepository');
const historyRepository = require('../repositories/platformMaintenanceHistoryRepository');

async function run() {
  const expired = windowRepository.listActiveExpired();
  for (const w of expired) {
    windowRepository.setStatus(w.id, 'expired');
    historyRepository.record({ windowId: w.id, action: 'EXPIRED', detail: 'window reached its end time', actor: 'system' });
  }
  return { itemsProcessed: expired.length };
}

module.exports = { run };
