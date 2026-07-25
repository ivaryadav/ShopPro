# database/

MariaDB infrastructure (ADR-0002): connection pool (`connection.js`), health check (`healthCheck.js`), and the version-controlled migration framework (`migrationRunner.js`, `migrations/`).

**No production schema lives here yet.** `migrations/001_initial.sql` and `002_example.sql` are deliberately trivial, clearly-marked proof-of-concept files that exist only to demonstrate the framework (apply, checksum, rollback) end-to-end. Phase 2 (Auth & Tenant Core) replaces them with the real first migrations.

Run the migration CLI via `server/src/scripts/migrate.js` (see that file's own usage comment) — never apply a migration by hand against a running database.

Nothing here is imported by `server/local.js` or `server/index.js`. This module has no effect on the currently-running application.
