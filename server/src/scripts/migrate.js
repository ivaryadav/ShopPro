#!/usr/bin/env node
/**
 * server/src/scripts/migrate.js
 *
 * Migration CLI for the MariaDB backend (ADR-0002). Requires a reachable
 * MariaDB instance configured via the environment (see
 * server/src/config/database.js) — this script does not start one.
 *
 * Usage:
 *   node server/src/scripts/migrate.js up
 *   node server/src/scripts/migrate.js down [steps]     (default steps: 1)
 *   node server/src/scripts/migrate.js status
 */
'use strict';

const { getPool, migrateUp, migrateDown, getAppliedMigrations, closePool } = require('../database');
const { getLogger } = require('../logging');

async function main() {
  const [, , command, arg] = process.argv;
  const logger = getLogger();
  const pool = getPool();

  try {
    if (command === 'up') {
      const results = await migrateUp(pool);
      for (const r of results) {
        logger.info(`Migration ${r.version}_${r.name}: ${r.action}`);
      }
      const appliedCount = results.filter((r) => r.action === 'applied').length;
      logger.info(`Migration up complete. ${appliedCount} newly applied, ${results.length - appliedCount} already up to date.`);
    } else if (command === 'down') {
      const steps = arg ? Number(arg) : 1;
      if (!Number.isInteger(steps) || steps < 1) {
        throw new Error(`Invalid steps argument '${arg}' — must be a positive integer.`);
      }
      const reverted = await migrateDown(pool, steps);
      for (const r of reverted) {
        logger.info(`Rolled back ${r.version}_${r.name}`);
      }
      logger.info(`Migration down complete. ${reverted.length} migration(s) reverted.`);
    } else if (command === 'status') {
      const conn = await pool.getConnection();
      try {
        const applied = await getAppliedMigrations(conn);
        if (applied.size === 0) {
          logger.info('No migrations applied yet.');
        } else {
          for (const [version, row] of applied) {
            logger.info(`${version}_${row.name} — applied ${row.applied_at}`);
          }
        }
      } finally {
        await conn.release();
      }
    } else {
      console.error('Usage: node migrate.js <up|down|status> [steps]');
      process.exitCode = 1;
    }
  } catch (e) {
    logger.fatal(`Migration command failed: ${e.message}`, { stack: e.stack });
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
