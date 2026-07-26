'use strict';

const { getDb } = require('../database/connection');

function get() { return getDb().prepare('SELECT * FROM platform_password_policy WHERE id = 1').get(); }
function update(fields) {
  const sets = [];
  const params = [];
  const map = {
    minLength: 'min_length', requireUppercase: 'require_uppercase', requireLowercase: 'require_lowercase',
    requireNumber: 'require_number', requireSymbol: 'require_symbol', maxAgeDays: 'max_age_days',
    historyCount: 'history_count', lockoutThreshold: 'lockout_threshold', lockoutWindowMinutes: 'lockout_window_minutes',
    lockoutDurationMinutes: 'lockout_duration_minutes', sessionIdleTimeoutMinutes: 'session_idle_timeout_minutes',
    sessionAbsoluteTimeoutHours: 'session_absolute_timeout_hours',
  };
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(fields[key]); }
  }
  if (!sets.length) return get();
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE platform_password_policy SET ${sets.join(', ')} WHERE id = 1`).run(...params);
  return get();
}

module.exports = { get, update };
