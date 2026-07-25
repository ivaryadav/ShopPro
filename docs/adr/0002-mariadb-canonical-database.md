# ADR-0002: MariaDB Canonical Database

## Status
Accepted

## Context

The hosted/SaaS backend currently has two database engines in play: `server/local.js` uses SQLite (`better-sqlite3`) — the real, tested, deployed engine behind every feature this project has shipped — and `server/index.js` uses Postgres (`pg`) via `server/db.js` — a thin, never-fully-built, never-tested, never-deployed skeleton. Neither is MariaDB. The enterprise reconstruction (ADR-0001) requires exactly one canonical database engine.

## Decision

**MariaDB is the sole database engine for the hosted/SaaS backend going forward.** SQLite and Postgres — and every adapter, driver, and compatibility shim tied to either — are removed once the MariaDB-backed system is proven equivalent (Phase 9 of ADR-0001's reconstruction; not before).

MariaDB was chosen over continuing with either existing engine because: (a) neither existing engine choice was reached through an explicit evaluation — SQLite was a pragmatic "single-file, zero-ops" choice appropriate to the product's original single-shop scale, and Postgres in `index.js` was an abandoned parallel attempt; (b) this reconstruction is the first point where the engine choice is being made deliberately, as part of "one database, one source of truth" (ADR-0001); (c) MariaDB gives a real client/server database with connection pooling, proper concurrent-writer support (SQLite is fundamentally single-writer, even in WAL mode), and a mature migration/tooling ecosystem, while remaining operationally similar to Postgres in complexity — a reasonable middle ground for a product that has outgrown "one file on disk" but is not yet at a scale requiring Postgres-specific features nothing here currently uses.

## Alternatives considered

- **Keep SQLite, just add layering**: rejected — SQLite's single-writer model is a real ceiling this product will eventually hit if the hosted mode grows past its original single-shop-server design point, and the mission explicitly named MariaDB as the target.
- **Finish building out the existing Postgres skeleton (`index.js`/`db.js`)**: rejected — that path leads to Postgres, not MariaDB, and would still require essentially rebuilding all the business logic that only ever existed in `local.js`.
- **Support multiple engines via an ORM abstraction**: rejected — directly contradicts ADR-0001's "one database" goal and the mission's explicit instruction to remove compatibility layers, not add one.

## Consequences

- A new dependency (`mariadb` or `mysql2`, decided in Phase 1's infrastructure work) and a real running MariaDB instance are required for local development and every environment this now deploys to — the "just `npm install` and go" simplicity of SQLite is gone.
- Every table, query, and migration in `server/local.js`'s SQLite schema needs a MariaDB-equivalent rewritten from scratch (SQLite and MariaDB have different type systems, different `AUTOINCREMENT`/`AUTO_INCREMENT` syntax, different `datetime('now')`-style functions, different transaction semantics) — this is real, substantial work spread across Phases 2-4 of ADR-0001's reconstruction, not a drop-in swap.
- The offline desktop product is explicitly unaffected — see ADR-0003.
- `server/index.js`, `db.js`, `routes/`, `middleware/`, and `schema.sql` (the Postgres skeleton) and `server/local.js` (SQLite) are all retained, unmodified, until Phase 9's cutover — this ADR authorizes their eventual removal but does not perform it now.
