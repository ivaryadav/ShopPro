'use strict';

const { getDb } = require('../database/connection');

function record({ windowId, action, detail, actor }) {
  getDb().prepare('INSERT INTO platform_maintenance_history (window_id, action, detail, actor) VALUES (?,?,?,?)')
    .run(windowId, action, detail || '', actor || 'system');
}
// created_at has only 1-second resolution — several history rows can
// legitimately share the exact same timestamp (e.g. CREATED+ACTIVATED for
// an immediate-mode window, or a burst of operator actions). id DESC as a
// tiebreaker keeps ordering deterministic and true to actual insertion
// order instead of leaving same-timestamp rows in undefined SQLite order.
function listForWindow(windowId) {
  return getDb().prepare('SELECT * FROM platform_maintenance_history WHERE window_id = ? ORDER BY created_at DESC, id DESC').all(windowId);
}
function listRecent(limit) {
  return getDb().prepare(`
    SELECT h.*, w.scope_type, w.scope_ref FROM platform_maintenance_history h
    JOIN platform_maintenance_windows w ON w.id = h.window_id
    ORDER BY h.created_at DESC, h.id DESC LIMIT ?
  `).all(limit || 50);
}

module.exports = { record, listForWindow, listRecent };
