/**
 * platform/src/jobs/deadLetterCleanupJob.js — Phase 5F. Purges dead_letter
 * webhook deliveries older than the retention window (90 days) — keeps
 * the table from growing unbounded, same reasoning as loginFailureRetentionJob.
 * A dead-lettered delivery is already a terminal, exhausted-retries state,
 * so deleting an old one loses no recoverable information.
 */
'use strict';

const deliveryRepository = require('../repositories/platformWebhookDeliveryRepository');

const RETENTION_DAYS = Number(process.env.WEBHOOK_DEAD_LETTER_RETENTION_DAYS) || 90;

async function run() {
  const deleted = deliveryRepository.deleteDeadLettersOlderThan(RETENTION_DAYS);
  return { itemsProcessed: deleted };
}

module.exports = { run };
