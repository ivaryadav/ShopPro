/**
 * platform/src/services/eventBusService.js — Phase 5F: the centralized
 * Platform Event system. Every major business event flows through
 * publish() here: it writes one immutable platform_events row, then fans
 * out to every enabled webhook subscribed to that event type (or
 * subscribed to "all events" via an empty event_types list), enqueuing a
 * delivery for each.
 *
 * publish() is deliberately a PLAIN (non-async) function — event and
 * delivery ROW creation are both synchronous better-sqlite3 writes, so
 * they are guaranteed complete before publish() returns, with zero
 * `await` required at any call site. It is called as an additive side
 * effect from many existing, already-tested business-logic functions
 * (organization create, license renew, invoice paid, etc.) — a
 * webhook/event-bus fault must never change their sync/async nature or
 * break the underlying action that triggered it, so publish() never
 * throws (a DB error here is caught and logged, not propagated) and the
 * actual HTTP delivery attempt happens in the background, off the
 * synchronous return path. The returned `delivered` promise exists purely
 * so tests can await real delivery completion when they need to — no
 * production caller uses it.
 */
'use strict';

const eventRepository = require('../repositories/platformEventRepository');
const webhookRepository = require('../repositories/platformWebhookRepository');
const deliveryRepository = require('../repositories/platformWebhookDeliveryRepository');

function matchesSubscription(webhook, eventType) {
  let types = [];
  try { types = JSON.parse(webhook.event_types || '[]'); } catch (_) { types = []; }
  return types.length === 0 || types.includes(eventType);
}

function publish({ eventType, organizationId, productId, payload }) {
  let event = null;
  let deliveries = [];
  try {
    event = eventRepository.create({ eventType, organizationId, productId, payload });
    const webhooks = webhookRepository.listEnabled().filter((w) => matchesSubscription(w, eventType));
    deliveries = webhooks.map((webhook) => deliveryRepository.create({ webhookId: webhook.id, eventId: event.id, eventType, payload }));
  } catch (e) {
    console.error('[Event Bus] publish failed — the triggering action is unaffected', { eventType, error: e.message });
    return { event: null, delivered: Promise.resolve([]) };
  }
  // Fire-and-forget from this function's point of view — NOT awaited here.
  const webhookService = require('./webhookService');
  const delivered = Promise.all(deliveries.map((d) => webhookService.attemptDelivery(d.id).catch((e) => {
    console.error('[Event Bus] webhook delivery attempt threw unexpectedly', { deliveryId: d.id, error: e.message });
    return null;
  })));
  return { event, delivered };
}

/** Event Explorer — search/filter. */
function search(query) { return eventRepository.search(query); }
function listRecent(limit) { return eventRepository.listRecent(limit); }
function countSince(sinceExpr) { return eventRepository.countSince(sinceExpr); }
function countTotal() { return eventRepository.countTotal(); }

module.exports = { publish, search, listRecent, countSince, countTotal };
