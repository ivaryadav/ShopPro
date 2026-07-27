/**
 * platform/src/jobs/eventRetentionJob.js — Phase 5F. Purges
 * platform_events rows older than the retention window (180 days). Safe
 * regardless of webhook delivery state, since deliveries store their own
 * denormalized payload copy (see schema.js) and never depend on the
 * originating event row surviving — this is data lifecycle management on
 * an append-only log, not a mutation of a live event; see schema.js's
 * platform_events comment for what "immutable" means here.
 */
'use strict';

const eventRepository = require('../repositories/platformEventRepository');

const RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS) || 180;

async function run() {
  const deleted = eventRepository.deleteOlderThan(RETENTION_DAYS);
  return { itemsProcessed: deleted };
}

module.exports = { run };
