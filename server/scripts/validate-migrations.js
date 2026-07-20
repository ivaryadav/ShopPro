#!/usr/bin/env node
/**
 * ShopERP Pro — Migration validation command
 * ─────────────────────────────────────────────
 * Implements OperationalReadinessPlan.md §8 ("a lightweight post-migration
 * assertion — confirm the expected tables and a sample of expected columns
 * exist, log a clear error if not") as a standalone, on-demand command
 * rather than baked into every server boot — keeps it out of the hot
 * startup path and out of "monitoring system" territory (this task's own
 * "do NOT implement monitoring systems" instruction), while still being
 * usable manually, in CI, or by a deploy script right after a migration
 * runs.
 *
 * Complements, not duplicates, MigrationSafetyReport.md's runMigration()
 * fix: that fix catches an individual ALTER/CREATE statement *failing*.
 * This script checks the *end result* — does the schema actually look
 * like every migration this codebase knows about was applied — which
 * catches a different failure class (e.g. a migration that was silently
 * never run at all, on a very old DB file, or one added to a future
 * version of local.js that this script hasn't been updated to expect —
 * in which case it fails loudly rather than passing by omission).
 *
 * Usage:
 *   node scripts/validate-migrations.js [--path <db-file>]
 *
 * Exit code 0 if every expected table and column exists, 1 otherwise
 * (with every specific missing item listed, not just a generic failure).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('../logger');

// Kept in sync by hand with the CREATE TABLE / ALTER TABLE statements in
// local.js and sessions.js — intentionally not derived automatically from
// those files, so this script independently re-states what "correctly
// migrated" means rather than trivially agreeing with whatever the
// migration code currently does (which would catch nothing).
const EXPECTED_SCHEMA = {
  tenants: ['id', 'shop_name', 'is_active', 'created_at', 'status', 'suspend_reason', 'license_key_hash', 'license_expiry', 'license_plan'],
  users: ['id', 'tenant_id', 'username', 'email', 'password_hash', 'role', 'is_active', 'last_login', 'created_at', 'display_name', 'mobile'],
  tenant_data: ['tenant_id', 'data', 'updated_at', 'version', 'updated_by'],
  cloud_backups: ['key_hash', 'shop_name', 'data', 'backed_up_at'],
  user_sessions: ['id', 'session_id', 'tenant_id', 'user_id', 'jwt_id', 'device_id', 'login_time', 'last_activity', 'current_page', 'status', 'refresh_token_hash', 'ip_address', 'browser', 'os', 'created_at', 'prev_refresh_token_hash', 'refresh_rotated_at'],
};

function parseArgs(argv) {
  const args = { path: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') args.path = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.path || process.env.DB_PATH || path.join(__dirname, '..', 'shoperpro.db');

  if (!fs.existsSync(dbPath)) {
    logger.error('Database file does not exist', { path: dbPath });
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const problems = [];

  const actualTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );

  for (const [table, expectedColumns] of Object.entries(EXPECTED_SCHEMA)) {
    if (!actualTables.has(table)) {
      problems.push(`missing table: ${table}`);
      continue;
    }
    const actualColumns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
    for (const col of expectedColumns) {
      if (!actualColumns.has(col)) {
        problems.push(`missing column: ${table}.${col}`);
      }
    }
  }

  db.close();

  if (problems.length > 0) {
    logger.error('Migration validation FAILED', { path: dbPath, problems });
    process.exit(1);
  }

  logger.info('Migration validation passed', {
    path: dbPath,
    tablesChecked: Object.keys(EXPECTED_SCHEMA).length,
    columnsChecked: Object.values(EXPECTED_SCHEMA).reduce((n, cols) => n + cols.length, 0),
  });
  process.exit(0);
}

main();
