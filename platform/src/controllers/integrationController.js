'use strict';

const webhookService = require('../services/webhookService');
const eventBusService = require('../services/eventBusService');
const apiUsageRepository = require('../repositories/platformApiUsageRepository');

function actor(req) { return { userId: req.platformUser.userId, email: req.platformUser.email, ip: req.ip }; }

// ── Webhooks ───────────────────────────────────────────────────────────
async function listWebhooks(req, res, next) { try { res.json({ webhooks: webhookService.list() }); } catch (e) { next(e); } }
async function createWebhook(req, res, next) {
  try { const result = webhookService.create(req.body, actor(req)); res.status(201).json(result); } catch (e) { next(e); }
}
async function updateWebhook(req, res, next) {
  try { res.json({ webhook: webhookService.update(Number(req.params.id), req.body, actor(req)) }); } catch (e) { next(e); }
}
async function enableWebhook(req, res, next) {
  try { res.json({ webhook: webhookService.setEnabled(Number(req.params.id), true, actor(req)) }); } catch (e) { next(e); }
}
async function disableWebhook(req, res, next) {
  try { res.json({ webhook: webhookService.setEnabled(Number(req.params.id), false, actor(req)) }); } catch (e) { next(e); }
}
async function rotateWebhookSecret(req, res, next) {
  try { res.json(webhookService.rotateSecret(Number(req.params.id), actor(req))); } catch (e) { next(e); }
}
async function deleteWebhook(req, res, next) {
  try { res.json(webhookService.remove(Number(req.params.id), actor(req))); } catch (e) { next(e); }
}
async function webhookDeliveries(req, res, next) {
  try { res.json({ deliveries: webhookService.listDeliveries(Number(req.params.id)) }); } catch (e) { next(e); }
}

// ── Delivery Queue / Retry Queue / Dead Letters ──────────────────────────
async function retryQueue(req, res, next) { try { res.json({ deliveries: webhookService.getRetryQueue() }); } catch (e) { next(e); } }
async function deadLetters(req, res, next) { try { res.json({ deliveries: webhookService.getDeadLetters() }); } catch (e) { next(e); } }
async function deliveryCounts(req, res, next) { try { res.json(webhookService.getDeliveryCounts()); } catch (e) { next(e); } }
async function replayDelivery(req, res, next) {
  try { const delivery = await webhookService.replayDelivery(Number(req.params.id), actor(req)); res.json({ delivery }); } catch (e) { next(e); }
}

// ── Event Explorer ────────────────────────────────────────────────────
async function searchEvents(req, res, next) {
  try {
    const { eventType, organizationId, productId, dateFrom, dateTo, page, pageSize } = req.query;
    const result = eventBusService.search({ eventType, organizationId, productId: productId ? Number(productId) : undefined, dateFrom, dateTo, page: page ? Number(page) : 1, pageSize: pageSize ? Number(pageSize) : 25 });
    res.json({ events: result.rows, total: result.total });
  } catch (e) { next(e); }
}
async function recentEvents(req, res, next) {
  try { res.json({ events: eventBusService.listRecent(req.query.limit ? Number(req.query.limit) : 20) }); } catch (e) { next(e); }
}

// ── API Usage Metrics ─────────────────────────────────────────────────
async function apiUsage(req, res, next) {
  try { res.json({ recent: apiUsageRepository.listRecent(req.query.limit ? Number(req.query.limit) : 50) }); } catch (e) { next(e); }
}

module.exports = {
  listWebhooks, createWebhook, updateWebhook, enableWebhook, disableWebhook, rotateWebhookSecret, deleteWebhook, webhookDeliveries,
  retryQueue, deadLetters, deliveryCounts, replayDelivery,
  searchEvents, recentEvents, apiUsage,
};
