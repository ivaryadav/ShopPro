/**
 * server/src/logging/levels.js
 *
 * The five log levels this project's logging strategy supports, in
 * ascending severity order. A logger configured at level X emits X and
 * everything more severe than X, silencing everything less severe.
 */
'use strict';

/** @type {Array<'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL'>} */
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

const LEVEL_RANK = Object.freeze(
  LEVELS.reduce((acc, level, i) => Object.assign(acc, { [level]: i }), {})
);

/**
 * @param {string} level
 * @returns {boolean}
 */
function isValidLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, level);
}

/**
 * @param {string} candidate
 * @param {string} threshold
 * @returns {boolean} True if candidate is at or above threshold's severity.
 */
function meetsThreshold(candidate, threshold) {
  return LEVEL_RANK[candidate] >= LEVEL_RANK[threshold];
}

module.exports = { LEVELS, LEVEL_RANK, isValidLevel, meetsThreshold };
