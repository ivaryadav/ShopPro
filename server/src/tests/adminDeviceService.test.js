/**
 * RC1 Sprint 2 test — services/adminDeviceService.js. Verifies Device
 * Management matches local.js exactly (local.js:1613-1641).
 *
 * Usage: node server/src/tests/adminDeviceService.test.js
 */
'use strict';

const adminDirectoryRepository = require('../repositories/adminDirectoryRepository');
const licenseHistoryRepository = require('../repositories/licenseHistoryRepository');
const adminDeviceService = require('../services/adminDeviceService');
const { NotFoundError } = require('../errors');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
async function assertThrows(fn, ErrorClass, label) {
  try {
    await fn();
    failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label + ' (did not throw)');
  } catch (e) {
    if (e instanceof ErrorClass) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
    else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${label} (got ${e.constructor.name}: ${e.message})`); }
  }
}
function patch(mod, overrides) {
  const originals = {};
  for (const [key, fn] of Object.entries(overrides)) { originals[key] = mod[key]; mod[key] = fn; }
  return () => { for (const [key, fn] of Object.entries(originals)) mod[key] = fn; };
}

async function main() {
  console.log('RC1 Sprint 2: adminDeviceService.js tests');
  console.log('');

  {
    const restore = patch(adminDirectoryRepository, { findDeviceRow: async () => false });
    await assertThrows(() => adminDeviceService.removeDevice(1, 999), NotFoundError, "removeDevice throws NotFoundError for a device row not belonging to this tenant — matches local.js:1629 exactly");
    restore();
  }
  {
    let deactivated = null, historyRecorded = null;
    const restoreDir = patch(adminDirectoryRepository, { findDeviceRow: async () => true, deactivateDevice: async (id) => { deactivated = id; } });
    const restoreHist = patch(licenseHistoryRepository, { record: async (d) => { historyRecorded = d; } });
    await adminDeviceService.removeDevice(1, 42);
    assert(deactivated === 42, "removeDevice soft-deactivates (is_active=0), never hard-deletes — matches local.js:1630's audit-trail-preserving design exactly");
    assert(historyRecorded.eventType === 'DEVICE_REMOVED' && historyRecorded.detail.includes('42'), 'removeDevice logs a DEVICE_REMOVED history event naming the row');
    restoreDir(); restoreHist();
  }
  {
    let historyRecorded = null;
    const restoreDir = patch(adminDirectoryRepository, { deactivateAllDevices: async () => 3 });
    const restoreHist = patch(licenseHistoryRepository, { record: async (d) => { historyRecorded = d; } });
    const result = await adminDeviceService.resetAllDevices(1);
    assert(result.reset === 3, 'resetAllDevices returns the real count of devices reset');
    assert(historyRecorded.eventType === 'DEVICES_RESET' && historyRecorded.detail === '3 device(s) reset', "resetAllDevices logs a DEVICES_RESET history event with the exact count — matches local.js:1639 exactly");
    restoreDir(); restoreHist();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
