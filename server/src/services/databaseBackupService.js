/**
 * server/src/services/databaseBackupService.js
 *
 * MariaDB-native analog of server/scripts/backup-verify.js, ported for
 * ADR-0002's "MariaDB is the sole database engine" — the SAME operational
 * practice (create a real backup, then actually verify it by restoring
 * it and checking the result matches), applied to the new database
 * engine, not a new capability invented here. Uses `mysqldump`/`mysql`
 * (aliased as `mariadb-dump`/`mariadb` on this project's toolchain) —
 * standard, already-available MariaDB client tools, not a new dependency
 * (mission: "DO NOT introduce new technologies").
 *
 * Like backup-verify.js, this is an ON-DEMAND capability an operator (or
 * a deploy script) runs when they want one — NOT a scheduled job. No
 * scheduled-backup support exists for the SQLite version either
 * (confirmed by reading it), so none is invented here.
 *
 * Credentials are never passed as CLI arguments (visible in `ps` output
 * on a shared machine) — a temporary `--defaults-extra-file` is written
 * with 0600 permissions and deleted in a `finally` block, even on error.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { getDatabaseConfig } = require('../config/database');
const { withConnection } = require('../database');
const { InfrastructureError } = require('../errors');

/** @param {object} config @returns {string} path to a 0600 temp options file, caller must delete it */
function writeDefaultsFile(config) {
  const filePath = path.join(os.tmpdir(), `shoperpro-db-backup-${crypto.randomBytes(8).toString('hex')}.cnf`);
  const contents = `[client]\nhost=${config.host}\nport=${config.port}\nuser=${config.user}\npassword=${config.password}\n`;
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  return filePath;
}

/** @param {string} cmd @param {string[]} args @returns {Promise<{stdout:string,stderr:string}>} */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 200 }, (error, stdout, stderr) => {
      if (error) return reject(new InfrastructureError(`${cmd} failed: ${stderr || error.message}`));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Matches backup-verify.js's create step, for MariaDB: a full SQL dump of
 * the configured database via mysqldump.
 * @param {{outDir:string, source?: NodeJS.ProcessEnv}} params
 * @returns {Promise<{destPath:string, sizeBytes:number}>}
 */
async function createBackup({ outDir, source } = {}) {
  const config = getDatabaseConfig(source);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const destPath = path.join(outDir, `shoperpro_mariadb_backup_${ts}.sql`);

  const defaultsFile = writeDefaultsFile(config);
  try {
    const { stdout } = await run('mysqldump', [
      `--defaults-extra-file=${defaultsFile}`,
      '--single-transaction', '--routines', '--triggers', config.database,
    ]);
    fs.writeFileSync(destPath, stdout);
  } finally {
    fs.unlinkSync(defaultsFile);
  }

  const stat = fs.statSync(destPath);
  return { destPath, sizeBytes: stat.size };
}

/** @param {number} tenantIdUnused placeholder to keep lint quiet — not used */
async function tableRowCounts(databaseName, source) {
  return withConnection(async (conn) => {
    const tables = await conn.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [databaseName]);
    const counts = {};
    for (const t of tables) {
      const rows = await conn.query(`SELECT COUNT(*) AS c FROM \`${t.name}\``);
      counts[t.name] = Number(rows[0].c);
    }
    return counts;
  }, source);
}

/**
 * Matches backup-verify.js's verify step, adapted for MariaDB: restores
 * the dump into a SCRATCH database (never overwrites the real one — "Never
 * overwrite production data without verification"), runs CHECK TABLE on
 * every restored table, and compares row counts against the live source
 * database. Drops the scratch database afterward either way.
 * @param {string} dumpPath @param {{source?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{ok:boolean, tables:string[], missingTables:string[], checkTableFailures:string[], countMismatches:object[]}>}
 */
async function verifyBackup(dumpPath, { source } = {}) {
  const config = getDatabaseConfig(source);
  const scratchDb = `shoperpro_backup_verify_${crypto.randomBytes(6).toString('hex')}`;
  const defaultsFile = writeDefaultsFile(config);

  try {
    await run('mysql', [`--defaults-extra-file=${defaultsFile}`, '-e', `CREATE DATABASE \`${scratchDb}\``]);
    try {
      // Restore the dump into the scratch database via a shell pipe —
      // mysql has no "--database-file" flag, it reads SQL from stdin.
      await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const child = spawn('mysql', [`--defaults-extra-file=${defaultsFile}`, scratchDb]);
        const dumpStream = fs.createReadStream(dumpPath);
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        dumpStream.pipe(child.stdin);
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new InfrastructureError(`mysql restore failed: ${stderr}`))));
      });

      const tables = (await withConnection(
        (conn) => conn.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [scratchDb]),
        source
      )).map((r) => r.name);

      // A truncated/corrupted dump can restore a valid PREFIX of tables and
      // silently stop partway through (mysql aborts the whole stdin stream
      // on the first parse error) — every table that DID make it in can
      // pass its own CHECK TABLE / row-count check while entire tables are
      // simply absent. Comparing against the live table SET is what catches
      // that; per-table checks alone cannot.
      const liveTables = (await withConnection(
        (conn) => conn.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [config.database]),
        source
      )).map((r) => r.name);
      const restoredSet = new Set(tables);
      const missingTables = liveTables.filter((t) => !restoredSet.has(t));

      const checkTableFailures = [];
      for (const table of tables) {
        const result = await withConnection((conn) => conn.query(`CHECK TABLE \`${scratchDb}\`.\`${table}\``), source);
        const bad = result.some((r) => String(r.Msg_text).toLowerCase() !== 'ok');
        if (bad) checkTableFailures.push(table);
      }

      const liveCounts = await tableRowCounts(config.database, source);
      const scratchCounts = await tableRowCounts(scratchDb, source);
      const countMismatches = [];
      for (const table of tables) {
        if (liveCounts[table] !== scratchCounts[table]) {
          countMismatches.push({ table, live: liveCounts[table], restored: scratchCounts[table] });
        }
      }

      const ok = missingTables.length === 0 && checkTableFailures.length === 0 && countMismatches.length === 0;
      return { ok, tables, missingTables, checkTableFailures, countMismatches };
    } finally {
      await run('mysql', [`--defaults-extra-file=${defaultsFile}`, '-e', `DROP DATABASE IF EXISTS \`${scratchDb}\``]);
    }
  } finally {
    fs.unlinkSync(defaultsFile);
  }
}

module.exports = { createBackup, verifyBackup };
