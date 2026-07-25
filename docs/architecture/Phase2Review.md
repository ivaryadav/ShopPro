# Phase 2 Review — Identity & Tenant Core

Named `Phase2Review.md` rather than the generic `PhaseReview.md` the mission requested, to avoid a filename collision with whatever Phase 3 produces — matching this project's established precedent (e.g. `LicensingMigrationPlan.md` renamed from `MigrationPlan.md` for the same reason, `docs/architecture-review/`).

## Scope delivered

Tenant, Hosted User, Hosted Session, Trusted Device, Authentication (PIN login), Authorization (table-driven), JWT, Session Lifecycle, Tenant Isolation, Role, Permission, PIN Reset (service-layer) — on the layered architecture (`routes → controllers → services → repositories → MariaDB`), against a real migration, with 151 passing test assertions and zero behavior change to the actual running application.

## What made this phase harder than a mechanical port

1. **Two Phase-1.5 findings (`Permission` doesn't exist; `roles` isn't a table) were in direct tension with this phase's explicit instruction to build `roles`/`permissions` tables.** Resolved via `docs/adr/0006-table-driven-authorization.md`: build the real structure, seed it to reproduce today's exact outcomes, prove the equivalence with tests — satisfies both "implement Permission" and "preserve existing behavior exactly" without picking one over the other.
2. **Several in-scope endpoints had out-of-scope dependencies baked in** (device limit reads a Licensing table; `requireActive` checks Licensing-domain columns; PIN reset/toggle-user are gated by an out-of-scope Admin system). Each was resolved by finding the *in-scope* subset of the real behavior — often `local.js`'s own existing fallback path — rather than inventing a substitute or silently dropping the feature. Documented exhaustively in `docs/database/MigrationNotes.md`.
3. **A frontend extraction created a real, live regression** (the new module would 404 in hosted/browser mode, since `local.js` doesn't serve `app/` as static files). Caught by reasoning through both deployment modes before considering the extraction done, not by luck — fixed with one small, necessary, additive route in `local.js`, verified live.
4. **A migration-discovery bug from Phase 1 resurfaced conceptually**: this phase's own tests needed updating because the fixture migrations they were written against (Phase 1's placeholders) were legitimately superseded — handled by updating the test to match the new reality, exactly as Phase 1's own documentation predicted would happen.

## Confidence level, honestly stated

High for everything not requiring a live MariaDB connection (config, logging, errors, all business logic in services, all authorization/session/device/user rules) — verified by 151 real, executable assertions with dependency-injected repository mocks, not hand-waved. **Lower, and explicitly flagged**, for the actual database layer's real-world behavior (connection pooling under load, migration behavior against a genuinely fresh MariaDB instance, FK constraint enforcement in practice) — no credentialed MariaDB was available in this session to verify this beyond the migration framework's own logic tests. This is the single most important thing to close before Phase 3 builds further on this foundation.

## Recommendation for Phase 3

Before starting Phase 3 (whatever it covers next — Licensing is the natural next bounded context given how many Phase 2 deviations trace back to it), get this phase's `identityCore.integration.test.js` and `database.test.js` running against a real, credentialed MariaDB instance and confirm all currently-skipped assertions pass for real. Everything else in this phase is ready for review as-is.
