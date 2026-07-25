# Runbook — `server/src/` (Phase 6)

Operational reference for `server/src/` once (if) it is ever actually deployed. **Nothing in this runbook has been exercised against a production incident** — it is prepared, forward-looking documentation, per this phase's "prepare for production readiness" mission, not a record of real operations.

## Health check

`GET /health` — returns `{status, mode, time, db}`. `db: 'error'` or `status: 'degraded'` means the MariaDB connection pool cannot reach the database — check network connectivity, credentials, and that the target database's schema migrations are applied (`npm run migrate:status`).

## Common incidents

### The app won't start
`createApp()`/`env.js` fail fast and loudly on a missing required environment variable — the error message names which one. This is intentional (same posture as `local.js`'s own `JWT_SECRET` check) — do not attempt to "fix" this by making a variable optional without a deliberate decision.

### Migrations show as "already-applied" but a table is missing
Per `migrationRunner.js`'s design, an already-recorded migration is never silently re-applied even if its content changed — if the checksum in `schema_migrations` doesn't match the on-disk file, `migrateUp()` throws loudly rather than guessing. If a table is missing despite a recorded migration, something modified the database outside this tool — investigate before touching `schema_migrations` directly.

### A tenant-data migration's integrity check failed
`migrateTenantData.js migrate`'s reconciliation report names exactly which counts/totals mismatched. Do NOT re-run `migrate` again for the same tenant without first running `migrate:tenant-data:rollback` — re-running without rolling back would create duplicate rows (the tool has no idempotency guard against being run twice for the same tenant). Roll back, diagnose the source blob (usually an edge case `transform.js` doesn't yet handle — see its skip/synthesis logic), fix, and retry.

### Rate limiting (429s) on Operations routes
Each of the 6 Operations route groups now rate-limits at 120 requests/minute per (IP, path) pair (Phase 6 fix — see `docs/architecture/ParityValidation.md`'s security finding). A sudden spike in 429s from a single tenant's traffic likely indicates a client-side polling bug, not an attack — check `X-Forwarded-For`/IP patterns before assuming malice.

### Connection pool exhaustion
`server/src/database/connection.js`'s pool defaults come from `getDatabaseConfig()` (`DB_POOL_MAX`/`DB_POOL_MIN`). If `/health` or real requests start failing with `ER_GET_CONNECTION_TIMEOUT`, check for a connection leak (a repository function that acquired a connection via `withConnection()` but the pattern being bypassed somewhere — every repository in this codebase uses `withConnection()`, which always releases in a `finally` block; a leak would mean new code not following that pattern).

## Restart procedure

No special drain/restart procedure exists yet — `server/src/` has no dedicated production entrypoint (see `DeploymentGuide.md`'s note on this gap). A future phase building one should follow `local.js`'s own graceful-shutdown pattern (close the connection pool via `closePool()` before exiting).

## Escalation

This stack is not yet in production — there is no on-call rotation or escalation path defined for it. This section exists to be filled in by whichever future phase actually deploys it.
