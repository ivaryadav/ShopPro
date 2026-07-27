/**
 * platform/src/jobs/maintenancePublishJob.js — Phase 5D. Scheduled
 * windows whose start time has arrived transition to 'active', becoming
 * visible to products via GET /maintenance/effective on their next poll.
 * Immediate/emergency-mode windows never appear here — they're already
 * 'active' the moment they're created (see maintenanceService.createPolicy).
 */
'use strict';

const windowRepository = require('../repositories/platformMaintenanceWindowRepository');
const historyRepository = require('../repositories/platformMaintenanceHistoryRepository');
const eventBusService = require('../services/eventBusService');

async function run() {
  const due = windowRepository.listScheduledDue();
  for (const w of due) {
    windowRepository.setStatus(w.id, 'active');
    historyRepository.record({ windowId: w.id, action: 'PUBLISHED', detail: 'scheduled window reached its start time', actor: 'system' });
    eventBusService.publish({ eventType: 'maintenance.started', organizationId: w.scope_type === 'organization' ? w.scope_ref : null, payload: { windowId: w.id, scopeType: w.scope_type, scopeRef: w.scope_ref } });
  }
  return { itemsProcessed: due.length };
}

module.exports = { run };
