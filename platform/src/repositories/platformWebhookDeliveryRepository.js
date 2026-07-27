'use strict';

const { getDb } = require('../database/connection');

function findById(id) { return getDb().prepare('SELECT * FROM platform_webhook_deliveries WHERE id = ?').get(id); }

function create({ webhookId, eventId, eventType, payload }) {
  const result = getDb().prepare(`
    INSERT INTO platform_webhook_deliveries (webhook_id, event_id, event_type, payload) VALUES (?,?,?,?)
  `).run(webhookId, eventId || null, eventType, JSON.stringify(payload || {}));
  return findById(Number(result.lastInsertRowid));
}

function recordAttempt(id, { status, statusCode, error, nextAttemptAt }) {
  getDb().prepare(`
    UPDATE platform_webhook_deliveries SET
      status = ?, attempts = attempts + 1, last_status_code = ?, last_error = ?,
      next_attempt_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now') ELSE delivered_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, statusCode != null ? statusCode : null, error || null, nextAttemptAt || null, status, id);
  return findById(id);
}

/** Replay Failed Deliveries — resets a failed/dead_letter delivery back to pending with a fresh attempt counter. */
function resetForReplay(id) {
  getDb().prepare(`
    UPDATE platform_webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  return findById(id);
}

function listForWebhook(webhookId, limit) {
  return getDb().prepare('SELECT * FROM platform_webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(webhookId, limit || 50);
}
function listRetryQueue() {
  return getDb().prepare(`SELECT * FROM platform_webhook_deliveries WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= datetime('now')`).all();
}
function listDueRetryQueue() {
  // "Retry Queue" view (Integration Center) — every pending delivery awaiting its next attempt, not just those currently due.
  return getDb().prepare(`SELECT * FROM platform_webhook_deliveries WHERE status = 'pending' ORDER BY next_attempt_at ASC`).all();
}
function listDeadLetters(limit) {
  return getDb().prepare("SELECT * FROM platform_webhook_deliveries WHERE status = 'dead_letter' ORDER BY updated_at DESC LIMIT ?").all(limit || 100);
}
function deleteDeadLettersOlderThan(days) {
  return getDb().prepare(`DELETE FROM platform_webhook_deliveries WHERE status = 'dead_letter' AND updated_at < datetime('now', ?)`).run(`-${days} days`).changes;
}
function counts() {
  const db = getDb();
  return {
    delivered: db.prepare("SELECT COUNT(*) c FROM platform_webhook_deliveries WHERE status='delivered'").get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM platform_webhook_deliveries WHERE status='pending'").get().c,
    failed: db.prepare("SELECT COUNT(*) c FROM platform_webhook_deliveries WHERE status='failed'").get().c,
    deadLetter: db.prepare("SELECT COUNT(*) c FROM platform_webhook_deliveries WHERE status='dead_letter'").get().c,
  };
}

module.exports = {
  findById, create, recordAttempt, resetForReplay, listForWebhook,
  listRetryQueue, listDueRetryQueue, listDeadLetters, deleteDeadLettersOlderThan, counts,
};
