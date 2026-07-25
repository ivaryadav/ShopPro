#!/usr/bin/env node
/**
 * server/src/scripts/backupVerify.js
 *
 * MariaDB-native port of server/scripts/backup-verify.js (same operator
 * command, same "create a real backup, then actually verify it by
 * restoring it" methodology), applied to the new database engine — not a
 * new capability. On-demand only, NOT a scheduled job, same as the
 * original (mission's "Scheduled backup support (if already exists)" —
 * it doesn't, in either the SQLite or MariaDB version, so none is added).
 *
 * Usage:
 *   node server/src/scripts/backupVerify.js [--out <dir>]
 *
 *   --out   Directory to write the .sql dump into. Defaults to
 *           server/backups (same default the SQLite version uses).
 *
 * Exit code 0 on a verified-good backup, 1 on any failure (dump failure,
 * restore failure, CHECK TABLE failure, or a row-count mismatch) — same
 * contract as backup-verify.js, so a deploy script can chain either
 * version identically.
 */
'use strict';

const path = require('path');
const { getLogger } = require('../logging');
const { createBackup, verifyBackup } = require('../services/databaseBackupService');

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

async function main() {
  const logger = getLogger();
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out || path.join(__dirname, '..', '..', 'backups');

  let backup;
  try {
    backup = await createBackup({ outDir });
  } catch (e) {
    logger.error('MariaDB backup dump failed', { error: e.message });
    process.exit(1);
    return;
  }

  try {
    const result = await verifyBackup(backup.destPath);
    if (!result.ok) {
      logger.error('MariaDB backup integrity check FAILED', {
        path: backup.destPath,
        missingTables: result.missingTables,
        checkTableFailures: result.checkTableFailures,
        countMismatches: result.countMismatches,
      });
      process.exit(1);
      return;
    }
    logger.info('MariaDB backup created and verified', {
      backup: backup.destPath,
      sizeBytes: backup.sizeBytes,
      tables: result.tables.length,
      integrityCheck: 'ok',
    });
    process.exit(0);
  } catch (e) {
    logger.error('Could not verify MariaDB backup integrity', { path: backup.destPath, error: e.message });
    process.exit(1);
  }
}

main();
