/**
 * ShopERP Pro — Structured logging helper
 * ─────────────────────────────────────────
 * Thin wrapper around console.log/console.error — not a logging framework.
 * OperationalReadinessPlan.md §4: at this product's current realistic
 * scale (a single shop's own server), pulling in a logging dependency
 * isn't justified; wrapping the existing call sites with a consistent,
 * greppable, timestamped shape is. Matches the project's established
 * "write it directly" posture for infrastructure code (server/scripts/
 * lint.js, the in-memory rate limiter, the session cleanup job).
 *
 * Applied to the operationally significant log lines this and the prior
 * hardening task added or already touch (startup validation, migration
 * failures, health-check failures) — NOT retrofitted across every
 * pre-existing console.log in server/local.js, which would be a much
 * larger, out-of-proportion change for a "minimal improvements" pass.
 */
'use strict';

function emit(level, message, meta) {
  const entry = { time: new Date().toISOString(), level, message };
  if (meta !== undefined) entry.meta = meta;
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

module.exports = {
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};
