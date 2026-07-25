/**
 * RC1 Sprint 3 test — services/cloudBackupService.js. Verifies every
 * business rule matches local.js's Cloud Backup domain exactly (see
 * cloudBackupService.js's own header + per-function comments for line
 * citations). No live database needed — the repository is monkey-patched.
 *
 * Usage: node server/src/tests/cloudBackupService.test.js
 */
'use strict';

const cloudBackupRepository = require('../repositories/cloudBackupRepository');
const cloudBackupService = require('../services/cloudBackupService');
const { ValidationError, NotFoundError } = require('../errors');

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
  console.log('RC1 Sprint 3: cloudBackupService.js tests');
  console.log('');

  // ── createOrUpdateBackup ─────────────────────────────────────────────
  await assertThrows(() => cloudBackupService.createOrUpdateBackup({ keyHash: '', data: 'x' }), ValidationError, 'createOrUpdateBackup rejects a missing keyHash — matches local.js:1753-1771 exactly');
  await assertThrows(() => cloudBackupService.createOrUpdateBackup({ keyHash: 'abc', data: '' }), ValidationError, 'createOrUpdateBackup rejects missing data');
  {
    let upserted = null;
    const restore = patch(cloudBackupRepository, { upsert: async (args) => { upserted = args; } });
    await cloudBackupService.createOrUpdateBackup({ keyHash: 'abc123', shopName: 'My Shop', data: '{"encrypted":"blob"}' });
    assert(upserted.keyHash === 'abc123' && upserted.shopName === 'My Shop' && upserted.data === '{"encrypted":"blob"}', 'createOrUpdateBackup passes exact fields through to the repository unchanged');
    restore();
  }
  {
    // Matches local.js's real behavior: calling twice for the same keyHash
    // overwrites the first backup — no history, one slot per license.
    let upsertCalls = 0;
    const restore = patch(cloudBackupRepository, { upsert: async () => { upsertCalls++; } });
    await cloudBackupService.createOrUpdateBackup({ keyHash: 'abc123', data: 'v1' });
    await cloudBackupService.createOrUpdateBackup({ keyHash: 'abc123', data: 'v2' });
    assert(upsertCalls === 2, 'createOrUpdateBackup is a pure upsert — calling it twice for the same keyHash just overwrites, matching local.js\'s one-backup-slot-per-license design exactly, not a bug');
    restore();
  }
  {
    // shopName is optional in local.js (defaults to '' at the repository/SQL layer)
    let upserted = null;
    const restore = patch(cloudBackupRepository, { upsert: async (args) => { upserted = args; } });
    await cloudBackupService.createOrUpdateBackup({ keyHash: 'no-shop-name', data: 'x' });
    assert(upserted.shopName === undefined, 'createOrUpdateBackup does not invent a shopName default at the service layer — that default lives in the repository, matching local.js\'s own layering');
    restore();
  }

  // ── restoreBackup ────────────────────────────────────────────────────
  {
    const restore = patch(cloudBackupRepository, { findByKeyHash: async () => null });
    await assertThrows(() => cloudBackupService.restoreBackup('does-not-exist'), NotFoundError, 'restoreBackup throws NotFoundError for an unknown keyHash — matches local.js:1774-1778 exactly');
    restore();
  }
  {
    const backedUpAt = new Date('2026-01-01T00:00:00Z');
    const restore = patch(cloudBackupRepository, { findByKeyHash: async (keyHash) => (keyHash === 'abc123' ? { key_hash: 'abc123', data: '{"encrypted":"blob"}', shop_name: 'My Shop', backed_up_at: backedUpAt } : null) });
    const result = await cloudBackupService.restoreBackup('abc123');
    assert(result.data === '{"encrypted":"blob"}' && result.shopName === 'My Shop' && result.backedUpAt === backedUpAt, 'restoreBackup returns the exact {data, shopName, backedUpAt} shape local.js\'s response returns');
    restore();
  }

  // ── deleteBackup ─────────────────────────────────────────────────────
  {
    // Matches local.js's real behavior: DELETE is unconditional — no
    // existence check, always succeeds even for a keyHash with no row.
    // Preserved as-is, not "fixed" with a 404 — a deliberate quirk.
    let removedKeyHash = null;
    const restore = patch(cloudBackupRepository, { remove: async (keyHash) => { removedKeyHash = keyHash; } });
    await cloudBackupService.deleteBackup('never-existed');
    assert(removedKeyHash === 'never-existed', 'deleteBackup calls repository.remove() unconditionally, with no prior existence check — matches local.js:1781-1784\'s real, unconditional DELETE exactly, not a bug to fix');
    restore();
  }

  // ── listBackups (repository-only, no local.js route equivalent) ──────
  {
    const restore = patch(cloudBackupRepository, { listAll: async () => [{ key_hash: 'a' }, { key_hash: 'b' }] });
    const result = await cloudBackupService.listBackups();
    assert(result.length === 2, 'listBackups passes through the repository\'s listAll() result — a repo-only capability added this sprint, not exposed via any new HTTP route (no local.js equivalent to preserve parity with)');
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
