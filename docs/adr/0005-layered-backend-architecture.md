# ADR-0005: Layered Backend Architecture

## Status
Accepted

## Context

`server/local.js` — the real, tested, deployed backend — is a single 1,991-line file: route handlers, validation, business logic, and raw SQL are all interleaved in the same functions. This has been workable at the project's current scale (confirmed by 436 passing tests and a full independent audit), but it means every change risks touching unrelated concerns, there is no reusable data-access layer, and no unit can be tested in isolation from the Express request/response cycle.

`server/index.js`'s abandoned Postgres skeleton already separates `routes/` from `middleware/`, closer to (though far short of) the target shape — this ADR's decision on the new backend's shape draws on that structure without reusing its (untested, incomplete) code.

## Decision

The new MariaDB-backed backend (ADR-0002) follows a strict layered architecture:

```
Routes  →  Middleware  →  Services (only where justified)  →  Repositories  →  Database
```

Rules, non-negotiable:
- **No SQL in routes.** No SQL in middleware. No SQL in services.
- **Repositories contain database access only** — a repository method takes/returns plain data, never an HTTP request/response object, never a raw business rule.
- **Business logic never belongs in repositories** — a repository doesn't decide whether a tenant is allowed to do something; a service does, then asks a repository to read/write the result.
- **Services exist "only where justified"** — a route that does nothing but validate input and call one repository method doesn't need a service layer in between manufacturing indirection for its own sake.

Concrete folder structure (created empty in Phase 1, populated starting Phase 2):

```
server/src/
  routes/          → auth/, licenses/, tenants/, users/  (HTTP layer: parse request, call service, format response)
  middleware/       → auth checks, validation, rate limiting
  services/         → business logic (license state machine, tenant isolation rules, etc.)
  repositories/      → MariaDB queries only, one per aggregate (tenants, users, licenses, sessions...)
  controllers/      → thin request handlers backing routes (kept separate from routes/ so route *wiring* and route *handling* aren't the same file)
  database/         → connection pool, migration runner
  config/           → typed configuration modules (ADR-driven, see Phase 1 deliverables)
  logging/          → centralized logger
  errors/           → centralized error classes + global handler
  validators/       → input validation schemas, shared across routes
  shared/, utils/   → cross-cutting helpers with no business meaning of their own
```

## Alternatives considered

- **Keep `local.js`'s monolithic-file shape, just point it at MariaDB**: rejected as the long-term shape (though it is exactly what Phase 2 onward avoids repeating) — it perpetuates the untestable, tightly-coupled structure this reconstruction exists to fix.
- **Full hexagonal/ports-and-adapters architecture**: considered and rejected as more ceremony than this product's actual complexity justifies right now — the simpler Routes→Middleware→Services→Repositories chain covers every real requirement (SQL isolation, business-logic testability, clear boundaries) without an abstraction layer count that would slow down a single-maintainer team.
- **Repositories that also contain validation/business rules ("fat repositories")**: rejected — directly contradicts the mission's explicit "business logic never belongs in repositories" rule and would make repositories untestable in isolation from business rules that have nothing to do with data access.

## Consequences

- Every future feature requires touching more files (a route, possibly a service, a repository) than the old single-file style did — deliberately, in exchange for each piece being independently testable and reviewable.
- This structure is created empty in Phase 1 (this phase) specifically so its shape can be reviewed and approved before any real logic is written into it in Phase 2 onward — getting the shape wrong now would be far cheaper to fix than after auth, licensing, and tenant logic are all built against it.
- `server/local.js` and `server/index.js` remain the only *working* backends until Phase 9 — this new `server/src/` tree has no wired-up server of its own until later phases populate it with real logic and an entry point.
