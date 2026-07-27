/**
 * platform/src/jobs/webhookRetryJob.js — Phase 5F. Every pending
 * delivery whose next_attempt_at has arrived gets one more attempt via
 * webhookService.attemptDelivery(), which itself decides success/another
 * retry/dead_letter — this job is just the trigger, not the retry logic.
 */
'use strict';

const deliveryRepository = require('../repositories/platformWebhookDeliveryRepository');
const webhookService = require('../services/webhookService');

async function run() {
  const due = deliveryRepository.listRetryQueue();
  for (const delivery of due) {
    await webhookService.attemptDelivery(delivery.id);
  }
  return { itemsProcessed: due.length };
}

module.exports = { run };
