/**
 * RC1 Sprint 2 test — services/adminAuthService.js. Verifies login/session
 * behavior matches local.js's Administration login exactly (local.js:
 * 482-517, 1191-1232), including the automatic sha256->bcrypt migration.
 *
 * Usage: node server/src/tests/adminAuthService.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const adminCredentialRepository = require('../repositories/adminCredentialRepository');
const adminAuthService = require('../services/adminAuthService');
const { ValidationError, AuthenticationError } = require('../errors');

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
  console.log('RC1 Sprint 2: adminAuthService.js tests');
  console.log('');
  adminAuthService._resetForTests();

  await assertThrows(() => adminAuthService.login(''), ValidationError, "login rejects a missing password with a 400-mapped ValidationError — matches local.js:1199's status code exactly");

  {
    const restore = patch(adminCredentialRepository, { get: async () => null });
    await assertThrows(() => adminAuthService.login('anything'), AuthenticationError, 'login rejects when no admin_credentials row exists at all');
    restore();
  }

  {
    const hash = bcrypt.hashSync('correct-password', 10);
    const restore = patch(adminCredentialRepository, { get: async () => ({ algo: 'bcrypt', password_hash: hash }) });
    await assertThrows(() => adminAuthService.login('wrong-password'), AuthenticationError, 'login rejects an incorrect bcrypt password');
    restore();
  }
  {
    const hash = bcrypt.hashSync('correct-password', 10);
    const restore = patch(adminCredentialRepository, { get: async () => ({ algo: 'bcrypt', password_hash: hash }) });
    const token = await adminAuthService.login('correct-password');
    assert(typeof token === 'string' && token.length === 64, 'login succeeds with the correct bcrypt password and returns a 64-hex-char session token');
    assert(adminAuthService.isValidAdminSession(token), 'the returned token is immediately valid against isValidAdminSession');
    restore();
  }

  // ── legacy sha256 path + automatic upgrade ──────────────────────────
  {
    const legacyHash = crypto.createHash('sha256').update('legacy-password').digest('hex');
    let upgradedHash = null, upgradedAlgo = null;
    const restore = patch(adminCredentialRepository, {
      get: async () => ({ algo: 'sha256', password_hash: legacyHash }),
      updateHash: async (hash, algo) => { upgradedHash = hash; upgradedAlgo = algo; },
    });
    const token = await adminAuthService.login('legacy-password');
    assert(typeof token === 'string', "login succeeds against the legacy sha256 hash — matches local.js's Issue-2 backward-compat path exactly");
    assert(upgradedAlgo === 'bcrypt' && bcrypt.compareSync('legacy-password', upgradedHash), "a successful legacy login automatically upgrades to bcrypt — matches local.js:1214-1218 exactly, no forced reset");
    restore();
  }
  {
    const legacyHash = crypto.createHash('sha256').update('legacy-password').digest('hex');
    const restore = patch(adminCredentialRepository, { get: async () => ({ algo: 'sha256', password_hash: legacyHash }) });
    await assertThrows(() => adminAuthService.login('wrong-guess'), AuthenticationError, 'login rejects an incorrect legacy sha256 password without upgrading anything');
    restore();
  }

  // ── session expiry ───────────────────────────────────────────────────
  {
    const hash = bcrypt.hashSync('p', 10);
    const restore = patch(adminCredentialRepository, { get: async () => ({ algo: 'bcrypt', password_hash: hash }) });
    const token = await adminAuthService.login('p');
    assert(adminAuthService.isValidAdminSession(token), 'a freshly issued session is valid');
    assert(!adminAuthService.isValidAdminSession('not-a-real-token-' + token), 'an unrecognized token is rejected');
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
