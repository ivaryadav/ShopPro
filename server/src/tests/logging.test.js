/**
 * Phase 1 test — server/src/logging/. Uses a mock transport (not real
 * console/file writes) to assert exactly what the Logger dispatches,
 * plus one real fileTransport test against a temp directory.
 *
 * Usage: node server/src/tests/logging.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Logger } = require('../logging/Logger');
const { createFileTransport } = require('../logging/transports/fileTransport');
const { isValidLevel, meetsThreshold, LEVELS } = require('../logging/levels');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

console.log('Phase 1: logging/ tests');
console.log('');

// ── levels.js ────────────────────────────────────────────────────────────
assert(LEVELS.length === 5, 'exactly 5 levels are defined');
assert(isValidLevel('WARN') === true, 'WARN is a valid level');
assert(isValidLevel('VERBOSE') === false, 'VERBOSE is not a valid level');
assert(meetsThreshold('ERROR', 'WARN') === true, 'ERROR meets a WARN threshold');
assert(meetsThreshold('DEBUG', 'WARN') === false, 'DEBUG does not meet a WARN threshold');

// ── Logger.js — level filtering ─────────────────────────────────────────
function makeCapturingTransport() {
  const entries = [];
  return { entries, write: (e) => entries.push(e) };
}

const warnTransport = makeCapturingTransport();
const warnLogger = new Logger({ level: 'WARN', transports: [warnTransport] });
warnLogger.debug('should be filtered out');
warnLogger.info('should also be filtered out');
warnLogger.warn('this should appear');
warnLogger.error('this should appear too');
assert(warnTransport.entries.length === 2, 'a WARN-level logger filters out DEBUG and INFO, keeps WARN and ERROR');
assert(warnTransport.entries[0].message === 'this should appear', 'the first surviving entry is the WARN one, in order');

// ── Logger.js — entry shape ─────────────────────────────────────────────
const shapeTransport = makeCapturingTransport();
const shapeLogger = new Logger({ level: 'DEBUG', transports: [shapeTransport] });
shapeLogger.info('hello', { userId: 42 });
const entry = shapeTransport.entries[0];
assert(typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)), 'entry has a valid ISO timestamp');
assert(entry.level === 'INFO', 'entry records the correct level');
assert(entry.message === 'hello', 'entry records the message');
assert(entry.meta && entry.meta.userId === 42, 'entry records meta when provided');

const noMetaTransport = makeCapturingTransport();
new Logger({ level: 'DEBUG', transports: [noMetaTransport] }).info('no meta here');
assert(!('meta' in noMetaTransport.entries[0]), 'entry omits the meta key entirely when no meta was passed');

// ── Logger.js — multiple transports ─────────────────────────────────────
const t1 = makeCapturingTransport();
const t2 = makeCapturingTransport();
new Logger({ level: 'DEBUG', transports: [t1, t2] }).error('fan-out check');
assert(t1.entries.length === 1 && t2.entries.length === 1, 'a single log call reaches every configured transport');

// ── Logger.js — child() context ─────────────────────────────────────────
const childTransport = makeCapturingTransport();
const baseLogger = new Logger({ level: 'DEBUG', transports: [childTransport], context: { service: 'test' } });
const child = baseLogger.child({ tenantId: 7 });
child.info('scoped message');
const childEntry = childTransport.entries[0];
assert(childEntry.context.service === 'test' && childEntry.context.tenantId === 7, "child() merges parent context with its own, both present on the entry");

// ── Logger.js — invalid construction ─────────────────────────────────────
try {
  new Logger({ level: 'NOT_A_LEVEL', transports: [makeCapturingTransport()] });
  failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m constructing with an invalid level throws');
} catch (e) { passed++; console.log('  \x1b[32m✓\x1b[0m constructing with an invalid level throws'); }

try {
  new Logger({ level: 'INFO', transports: [] });
  failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m constructing with zero transports throws');
} catch (e) { passed++; console.log('  \x1b[32m✓\x1b[0m constructing with zero transports throws'); }

// ── fileTransport.js — real filesystem write, temp directory ────────────
const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoperp-log-test-'));
const fileTransport = createFileTransport(tmpLogDir);
const fileLogger = new Logger({ level: 'DEBUG', transports: [fileTransport] });
fileLogger.info('written to a real file');
const today = new Date().toISOString().slice(0, 10);
const expectedFile = path.join(tmpLogDir, `${today}.log`);
assert(fs.existsSync(expectedFile), 'fileTransport creates a date-stamped log file');
const fileContent = fs.readFileSync(expectedFile, 'utf8').trim();
const parsedLine = JSON.parse(fileContent);
assert(parsedLine.message === 'written to a real file', 'the written file contains a valid JSON line with the correct message');
fs.rmSync(tmpLogDir, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
