/**
 * server/src/database/migrationRunner.js
 *
 * Version-controlled migration framework for the MariaDB backend
 * (ADR-0002). Deliberately dependency-free (matching this project's
 * established convention — see env.js's header) rather than adopting a
 * third-party migration library; this project's needs (ordered SQL files,
 * up/down, a version-history table, checksum integrity) don't yet justify
 * that dependency.
 *
 * Migration files live in server/src/database/migrations/ as pairs:
 *   NNN_name.sql            — the "up" migration, applied in order
 *   NNN_name.rollback.sql   — the matching "down" migration
 *
 * Supports:
 *   - Up: applies every migration not yet recorded in `schema_migrations`.
 *   - Rollback: reverts the most recently applied N migrations via their
 *     paired .rollback.sql file.
 *   - Version history: `schema_migrations` records version, name,
 *     checksum, and when it was applied.
 *   - Checksums: an already-applied migration whose on-disk file content
 *     has since changed is a loud, fail-fast error — never silently
 *     re-applied or ignored, since that would mean the database and the
 *     migration history no longer agree on what was actually run.
 *
 * NOT wired into server/local.js's own additive-migration system
 * (runMigration() in that file) — that system continues to govern
 * SQLite's schema exactly as it always has, unaffected by this framework.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseError } = require('../errors/DatabaseError');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const ROLLBACK_SUFFIX = '.rollback.sql';

/** @param {string} content @returns {string} sha256 hex digest */
function computeChecksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * @param {string} [dir]
 * @returns {Array<{ version: string, name: string, upFile: string, rollbackFile: string }>}
 *   Sorted ascending by version (numeric prefix, e.g. "001" < "002").
 */
function discoverMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  // Matches "NNN_name.sql" from the start of the filename only — this
  // deliberately excludes anything that doesn't begin with digits (README
  // files, and critically the macOS AppleDouble "._NNN_name.sql" shadow
  // files this project's external-volume working copy generates
  // throughout the repo — see docs/independent-audit/RepositoryReview.md).
  // A stray non-migration file silently isn't a migration; it does not
  // fail migration discovery.
  const MIGRATION_PATTERN = /^(\d+)_(.+)\.sql$/;
  const files = fs.readdirSync(dir).filter((f) => MIGRATION_PATTERN.test(f) && !f.endsWith(ROLLBACK_SUFFIX));
  return files
    .map((file) => {
      const match = file.match(MIGRATION_PATTERN);
      const [, version, name] = match;
      const rollbackFile = file.replace(/\.sql$/, ROLLBACK_SUFFIX);
      if (!fs.existsSync(path.join(dir, rollbackFile))) {
        throw new Error(`[Migrations] '${file}' has no matching rollback file '${rollbackFile}'.`);
      }
      return { version, name, upFile: file, rollbackFile };
    })
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

/** Ensures the schema_migrations tracking table exists — idempotent, safe to call every run. */
async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(20) PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      checksum   VARCHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * @param {import('mariadb').Connection} conn
 * @returns {Promise<Map<string, { name: string, checksum: string, applied_at: Date }>>}
 */
async function getAppliedMigrations(conn) {
  await ensureMigrationsTable(conn);
  const rows = await conn.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC');
  return new Map(rows.map((r) => [r.version, r]));
}

/**
 * Applies every migration not yet recorded, in ascending version order.
 * Each migration runs inside its own transaction — a failure partway
 * through one migration rolls back that migration only, and stops before
 * attempting the next.
 * @param {import('mariadb').Pool} pool
 * @param {string} [dir]
 * @returns {Promise<Array<{ version: string, name: string, action: 'applied'|'already-applied' }>>}
 */
async function migrateUp(pool, dir = MIGRATIONS_DIR) {
  const migrations = discoverMigrations(dir);
  const results = [];
  const conn = await pool.getConnection();
  try {
    const applied = await getAppliedMigrations(conn);

    for (const migration of migrations) {
      const upContent = fs.readFileSync(path.join(dir, migration.upFile), 'utf8');
      const checksum = computeChecksum(upContent);
      const existing = applied.get(migration.version);

      if (existing) {
        if (existing.checksum !== checksum) {
          throw new DatabaseError(
            `[Migrations] Checksum mismatch for already-applied migration ${migration.version}_${migration.name}: ` +
            `the file on disk has changed since it was applied. Never edit an applied migration — add a new one instead.`
          );
        }
        results.push({ version: migration.version, name: migration.name, action: 'already-applied' });
        continue;
      }

      await conn.beginTransaction();
      try {
        // Multiple statements in one migration file are supported by
        // splitting on ';' — a deliberately simple approach; migrations
        // should avoid semicolons inside string literals or stored routines.
        const statements = upContent.split(';').map((s) => s.trim()).filter(Boolean);
        for (const statement of statements) {
          await conn.query(statement);
        }
        await conn.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)',
          [migration.version, migration.name, checksum]
        );
        await conn.commit();
        results.push({ version: migration.version, name: migration.name, action: 'applied' });
      } catch (e) {
        await conn.rollback();
        throw new DatabaseError(`[Migrations] Failed applying ${migration.version}_${migration.name}: ${e.message}`, e);
      }
    }
    return results;
  } finally {
    await conn.release();
  }
}

/**
 * Reverts the N most recently applied migrations, in reverse order, via
 * their paired .rollback.sql file.
 * @param {import('mariadb').Pool} pool
 * @param {number} [steps]
 * @param {string} [dir]
 * @returns {Promise<Array<{ version: string, name: string }>>}
 */
async function migrateDown(pool, steps = 1, dir = MIGRATIONS_DIR) {
  const migrations = discoverMigrations(dir);
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const reverted = [];
  const conn = await pool.getConnection();
  try {
    const applied = await getAppliedMigrations(conn);
    const appliedVersionsDesc = [...applied.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const version of appliedVersionsDesc.slice(0, steps)) {
      const migration = byVersion.get(version);
      if (!migration) {
        throw new DatabaseError(`[Migrations] Applied migration ${version} has no corresponding file on disk — cannot roll back safely.`);
      }
      const rollbackContent = fs.readFileSync(path.join(dir, migration.rollbackFile), 'utf8');

      await conn.beginTransaction();
      try {
        const statements = rollbackContent.split(';').map((s) => s.trim()).filter(Boolean);
        for (const statement of statements) {
          await conn.query(statement);
        }
        await conn.query('DELETE FROM schema_migrations WHERE version = ?', [version]);
        await conn.commit();
        reverted.push({ version: migration.version, name: migration.name });
      } catch (e) {
        await conn.rollback();
        throw new DatabaseError(`[Migrations] Failed rolling back ${migration.version}_${migration.name}: ${e.message}`, e);
      }
    }
    return reverted;
  } finally {
    await conn.release();
  }
}

module.exports = {
  discoverMigrations,
  computeChecksum,
  ensureMigrationsTable,
  getAppliedMigrations,
  migrateUp,
  migrateDown,
  MIGRATIONS_DIR,
};
