#!/usr/bin/env node
/**
 * ShopERP Pro — Backup verification command
 * ────────────────────────────────────────────
 * Formalizes the manual `sqlite3 <db> ".backup <copy>"` + `PRAGMA
 * integrity_check` sequence this engagement has run by hand at every prior
 * migration/cleanup in docs/architecture-review/. An on-demand command an
 * operator (or a deploy script) runs when they want one — NOT a scheduled
 * job (OperationalReadinessPlan.md §3's "automated, scheduled backup" is a
 * distinct, larger recommendation, explicitly not implemented here per
 * this task's "do NOT implement monitoring systems" instruction; this
 * script is the building block such a scheduler could call, not the
 * scheduler itself).
 *
 * Usage:
 *   node scripts/backup-verify.js [--path <db-file>] [--out <dir>]
 *
 *   --path   DB file to back up. Defaults to DB_PATH env var, then
 *            server/shoperpro.db (same resolution order local.js uses).
 *   --out    Directory to write the backup into. Defaults to
 *            server/backups (created if missing).
 *
 * Exit code 0 on a verified-good backup, 1 on any failure (source DB
 * unreadable, backup write failure, or a failed integrity check) — so
 * `node scripts/backup-verify.js || echo "backup problem"` works in a
 * deploy script without extra parsing.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('../logger');

function parseArgs(argv) {
  const args = { path: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') args.path = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const srcPath = args.path || process.env.DB_PATH || path.join(__dirname, '..', 'shoperpro.db');
  const outDir = args.out || path.join(__dirname, '..', 'backups');

  if (!fs.existsSync(srcPath)) {
    logger.error('Backup source database does not exist', { path: srcPath });
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const destPath = path.join(outDir, `shoperpro_manual_backup_${ts}.db`);

  let srcDb, destDb;
  try {
    srcDb = new Database(srcPath, { readonly: true });
  } catch (e) {
    logger.error('Could not open source database', { path: srcPath, error: e.message });
    process.exit(1);
  }

  try {
    // better-sqlite3's own .backup() — the same WAL-aware, SQLite-API-level
    // copy mechanism as the CLI's ".backup" command (see
    // OrphanCleanupExecutionReport.md's methodology note on why a raw file
    // `cp` is NOT equivalent to this for a WAL-mode database).
    srcDb.backup(destPath).then(() => {
      srcDb.close();
      verify(destPath, srcPath);
    }).catch(e => {
      srcDb.close();
      logger.error('Backup write failed', { error: e.message });
      process.exit(1);
    });
  } catch (e) {
    srcDb.close();
    logger.error('Backup write failed', { error: e.message });
    process.exit(1);
  }
}

function verify(destPath, srcPath) {
  let destDb;
  try {
    destDb = new Database(destPath, { readonly: true });
    const result = destDb.pragma('integrity_check');
    destDb.close();
    const ok = result.length === 1 && result[0].integrity_check === 'ok';
    if (!ok) {
      logger.error('Backup integrity check FAILED', { path: destPath, result });
      process.exit(1);
    }
    const stat = fs.statSync(destPath);
    logger.info('Backup created and verified', {
      source: srcPath, backup: destPath, sizeBytes: stat.size, integrityCheck: 'ok',
    });
    process.exit(0);
  } catch (e) {
    if (destDb) try { destDb.close(); } catch (_) {}
    logger.error('Could not verify backup integrity', { path: destPath, error: e.message });
    process.exit(1);
  }
}

main();
