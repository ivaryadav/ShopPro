'use strict';

const { getDb } = require('../database/connection');

function findById(id) { return getDb().prepare('SELECT * FROM platform_webhooks WHERE id = ?').get(id); }
function listAll() { return getDb().prepare('SELECT * FROM platform_webhooks ORDER BY created_at DESC').all(); }
function listEnabled() { return getDb().prepare('SELECT * FROM platform_webhooks WHERE is_enabled = 1').all(); }

function create({ url, description, eventTypes, secret, createdBy }) {
  const result = getDb().prepare(`
    INSERT INTO platform_webhooks (url, description, event_types, secret, created_by) VALUES (?,?,?,?,?)
  `).run(url, description || '', JSON.stringify(eventTypes || []), secret, createdBy || null);
  return findById(Number(result.lastInsertRowid));
}
function update(id, fields) {
  const sets = [];
  const params = [];
  if (fields.url !== undefined) { sets.push('url = ?'); params.push(fields.url); }
  if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.eventTypes !== undefined) { sets.push('event_types = ?'); params.push(JSON.stringify(fields.eventTypes)); }
  if (fields.isEnabled !== undefined) { sets.push('is_enabled = ?'); params.push(fields.isEnabled ? 1 : 0); }
  if (fields.secret !== undefined) { sets.push('secret = ?'); params.push(fields.secret); }
  if (!sets.length) return findById(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE platform_webhooks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findById(id);
}
function remove(id) { return getDb().prepare('DELETE FROM platform_webhooks WHERE id = ?').run(id).changes > 0; }

module.exports = { findById, listAll, listEnabled, create, update, remove };
