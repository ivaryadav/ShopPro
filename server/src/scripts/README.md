# scripts/

Tooling for this new MariaDB-backed backend specifically (the migration-runner CLI, a future seed-data script, etc.) — kept separate from `server/scripts/`, which continues to serve `local.js`/SQLite (`backup-verify.js`, `lint.js`, `validate-migrations.js` — note the similar name to this reconstruction's own migration tooling; that existing script validates `local.js`'s additive SQLite schema and is unrelated to `src/database/migrations/`).
