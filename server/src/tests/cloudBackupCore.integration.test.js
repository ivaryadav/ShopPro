/**
 * RC1 Sprint 3 integration test — the full Cloud Backup Domain stack
 * (migration -> repository -> service) against a REAL MariaDB, end to
 * end: create, restore, overwrite (upsert), multiple independent
 * key_hash backups, cross-key isolation (one license's backup is never
 * visible under another's key_hash — the only "tenant isolation"
 * concept this key_hash-keyed table has, see
 * migrations/005_cloud_backup_domain.sql's header), delete (including
 * the unconditional-no-existence-check quirk), and a simulated
 * corrupted/missing-backup recovery path.
 *
 * Same honest-skip pattern as every other integration test in this
 * project. Config is env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME).
 *
 * Usage: node server/src/tests/cloudBackupCore.integration.test.js
 */
'use strict';

const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests, withConnection } = require('../database');
const cloudBackupService = require('../services/cloudBackupService');
const cloudBackupRepository = require('../repositories/cloudBackupRepository');
const { NotFoundError } = require('../errors');

let passed = 0, failed = 0, skipped = 0;
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
function skip(label, reason) { skipped++; console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason); }

const TEST_DB_CONFIG = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_phase6_test',
};

async function main() {
  console.log('RC1 Sprint 3 integration test: full Cloud Backup Domain stack against real MariaDB');
  console.log('');

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);
  if (!health.ok) {
    for (const label of [
      'create backup then restore returns the exact data written',
      'a second backup for the same keyHash overwrites the first (upsert, no history)',
      'multiple independent keyHash backups do not interfere with each other',
      'cross-key isolation: restoring one keyHash never returns another keyHash\'s data',
      'restoreBackup throws NotFoundError for a missing/corrupted (never-written) keyHash',
      'deleteBackup removes a backup; restoring it afterward then 404s',
      'deleteBackup on a never-existent keyHash still succeeds (matches local.js\'s unconditional DELETE)',
      'recovery after simulated failure: a failed create leaves any prior backup for that keyHash untouched',
    ]) skip(label, `no reachable/authenticated database: ${health.error}`);
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(failed > 0 ? 1 : 0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  try {
    await migrateUp(pool);

    const keyA = 'integration-key-' + Date.now() + '-A';
    const keyB = 'integration-key-' + Date.now() + '-B';

    // ── Create + restore ─────────────────────────────────────────────
    await cloudBackupService.createOrUpdateBackup({ keyHash: keyA, shopName: 'Shop A', data: '{"inventory":[1,2,3]}' });
    const restoredA = await cloudBackupService.restoreBackup(keyA);
    assert(restoredA.data === '{"inventory":[1,2,3]}' && restoredA.shopName === 'Shop A', 'create backup then restore returns the exact data written, against the real database');

    // ── Upsert overwrite (no history) ────────────────────────────────
    await cloudBackupService.createOrUpdateBackup({ keyHash: keyA, shopName: 'Shop A', data: '{"inventory":[9,9,9]}' });
    const restoredAfterOverwrite = await cloudBackupService.restoreBackup(keyA);
    assert(restoredAfterOverwrite.data === '{"inventory":[9,9,9]}', 'a second backup for the same keyHash overwrites the first — matches local.js\'s one-slot-per-license design exactly, verified against the real database');
    const rowCount = await withConnection((conn) => conn.query('SELECT COUNT(*) AS c FROM cloud_backups WHERE key_hash = ?', [keyA]));
    assert(Number(rowCount[0].c) === 1, 'the upsert produces exactly one row for keyA, not a growing history table');

    // ── Multiple independent backups + cross-key isolation ───────────
    await cloudBackupService.createOrUpdateBackup({ keyHash: keyB, shopName: 'Shop B', data: '{"inventory":["only-shop-b"]}' });
    const restoredB = await cloudBackupService.restoreBackup(keyB);
    assert(restoredB.data === '{"inventory":["only-shop-b"]}' && restoredB.shopName === 'Shop B', 'a second, independent keyHash backup is stored and restored correctly');
    const restoredAAgain = await cloudBackupService.restoreBackup(keyA);
    assert(restoredAAgain.data === '{"inventory":[9,9,9]}', 'restoring keyA after creating keyB still returns only keyA\'s own data — no cross-key data leakage');
    assert(restoredAAgain.data !== restoredB.data, 'cross-key isolation: keyA and keyB never share data, the only isolation boundary this key_hash-keyed table has (no tenant_id column exists — see migration 005\'s header)');

    // ── Corrupted/missing backup handling ────────────────────────────
    await assertThrows(() => cloudBackupService.restoreBackup('never-written-key-' + Date.now()), NotFoundError, 'restoreBackup throws NotFoundError for a keyHash with no backup row (the "missing backup" case) against the real database');

    // ── Delete + failed-restore-after-delete ─────────────────────────
    await cloudBackupService.deleteBackup(keyB);
    await assertThrows(() => cloudBackupService.restoreBackup(keyB), NotFoundError, 'restoring a deleted backup 404s — the delete was real and did not silently leave data behind');

    // deleteBackup is intentionally unconditional (no prior existence
    // check) — matches local.js:1781-1784's real DELETE exactly.
    await cloudBackupService.deleteBackup('this-key-hash-never-existed-' + Date.now());
    assert(true, 'deleteBackup on a never-existent keyHash does not throw — matches local.js\'s unconditional DELETE (always {ok:true}), preserved as-is, not "fixed" with a 404');

    // ── Recovery after simulated failure ─────────────────────────────
    // A rejected create (missing required data) must never touch any
    // prior backup for that keyHash — "Never restore partially. Abort
    // safely on failure."
    try {
      await cloudBackupService.createOrUpdateBackup({ keyHash: keyA, data: '' });
    } catch (_) { /* expected ValidationError */ }
    const stillIntact = await cloudBackupService.restoreBackup(keyA);
    assert(stillIntact.data === '{"inventory":[9,9,9]}', 'recovery after simulated failure: a rejected (invalid) create leaves the prior backup for that keyHash completely untouched — no partial write occurred');

    // ── listBackups reflects real state ──────────────────────────────
    const all = await cloudBackupRepository.listAll();
    const hashesPresent = all.map((r) => r.key_hash);
    assert(hashesPresent.includes(keyA) && !hashesPresent.includes(keyB), 'listBackups reflects the real database state after all operations above (keyA present, keyB deleted)');
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
