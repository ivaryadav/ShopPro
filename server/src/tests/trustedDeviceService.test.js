/**
 * Phase 2 test — services/trustedDeviceService.js. Verifies device-trust
 * logic matches local.js's inline login-time behavior exactly
 * (local.js:989-1018), including the documented fallback-to-2 device
 * limit (see the service's own header for why). No live database needed
 * — trustedDeviceRepository is monkey-patched.
 *
 * Usage: node server/src/tests/trustedDeviceService.test.js
 */
'use strict';

const trustedDeviceRepository = require('../repositories/trustedDeviceRepository');
const trustedDeviceService = require('../services/trustedDeviceService');
const { BusinessRuleError } = require('../errors');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function patchRepo(overrides) {
  const originals = {};
  for (const [key, fn] of Object.entries(overrides)) {
    originals[key] = trustedDeviceRepository[key];
    trustedDeviceRepository[key] = fn;
  }
  return () => { for (const [key, fn] of Object.entries(originals)) trustedDeviceRepository[key] = fn; };
}

async function main() {
  console.log('Phase 2: trustedDeviceService.js tests');
  console.log('');

  // ── No deviceId sent = old client build, byte-identical old behavior ──────
  {
    let touched = false;
    const restore = patchRepo({
      findActive: async () => { touched = true; return null; },
      countActiveForTenant: async () => { touched = true; return 0; },
      createIgnoringRace: async () => { touched = true; },
    });
    await trustedDeviceService.checkAndTrust({ tenantId: 1, userId: 1, deviceId: undefined, userAgent: 'x' });
    assert(touched === false, 'absent deviceId short-circuits entirely — matches local.js:991\'s exact old-client-compat behavior, no repository call made at all');
    restore();
  }

  // ── Known device: touch login, no limit check ──────────────────────────────
  {
    let touchedLoginCalled = false;
    const restore = patchRepo({
      findActive: async () => ({ id: 42 }),
      touchLogin: async (id) => { touchedLoginCalled = (id === 42); },
      countActiveForTenant: async () => { throw new Error('should not be called for a known device'); },
    });
    await trustedDeviceService.checkAndTrust({ tenantId: 1, userId: 1, deviceId: 'known-device', userAgent: 'Mozilla/5.0 Chrome/1.0' });
    assert(touchedLoginCalled, 'a known device updates last_login_at and does not check the device limit at all');
    restore();
  }

  // ── New device, under the fallback limit of 2: auto-trust ──────────────────
  {
    let created = false;
    const restore = patchRepo({
      findActive: async () => null,
      countActiveForTenant: async () => 1,
      createIgnoringRace: async () => { created = true; },
    });
    await trustedDeviceService.checkAndTrust({ tenantId: 1, userId: 1, deviceId: 'brand-new', userAgent: 'x' });
    assert(created, 'a new device under the limit (1 active < 2) is auto-trusted');
    restore();
  }

  // ── New device, AT the fallback limit of 2: rejected ────────────────────────
  {
    let created = false;
    const restore = patchRepo({
      findActive: async () => null,
      countActiveForTenant: async () => 2,
      createIgnoringRace: async () => { created = true; },
    });
    try {
      await trustedDeviceService.checkAndTrust({ tenantId: 1, userId: 1, deviceId: 'one-too-many', userAgent: 'x' });
      failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m a new device at the limit (2 active >= 2) is rejected');
    } catch (e) {
      const ok = e instanceof BusinessRuleError && e.ruleCode === 'DEVICE_LIMIT_REACHED' && e.message.includes('2/2');
      if (ok) { passed++; console.log('  \x1b[32m✓\x1b[0m a new device at the limit (2 active >= 2) is rejected with DEVICE_LIMIT_REACHED, matching local.js\'s exact error shape'); }
      else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m wrong error: ' + e.message); }
    }
    assert(!created, 'no device row was created for the rejected attempt');
    restore();
  }

  assert(trustedDeviceService.FALLBACK_DEVICE_LIMIT === 2, "the documented fallback limit is exactly 2 — local.js's own `lic ? lic.device_limit : 2` default, not a newly invented number");

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
