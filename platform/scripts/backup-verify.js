#!/usr/bin/env node
/**
 * Z-SUPERADMIN — Backup verification command
 * ────────────────────────────────────────────
 * Formalizes the manual `sqlite3 <db> ".backup <copy>"` + `PRAGMA
 * integrity_check` sequence into a single command an operator (or a
 * deploy/cron script) runs on demand — mirrors server/scripts/backup-verify.js's
 * established pattern exactly, adapted for platform.db. NOT a scheduled
 * job — Z-SUPERADMIN's own Job Runner is reserved for Z-SUPERADMIN's own
 * business logic (license/maintenance/webhook jobs), not host-level backup
 * scheduling, which belongs to the operator's own cron/systemd timer.
 *
 * Usage:
 *   node scripts/backup-verify.js [--path <db-file>] [--out <dir>]
 *
 *   --path   DB file to back up. Defaults to PLATFORM_DB_PATH env var,
 *            then platform/platform.db (same resolution order server.js uses).
 *   --out    Directory to write the backup into. Defaults to
 *            platform/backups (created if missing).
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
  const srcPath = args.path || process.env.PLATFORM_DB_PATH || path.join(__dirname, '..', 'platform.db');
  const outDir = args.out || path.join(__dirname, '..', 'backups');

  if (!fs.existsSync(srcPath)) {
    console.error(`[BACKUP] Source database does not exist: ${srcPath}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const destPath = path.join(outDir, `platform_manual_backup_${ts}.db`);

  let srcDb;
  try {
    srcDb = new Database(srcPath, { readonly: true });
  } catch (e) {
    console.error(`[BACKUP] Could not open source database: ${e.message}`);
    process.exit(1);
  }

  try {
    // better-sqlite3's own .backup() — the same WAL-aware, SQLite-API-level
    // copy mechanism as the CLI's ".backup" command, safe against a live
    // WAL-mode database in a way a raw file `cp` is not.
    srcDb.backup(destPath).then(() => {
      srcDb.close();
      verify(destPath, srcPath);
    }).catch((e) => {
      srcDb.close();
      console.error(`[BACKUP] Backup write failed: ${e.message}`);
      process.exit(1);
    });
  } catch (e) {
    srcDb.close();
    console.error(`[BACKUP] Backup write failed: ${e.message}`);
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
      console.error(`[BACKUP] Backup integrity check FAILED for ${destPath}: ${JSON.stringify(result)}`);
      process.exit(1);
    }
    const stat = fs.statSync(destPath);
    console.log(`[BACKUP] Backup created and verified. source=${srcPath} backup=${destPath} sizeBytes=${stat.size} integrityCheck=ok`);
    process.exit(0);
  } catch (e) {
    if (destDb) try { destDb.close(); } catch (_) { /* already closed */ }
    console.error(`[BACKUP] Could not verify backup integrity: ${e.message}`);
    process.exit(1);
  }
}

main();
