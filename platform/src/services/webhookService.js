/**
 * platform/src/services/webhookService.js — Phase 5F: Outbound Webhooks.
 * Endpoint CRUD, HMAC signing, delivery attempts, retry backoff, dead
 * lettering, and replay. A delivery's payload is a denormalized copy
 * captured at enqueue time (see schema.js) — retries never depend on the
 * originating platform_events row still existing.
 */
'use strict';

const crypto = require('crypto');
const webhookRepository = require('../repositories/platformWebhookRepository');
const deliveryRepository = require('../repositories/platformWebhookDeliveryRepository');
const auditService = require('./auditService');
const { NotFoundError: NF, ValidationError: VE } = require('../errors');

// 5 retries: 1m, 5m, 30m, 2h, 12h — then dead_letter. A fixed, simple
// backoff schedule (not exponential-computed) so behavior is exactly
// predictable and trivially testable.
const RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length;

function generateSecret() { return 'whsec_' + crypto.randomBytes(24).toString('hex'); }
function sign(secret, bodyString) { return crypto.createHmac('sha256', secret).update(bodyString).digest('hex'); }

function mapWebhook(w) {
  return { id: w.id, url: w.url, description: w.description, eventTypes: JSON.parse(w.event_types || '[]'), isEnabled: !!w.is_enabled, secretPrefix: w.secret.slice(0, 10) + '…', createdAt: w.created_at, updatedAt: w.updated_at };
}

function create({ url, description, eventTypes }, actor) {
  if (!url || !/^https?:\/\//.test(url)) throw new VE('A valid http(s) url is required');
  const secret = generateSecret();
  const created = webhookRepository.create({ url, description, eventTypes, secret, createdBy: actor.userId });
  auditService.record({ platformUserId: actor.userId, action: 'WEBHOOK_CREATED', detail: url, ip: actor.ip });
  return { webhook: mapWebhook(created), secret };
}
function list() { return webhookRepository.listAll().map(mapWebhook); }
function update(id, fields, actor) {
  const existing = webhookRepository.findById(id);
  if (!existing) throw new NF('Webhook not found');
  const updated = webhookRepository.update(id, fields);
  auditService.record({ platformUserId: actor.userId, action: 'WEBHOOK_UPDATED', detail: updated.url, ip: actor.ip });
  return mapWebhook(updated);
}
function setEnabled(id, isEnabled, actor) {
  const existing = webhookRepository.findById(id);
  if (!existing) throw new NF('Webhook not found');
  const updated = webhookRepository.update(id, { isEnabled });
  auditService.record({ platformUserId: actor.userId, action: isEnabled ? 'WEBHOOK_ENABLED' : 'WEBHOOK_DISABLED', detail: updated.url, ip: actor.ip });
  return mapWebhook(updated);
}
function rotateSecret(id, actor) {
  const existing = webhookRepository.findById(id);
  if (!existing) throw new NF('Webhook not found');
  const secret = generateSecret();
  const updated = webhookRepository.update(id, { secret });
  auditService.record({ platformUserId: actor.userId, action: 'WEBHOOK_SECRET_ROTATED', detail: updated.url, ip: actor.ip });
  return { webhook: mapWebhook(updated), secret };
}
function remove(id, actor) {
  const existing = webhookRepository.findById(id);
  if (!existing) throw new NF('Webhook not found');
  webhookRepository.remove(id);
  auditService.record({ platformUserId: actor.userId, action: 'WEBHOOK_DELETED', detail: existing.url, ip: actor.ip });
  return { ok: true };
}

/** One delivery attempt — a real HTTP POST. Never throws; every outcome (success or failure) is recorded on the delivery row itself. */
async function attemptDelivery(deliveryId) {
  const delivery = deliveryRepository.findById(deliveryId);
  if (!delivery) return null;
  const webhook = webhookRepository.findById(delivery.webhook_id);
  if (!webhook || !webhook.is_enabled) {
    return deliveryRepository.recordAttempt(deliveryId, { status: 'failed', error: 'webhook is disabled or no longer exists' });
  }
  const bodyString = delivery.payload;
  const signature = sign(webhook.secret, bodyString);
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': 'sha256=' + signature, 'X-Webhook-Event': delivery.event_type, 'X-Webhook-Delivery': String(deliveryId) },
      body: bodyString,
    });
    if (res.ok) {
      return deliveryRepository.recordAttempt(deliveryId, { status: 'delivered', statusCode: res.status });
    }
    return recordFailure(delivery, `HTTP ${res.status}`, res.status);
  } catch (e) {
    return recordFailure(delivery, e.message, null);
  }
}

function recordFailure(delivery, errorMessage, statusCode) {
  const attemptsMade = delivery.attempts + 1; // this call is the (attempts+1)th attempt
  if (attemptsMade >= MAX_ATTEMPTS) {
    return deliveryRepository.recordAttempt(delivery.id, { status: 'dead_letter', statusCode, error: errorMessage });
  }
  const delayMinutes = RETRY_DELAYS_MINUTES[attemptsMade - 1];
  const nextAttemptAt = new Date(Date.now() + delayMinutes * 60000).toISOString();
  return deliveryRepository.recordAttempt(delivery.id, { status: 'pending', statusCode, error: errorMessage, nextAttemptAt });
}

/** Replay Failed Deliveries — resets attempts and immediately tries again once. */
async function replayDelivery(deliveryId, actor) {
  const existing = deliveryRepository.findById(deliveryId);
  if (!existing) throw new NF('Delivery not found');
  deliveryRepository.resetForReplay(deliveryId);
  auditService.record({ platformUserId: actor.userId, action: 'WEBHOOK_DELIVERY_REPLAYED', detail: `delivery ${deliveryId}`, ip: actor.ip });
  return attemptDelivery(deliveryId);
}

function listDeliveries(webhookId, limit) { return deliveryRepository.listForWebhook(webhookId, limit); }
function getRetryQueue() { return deliveryRepository.listDueRetryQueue(); }
function getDeadLetters(limit) { return deliveryRepository.listDeadLetters(limit); }
function getDeliveryCounts() { return deliveryRepository.counts(); }

module.exports = {
  create, list, update, setEnabled, rotateSecret, remove,
  attemptDelivery, replayDelivery, listDeliveries, getRetryQueue, getDeadLetters, getDeliveryCounts,
  sign, MAX_ATTEMPTS, RETRY_DELAYS_MINUTES,
};
