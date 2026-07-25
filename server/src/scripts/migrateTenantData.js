#!/usr/bin/env node
/**
 * server/src/scripts/migrateTenantData.js
 *
 * CLI for the JSON-to-Relational migration tool
 * (migrationTools/jsonToRelational/). Deliberately requires the source
 * blob as a JSON FILE PATH, not a live read from server/local.js's
 * shoperpro.db — this script has no SQLite dependency and never touches
 * the production database directly. Extracting a tenant's
 * tenant_data.data JSON into a file is a separate, explicit step left to
 * whoever runs this (e.g. `sqlite3 shoperpro.db "SELECT data FROM
 * tenant_data WHERE tenant_id=X" > tenant_5.json`) — keeping this tool
 * fully decoupled from the live database it's migrating away from.
 *
 * Usage:
 *   node src/scripts/migrateTenantData.js dry-run <tenantId> <blobJsonPath>
 *   node src/scripts/migrateTenantData.js migrate <tenantId> <blobJsonPath> [--report=path.md]
 *   node src/scripts/migrateTenantData.js rollback <tenantId>
 *
 * Requires the same DB_* environment variables as migrate.js.
 */
'use strict';

const fs = require('fs');
const { getPool, closePool } = require('../database');
const { migrateTenant, rollbackTenant } = require('../migrationTools/jsonToRelational/migrationService');
const { getLogger } = require('../logging');

async function main() {
  const [, , command, ...args] = process.argv;
  const logger = getLogger();

  if (!['dry-run', 'migrate', 'rollback'].includes(command)) {
    console.error('Usage:\n' +
      '  node src/scripts/migrateTenantData.js dry-run <tenantId> <blobJsonPath>\n' +
      '  node src/scripts/migrateTenantData.js migrate <tenantId> <blobJsonPath> [--report=path.md]\n' +
      '  node src/scripts/migrateTenantData.js rollback <tenantId>');
    process.exit(1);
  }

  getPool(); // fail fast if DB config is invalid, before doing any file I/O

  try {
    if (command === 'rollback') {
      const tenantId = Number(args[0]);
      if (!tenantId) throw new Error('rollback requires a numeric tenantId');
      await rollbackTenant(tenantId);
      logger.info(`Rolled back all Operations-domain rows for tenant ${tenantId}.`);
      return;
    }

    const tenantId = Number(args[0]);
    const blobPath = args[1];
    if (!tenantId || !blobPath) throw new Error(`${command} requires <tenantId> <blobJsonPath>`);
    const blob = JSON.parse(fs.readFileSync(blobPath, 'utf8'));

    const result = await migrateTenant(tenantId, blob, { dryRun: command === 'dry-run' });
    console.log(result.markdown);

    const reportArg = args.find((a) => a.startsWith('--report='));
    if (reportArg) {
      const reportPath = reportArg.slice('--report='.length);
      fs.writeFileSync(reportPath, result.markdown);
      logger.info(`Reconciliation report written to ${reportPath}`);
    }

    if (result.integrity && !result.integrity.ok) {
      logger.error('Integrity verification FAILED — see mismatches above.');
      process.exitCode = 1;
    }
  } catch (e) {
    logger.error(`[migrateTenantData] ${e.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
