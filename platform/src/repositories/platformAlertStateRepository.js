'use strict';

const { getDb } = require('../database/connection');

/** @returns {Map<string, {read_at, dismissed_at}>} every known alert_key's state, for joining against a live-computed alert list */
function allStates() {
  const rows = getDb().prepare('SELECT alert_key, read_at, dismissed_at FROM platform_alert_state').all();
  const map = new Map();
  for (const r of rows) map.set(r.alert_key, r);
  return map;
}
function markRead(alertKey) {
  getDb().prepare(`
    INSERT INTO platform_alert_state (alert_key, read_at) VALUES (?, datetime('now'))
    ON CONFLICT(alert_key) DO UPDATE SET read_at = excluded.read_at
  `).run(alertKey);
}
function markDismissed(alertKey) {
  getDb().prepare(`
    INSERT INTO platform_alert_state (alert_key, dismissed_at) VALUES (?, datetime('now'))
    ON CONFLICT(alert_key) DO UPDATE SET dismissed_at = excluded.dismissed_at
  `).run(alertKey);
}

module.exports = { allStates, markRead, markDismissed };
