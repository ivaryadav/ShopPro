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
const DELIVERY_TIMEOUT_MS = 10000;

// RC1 stabilization: a webhook URL is operator-supplied and this service
// makes a real outbound HTTP call to it — without this check, anyone
// holding only manage_products (not just OWNER/SUPER_ADMIN) could point a
// webhook at internal infrastructure (loopback, RFC1918 ranges, link-local
// addresses including cloud metadata endpoints at 169.254.169.254) and
// use platform_events as an SSRF trigger. Hostname-pattern check only —
// this does not defend against DNS rebinding (a hostname that resolves
// safely at creation time but is repointed to a private address before
// delivery); see docs/architecture-review for that residual risk.
// PLATFORM_ALLOW_PRIVATE_WEBHOOKS is a narrow, explicit test-only escape
// hatch (set by test/testServer.js), never expected in production.
function isPrivateOrReservedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local, includes cloud metadata endpoints
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 unique local (fc00::/7)
  return false;
}
function validateWebhookUrl(url) {
  if (!url || !/^https?:\/\//.test(url)) throw new VE('A valid http(s) url is required');
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw new VE('A valid http(s) url is required'); }
  if (process.env.PLATFORM_ALLOW_PRIVATE_WEBHOOKS === 'true') return;
  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new VE('Webhook URLs may not point at localhost, private, or link-local network addresses');
  }
}

function generateSecret() { return 'whsec_' + crypto.randomBytes(24).toString('hex'); }
function sign(secret, bodyString) { return crypto.createHmac('sha256', secret).update(bodyString).digest('hex'); }

function mapWebhook(w) {
  return { id: w.id, url: w.url, description: w.description, eventTypes: JSON.parse(w.event_types || '[]'), isEnabled: !!w.is_enabled, secretPrefix: w.secret.slice(0, 10) + '…', createdAt: w.created_at, updatedAt: w.updated_at };
}

function create({ url, description, eventTypes }, actor) {
  validateWebhookUrl(url);
  const secret = generateSecret();
  const created = webhookRepository.create({ url, description, eventTypes, secret, createdBy: actor.userId });
  auditService.record({ platformUserId: actor.userId, action: 'WEBHOOK_CREATED', detail: url, ip: actor.ip });
  return { webhook: mapWebhook(created), secret };
}
function list() { return webhookRepository.listAll().map(mapWebhook); }
function update(id, fields, actor) {
  const existing = webhookRepository.findById(id);
  if (!existing) throw new NF('Webhook not found');
  if (fields.url !== undefined) validateWebhookUrl(fields.url);
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

// RC1 stabilization: the automatic Webhook Retry Job and a manual Replay
// API call can legitimately target the SAME delivery row at nearly the
// same moment. Both branches read the delivery row, then `await` a real
// network call before writing back — a plain in-memory guard (this whole
// app is a single Node process, so this is sufficient, mirroring
// jobRunnerService's own isRunning re-entrancy guard for the identical
// class of problem) prevents a duplicate outbound POST to the same
// endpoint and an inconsistent attempts count from two interleaved calls.
const IN_FLIGHT = new Set();

/** One delivery attempt — a real HTTP POST. Never throws; every outcome (success or failure) is recorded on the delivery row itself. */
async function attemptDelivery(deliveryId) {
  if (IN_FLIGHT.has(deliveryId)) return null;
  IN_FLIGHT.add(deliveryId);
  try {
    const delivery = deliveryRepository.findById(deliveryId);
    if (!delivery) return null;
    const webhook = webhookRepository.findById(delivery.webhook_id);
    if (!webhook || !webhook.is_enabled) {
      return deliveryRepository.recordAttempt(deliveryId, { status: 'failed', error: 'webhook is disabled or no longer exists' });
    }
    const bodyString = delivery.payload;
    const signature = sign(webhook.secret, bodyString);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': 'sha256=' + signature, 'X-Webhook-Event': delivery.event_type, 'X-Webhook-Delivery': String(deliveryId) },
        body: bodyString,
        signal: controller.signal,
      });
      if (res.ok) {
        return deliveryRepository.recordAttempt(deliveryId, { status: 'delivered', statusCode: res.status });
      }
      return recordFailure(delivery, `HTTP ${res.status}`, res.status);
    } catch (e) {
      return recordFailure(delivery, e.name === 'AbortError' ? `timed out after ${DELIVERY_TIMEOUT_MS}ms` : e.message, null);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    IN_FLIGHT.delete(deliveryId);
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
