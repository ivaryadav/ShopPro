/**
 * server/src/database/index.js — single import point for MariaDB
 * connection management, health checks, and the migration runner.
 */
'use strict';

const { getPool, withConnection, closePool, _resetForTests } = require('./connection');
const { checkDatabaseHealth } = require('./healthCheck');
const {
  discoverMigrations,
  computeChecksum,
  getAppliedMigrations,
  migrateUp,
  migrateDown,
  MIGRATIONS_DIR,
} = require('./migrationRunner');

module.exports = {
  getPool,
  withConnection,
  closePool,
  checkDatabaseHealth,
  discoverMigrations,
  computeChecksum,
  getAppliedMigrations,
  migrateUp,
  migrateDown,
  MIGRATIONS_DIR,
  _resetForTests,
};
