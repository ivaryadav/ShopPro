# server/src/ — Enterprise Backend (v2.0, in progress)

This tree is the new, MariaDB-backed, layered backend described in `docs/adr/0002-mariadb-canonical-database.md` and `docs/adr/0005-layered-backend-architecture.md`. It is currently **scaffolding only** — created in Phase 1 of the enterprise reconstruction (`docs/adr/0001-enterprise-reconstruction.md`) with no business logic yet.

**Do not confuse this with the working application.** The real, deployed backend is still `server/local.js` (SQLite) — every existing route, test, and the entire independent security audit (`docs/independent-audit/`) targets that file. `server/index.js` is the older, unrelated Postgres skeleton this new structure supersedes in shape but not in code. Neither is touched by this phase.

## Layers (see ADR-0005 for the full rules)

```
routes/        HTTP layer only — parse request, call a controller/service, format response. No SQL. No business logic.
controllers/    Thin request handlers backing routes/ — kept separate from route *wiring*.
middleware/     Auth checks, validation, rate limiting. No SQL.
services/       Business logic, only where a route→repository call isn't enough to justify one. No SQL.
repositories/   MariaDB access only. No business logic, no HTTP concerns.
database/       Connection pool, migration runner (see database/migrations/).
config/         Typed configuration modules — one per concern (database, jwt, mail, logger, license, storage), plus environment validation. No scattered process.env reads anywhere else.
logging/        Centralized logger (DEBUG/INFO/WARN/ERROR/FATAL). No console.log outside this.
errors/         Centralized error classes + the one global error-handling middleware.
validators/     Shared input-validation schemas, used by routes/middleware.
routes/{auth,licenses,tenants,users}/  Domain grouping — one folder per bounded context.
shared/, utils/ Cross-cutting helpers with no business meaning of their own.
tests/          This new backend's own test suite — separate from server/test/, which continues to test local.js and must keep passing unmodified throughout this reconstruction.
scripts/        Tooling specific to this new backend (e.g. the migration-runner CLI) — separate from server/scripts/, which continues to serve local.js/SQLite.
```

## Status

Phase 1 (this phase): folders created, each with a README stating its contract. No files beyond that — no server boots from this tree yet, nothing here is wired into the running application. Phase 2 onward populates these layers with real code, starting with authentication and the tenant core.
