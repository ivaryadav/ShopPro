/**
 * platform/src/database/connection.js
 *
 * Z-SUPERADMIN's own SQLite database — a completely separate file from
 * ShopERP's shoperpro.db (or any other product's database). The platform
 * never opens a product's database directly; a product's data only ever
 * enters the platform through that product's own integration/sync path
 * (documented, not built, in this foundation milestone — see
 * platform/docs/Architecture.md).
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { loadEnv } = require('../config/env');
const { migrate } = require('./schema');

let _db = null;

function getDb(source) {
  if (_db) return _db;
  const env = loadEnv(source);
  const dbPath = path.isAbsolute(env.PLATFORM_DB_PATH) ? env.PLATFORM_DB_PATH : path.join(__dirname, '..', '..', env.PLATFORM_DB_PATH);
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  migrate(_db);
  return _db;
}

function _resetForTests() {
  if (_db) { try { _db.close(); } catch (_) {} }
  _db = null;
}

module.exports = { getDb, _resetForTests };
