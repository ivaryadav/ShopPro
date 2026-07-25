/**
 * server/src/database/ tests. Originally written in Phase 1 against two
 * placeholder proof-of-concept migrations (001_initial/002_example) —
 * updated in Phase 2, exactly as Phase 1's own database/README.md
 * predicted ("Phase 2 replaces them with the real first migrations...
 * this placeholder table is dropped"), to exercise the real
 * 001_identity_tenant_core migration instead. The framework logic under
 * test (discovery, checksums, apply/rollback) is unchanged from Phase 1;
 * only the fixture migration it points at has.
 *
 * Splits cleanly into two parts:
 * 1. Pure logic (migration file discovery, checksum computation) — always
 *    runs, no database required.
 * 2. Real MariaDB integration (connect, migrate up, verify, roll back) —
 *    attempts a real connection first and SKIPS with a clear message if
 *    none is reachable/authenticated, rather than failing the whole suite
 *    or faking a pass. Same honest-skip situation as Phase 1: a MySQL
 *    server is running on this machine but this session has no
 *    credentials to it.
 *
 * Usage: node server/src/tests/database.test.js
 */
'use strict';

const { discoverMigrations, computeChecksum } = require('../database/migrationRunner');
const { getPool, migrateUp, migrateDown, getAppliedMigrations, checkDatabaseHealth, closePool, _resetForTests } = require('../database');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function skip(label, reason) {
  skipped++;
  console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason);
}

async function main() {
  console.log('Phase 2: database/ tests (migration framework against the real identity-core migration)');
  console.log('');

  // ── Part 1: pure logic, always runs ────────────────────────────────────
  const migrations = discoverMigrations();
  assert(migrations.length === 1, "discoverMigrations finds exactly the 1 real migration (001_identity_tenant_core) — the Phase 1 placeholders were replaced, not left alongside it");
  assert(migrations[0].version === '001' && migrations[0].name === 'identity_tenant_core', 'migration 001 is discovered with the correct name');

  const checksumA = computeChecksum('CREATE TABLE x (id INT);');
  const checksumB = computeChecksum('CREATE TABLE x (id INT);');
  const checksumC = computeChecksum('CREATE TABLE y (id INT);');
  assert(checksumA === checksumB, 'computeChecksum is deterministic for identical content');
  assert(checksumA !== checksumC, 'computeChecksum differs for different content');
  assert(/^[a-f0-9]{64}$/.test(checksumA), 'computeChecksum returns a sha256 hex digest');

  // ── Part 2: real MariaDB integration, if reachable ─────────────────────
  _resetForTests();
  const health = await checkDatabaseHealth({
    DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'shoperpro_phase2_test',
  });

  if (!health.ok) {
    skip('migrateUp() applies the identity-core schema', `no reachable/authenticated database: ${health.error}`);
    skip('re-running migrateUp() reports already-applied, applies nothing new', 'depends on the above');
    skip('migrateDown() reverts the migration cleanly', 'depends on the above');
    console.log('');
    console.log(
      '  Note: a MySQL/MariaDB server IS installed and running on this machine (via brew services),\n' +
      '  but no accessible credentials were available to this session, and this session did not\n' +
      '  attempt to bypass or reset another user\'s pre-existing database authentication. This is\n' +
      '  the expected, honest result in this environment — it is not evidence the migration\n' +
      '  framework itself is broken (Part 1 above exercises all of its non-DB-dependent logic\n' +
      '  directly, and server/src/tests/identityCore.integration.test.js exercises the full\n' +
      '  repository/service stack against this same schema). Re-run this file against a real,\n' +
      '  credentialed MariaDB instance to exercise Part 2 for real before Phase 3 relies on it.'
    );
  } else {
    _resetForTests();
    const pool = getPool({ DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'shoperpro_phase2_test' });
    try {
      const upResult = await migrateUp(pool);
      assert(upResult.filter((r) => r.action === 'applied').length === 1 || upResult.every((r) => r.action === 'already-applied'), 'migrateUp() applies the identity-core migration on a fresh database (or reports already-applied on a reused one)');

      const upAgain = await migrateUp(pool);
      assert(upAgain.every((r) => r.action === 'already-applied'), 're-running migrateUp() reports everything already-applied, applies nothing twice');

      const conn = await pool.getConnection();
      const applied = await getAppliedMigrations(conn);
      await conn.release();
      assert(applied.size === 1, 'schema_migrations records exactly 1 applied migration');

      const downResult = await migrateDown(pool, 1);
      assert(downResult.length === 1 && downResult[0].version === '001', 'migrateDown(1) reverts the identity-core migration cleanly');
    } finally {
      await closePool();
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
