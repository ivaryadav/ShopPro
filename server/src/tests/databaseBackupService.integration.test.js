/**
 * RC1 Sprint 3 integration test — services/databaseBackupService.js (Part
 * B: the MariaDB-native operational backup/verify tool, analog of
 * server/scripts/backup-verify.js). Exercises the REAL mysqldump/mysql
 * CLI tools against a REAL MariaDB database: create a dump, verify it by
 * restoring into a scratch database and comparing, then deliberately
 * corrupt the dump file and confirm verifyBackup catches it (never a
 * silent pass).
 *
 * Same honest-skip pattern as every other integration test in this
 * project — additionally skips if mysqldump/mysql CLI binaries are not
 * on PATH (a separate, independently-checked precondition from DB
 * reachability).
 *
 * Usage: node server/src/tests/databaseBackupService.integration.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests, withConnection } = require('../database');
const { createBackup, verifyBackup } = require('../services/databaseBackupService');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function skip(label, reason) { skipped++; console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason); }

const TEST_DB_CONFIG = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_phase6_test',
};

function hasCliTools() {
  try {
    execFileSync('mysqldump', ['--version'], { stdio: 'ignore' });
    execFileSync('mysql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  console.log('RC1 Sprint 3 integration test: databaseBackupService.js (Part B) against real MariaDB + real mysqldump/mysql');
  console.log('');

  const labels = [
    'createBackup produces a real .sql dump file containing INSERT statements for cloud_backups',
    'verifyBackup restores the dump into a scratch database and reports ok:true with matching row counts',
    'verifyBackup catches a corrupted (truncated) dump and reports ok:false, never a silent pass',
    'verifyBackup cleans up its scratch database even after a failed restore',
  ];

  if (!hasCliTools()) {
    for (const label of labels) skip(label, 'mysqldump/mysql CLI tools not found on PATH');
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(0);
  }

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);
  if (!health.ok) {
    for (const label of labels) skip(label, `no reachable/authenticated database: ${health.error}`);
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoperpro-backup-verify-test-'));
  try {
    await migrateUp(pool);
    const keyHash = 'backup-verify-integration-' + Date.now();
    await withConnection((conn) =>
      conn.query('INSERT INTO cloud_backups (key_hash, shop_name, data) VALUES (?, ?, ?)', [keyHash, 'Backup Verify Test Shop', '{"sample":"data"}'])
    );

    const backup = await createBackup({ outDir, source: TEST_DB_CONFIG });
    assert(fs.existsSync(backup.destPath) && backup.sizeBytes > 0, 'createBackup produces a real .sql dump file containing INSERT statements for cloud_backups');
    const dumpContents = fs.readFileSync(backup.destPath, 'utf8');
    assert(dumpContents.includes('cloud_backups') && dumpContents.includes(keyHash), 'the dump file genuinely contains the cloud_backups table and the row just inserted');

    const verifyResult = await verifyBackup(backup.destPath, { source: TEST_DB_CONFIG });
    assert(verifyResult.ok === true, 'verifyBackup restores the dump into a scratch database and reports ok:true with matching row counts');
    assert(verifyResult.missingTables.length === 0, 'verifyBackup finds zero missing tables when restoring a complete, uncorrupted dump');
    assert(verifyResult.checkTableFailures.length === 0, 'verifyBackup finds zero CHECK TABLE failures on a clean, freshly-restored dump');
    assert(verifyResult.countMismatches.length === 0, 'verifyBackup finds zero row-count mismatches between the live database and the restored scratch copy');

    // ── Corrupted dump detection ──────────────────────────────────────
    const corruptedPath = path.join(outDir, 'corrupted.sql');
    const truncated = dumpContents.slice(0, Math.floor(dumpContents.length / 2)) + "\n-- TRUNCATED, INVALID SQL BEYOND THIS POINT ;;; garbage(((";
    fs.writeFileSync(corruptedPath, truncated);
    let corruptedResultOk = null, corruptedMissingTables = null;
    try {
      const corruptedResult = await verifyBackup(corruptedPath, { source: TEST_DB_CONFIG });
      corruptedResultOk = corruptedResult.ok;
      corruptedMissingTables = corruptedResult.missingTables;
    } catch (e) {
      // A truncated dump may also fail outright at the `mysql` restore
      // step (a thrown InfrastructureError) rather than restoring
      // partially and failing verification — both are an acceptable
      // "never a silent pass" outcome; only a resolved ok:true would be a bug.
      corruptedResultOk = false;
    }
    assert(corruptedResultOk === false, 'verifyBackup catches a corrupted (truncated) dump and reports ok:false (or throws) — never a silent pass, even when every table that DID restore individually passes its own CHECK TABLE/row-count check');
    if (corruptedMissingTables !== null) {
      assert(corruptedMissingTables.length > 0, 'verifyBackup specifically identifies the tables missing entirely from a truncated restore, not just a generic ok:false');
    }

    // ── Scratch database cleanup verification ─────────────────────────
    const leftoverScratchDbs = await withConnection((conn) =>
      conn.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'shoperpro_backup_verify_%'")
    );
    assert(leftoverScratchDbs.length === 0, 'verifyBackup cleans up its scratch database even after a failed restore — no shoperpro_backup_verify_* database left behind');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
