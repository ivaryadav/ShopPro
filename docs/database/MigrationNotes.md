# Migration Notes — Identity & Tenant Core (Phase 2) + Operations Domain (Phase 4) + Licensing Domain (RC1 Sprint 1)

Consolidated reference for every place this phase's implementation deliberately deviates from, defers, or extends `server/local.js`'s actual behavior. Per the mission's own instruction ("if code and documentation disagree: document it, do not silently change behavior"), nothing below is silent.

## Database

- **`001_identity_tenant_core.sql`** replaces Phase 1's placeholder `001_initial`/`002_example` migrations entirely (never applied to any real database — safe to replace, not edit-after-apply).
- **`tenants`** carries only `status`/`suspend_reason` from `local.js`'s table — not `license_key_hash`/`license_expiry`/`license_plan` (Licensing-domain columns living on that table historically, out of scope here).
- **`users.role_id`** (FK to a new `roles` table) replaces `users.role` (free TEXT) — normalizes the existing 2-value enum, doesn't add a new role.
- **`roles`/`permissions`/`role_permissions`** are new tables with no `local.js` equivalent — see `docs/adr/0006-table-driven-authorization.md`. Seeded to reproduce exactly 3 real gates found in `local.js` (`sessions:view`, `sessions:revoke`, `staff:add`); `GET /api/data/users` deliberately has no seeded permission, since `local.js` has no gate on it either.
- **`user_sessions` gains real FK constraints** on `tenant_id`/`user_id` — `local.js`'s SQLite version has none (confirmed, `docs/architecture/EntityRelationship.md`). Low-risk hardening: no code path creates a session for a nonexistent tenant/user today.
- **Excluded entirely**: `tenant_licenses`, `license_history`, `subscription_plans` (Licensing), `admin_credentials` (Administration), `cloud_backups` (Administration, legacy) — all out of scope per the mission's explicit instruction.

## Endpoints not migrated, and why

| Endpoint | Reason |
|---|---|
| `POST /api/auth/register` | Creates a `tenant_licenses` row as part of registration — Licensing-entangled. |
| `POST /api/auth/signup` | Same — creates a `PENDING_APPROVAL` `tenant_licenses` row. |
| `POST /api/auth/renew-license` | Pure Licensing. |
| `POST /api/admin/reset-user-pin` | Gated by `requireAdminKey` (`AdminCredentials`), Administration domain. Business logic exists and is tested (`services/userService.js#resetPin`); no public route yet. |
| `POST /api/admin/toggle-user` | Same — `services/userService.js#setActive` is implemented/tested, no public route. |

## Business-rule deviations (all verified equivalent, not silently different)

1. **Device limit fallback** — `local.js:1000-1001` reads `tenant_licenses.device_limit`, falling back to a fixed `2` when no license row exists. Since `tenant_licenses` is out of scope, Phase 2 always takes that fallback branch — it's `local.js`'s own existing code path, not a new default (`services/trustedDeviceService.js`).
2. **`requireActive` has no license-expiry check** — `local.js`'s version also checks `license_expiry`/`license_plan` for legacy key-based tenants; Phase 2's `tenantService.assertActive()` only checks `status` (paused/terminated), since the expiry columns are Licensing-domain.
3. **Error response shape changed** — `local.js` returns `{error: "string"}`; Phase 2's `errorHandler` returns `{error: {code, message, details?}}`. A real API-shape difference, not preserved byte-for-byte (`docs/security/Security.md`). No impact today (nothing is cut over); relevant for whichever future phase does the actual cutover.
4. **`resetPin`/`setActive` have no public route** — see table above.

## What was extended beyond a literal 1:1 port (low-risk, justified)

- Session cleanup job now runs on the same 30-minute interval as `local.js`'s `_runSessionCleanup()` (`app.js`).
- `user_sessions` FK hardening (above).
- `role_id` normalization (above).

## Rollback

`migrations/001_identity_tenant_core.rollback.sql` drops all 6 tables in FK-safe order. Since this schema has never been applied to any real production database (no cutover has happened), rollback risk is theoretical at this stage — this note exists for when a future phase actually deploys against a real MariaDB instance for the first time.

## Known gap: no live MariaDB verification in this environment

Every `*.test.js` file's database-dependent assertions report an honest skip in this session (a MySQL server is running locally but this session has no credentials to it, and did not attempt to bypass another user's pre-existing authentication). All non-DB-dependent logic is fully tested via repository mocking. **Re-run `npm run test:src` against a real, credentialed MariaDB instance before relying on this stack in production.**

---

# Phase 4 additions — Operations Domain

Full narrative: `docs/architecture/Operations.md`. This section covers only what's specific to `002_operations_domain.sql` beyond what that document already states.

## Database

- **`002_operations_domain.sql`** adds 10 tables: `inventory_items`, `customers`, `sales`, `sale_items`, `repairs`, `repair_parts`, `expenses`, `recurring_expenses`, `stock_movements` (new), `payments` (new, unifying), `tenant_settings`. Implements `docs/database/OperationsSchemaDesign.md` (Phase 3 design) with two documented deviations (see `docs/architecture/Operations.md`'s "Documented deviations" section) — no `is_deleted` column, and nullable `created_by`/`product_id` FKs with `ON DELETE SET NULL`.
- **No data migration from the JSON blob.** This phase builds the layered MariaDB implementation in `server/src/`, exactly like Phase 2 — it does NOT parse `tenant_data.data`'s existing JSON blob and insert rows. `local.js`'s live data remains completely untouched and unread by this migration. A future cutover phase would need a separate, one-time blob-to-relational data migration (already flagged as "a real, nontrivial future undertaking" in ADR-0008).

## Endpoints — all new (see `docs/architecture/API.md`'s "Operations domain endpoints" table)

`local.js` never had per-entity Operations endpoints to preserve compatibility with — the entire surface in `docs/architecture/API.md`'s Phase 4 table is new REST surface, a direct, necessary consequence of ADR-0008's normalization decision.

## Business-rule deviations (all documented, not silent)

See `docs/architecture/Operations.md`'s "Documented deviations" section for the full list (soft-delete reversal, payment-overpayment simplification, customer phone-duplicate reproduction via `allowDuplicate`).

## What was extended beyond a literal 1:1 port (low-risk, justified)

- `stock_movements` — genuinely new capability (audit trail), not an extraction; no current data to migrate.
- Atomic SQL stock increment/decrement (`GREATEST(0, stock ± ?)`) instead of JS read-then-write, for the sale/repair hot paths — a real hardening against concurrent writes `local.js`'s single in-process array never had to consider, while preserving the exact same clamp-at-zero semantics. `adjustStock` (manual, low-frequency) still reads-then-writes so its audit-log delta matches `local.js`'s own prev→new message exactly.

## Known gap: no live MariaDB verification in this environment (same as Phase 2)

`server/src/tests/operationsCore.integration.test.js` reports an honest skip in this session, for the same reason as Phase 2's `identityCore.integration.test.js`. All business logic is fully tested via repository mocking in `inventoryService.test.js`, `customerService.test.js`, `saleService.test.js`, `repairService.test.js`, `expenseService.test.js`, and `paymentService.test.js`. **Closed in Phase 6 — see below.**

---

# Phase 6 additions — Cutover Readiness

## Real MariaDB validation, finally performed

Phases 1/2/4/5 all reported an honest skip for anything requiring a live database — no credentials were ever available to those sessions, and none of them attempted to bypass another user's pre-existing database authentication. Phase 6 closed this gap **without** bypassing anything: it provisioned its own dedicated MariaDB instance via a second Homebrew install (`mariadb`, distinct from the shared system `mysql` formula already running other users' work), running on its own port (3307) and datadir, with its own root/app-user credentials created fresh — never touching the shared instance's data or authentication at all. `npm run migrate:up`/`migrate:status`, full CRUD, transactions (including a forced rollback via a real duplicate-invoice_no constraint violation), FK enforcement, 20-way connection-pool concurrency, and a real performance baseline were all exercised against this instance for real. Every previously-hardcoded `TEST_DB_CONFIG` in `database.test.js`/`identityCore.integration.test.js`/`operationsCore.integration.test.js` is now env-overridable (`TEST_DB_HOST`/`PORT`/`USER`/`PASSWORD`/`NAME`), defaulting to the exact same values as before when unset — the honest-skip behavior is preserved for any environment without a real database, this is purely additive.

**A real bug was found and fixed as a direct result**: `database.test.js` had two assertions hardcoded from when only migration 001 existed (`schema_migrations records exactly 1 applied migration`, `migrateDown(1) reverts the identity-core migration cleanly`) — both silently stale since Phase 4 added migration 002, both invisible because Part 2 of that test always honestly skipped until now. Fixed to expect 2 migrations and to correctly test reverse-order rollback (002 first, then 001). Separately, `inventoryService.createProduct`'s SKU-auto-generation fallback called `inventoryRepository.update()` with the snake_case row `create()` had just returned, instead of the camelCase shape `update()` expects — every other NOT NULL column silently went to `NULL` in the UPDATE statement, only caught because a real MariaDB NOT NULL constraint rejected it (`ER_BAD_NULL_ERROR`). Fixed with a dedicated `inventoryRepository.setSku()` single-column update, avoiding the field-shape mismatch entirely.

New test file: `server/src/tests/mariadbValidation.integration.test.js` — connection pool concurrency, transaction atomicity, and the Phase 6 performance baseline, all against real MariaDB.

## Rate limiting fix

Phase 5's parity review found the 6 Operations route groups (`/api/inventory`, `/api/customers`, `/api/sales`, `/api/repairs`, `/api/expenses`, `/api/settings`) had no rate-limiting middleware at all, unlike every auth-related route in both `local.js` and `server/src/`. Fixed by applying `rateLimit(120, 60s)` (the existing, already-ported limiter — no new dependency) immediately after `requireAuth`/`requireActive` in each router, matching `local.js`'s own convention for already-authenticated mutation routes (e.g. `/api/admin/tenant/status`: `requireAdminKey, rateLimit(...)`). Verified via `server/src/tests/operationsRateLimit.test.js` (route-stack introspection, since triggering a real 429 end-to-end would require a live database-backed session).

## JSON → Relational migration tool (new)

`server/src/migrationTools/jsonToRelational/` — `transform.js` (pure field-mapping functions), `validationService.js` (pre/post validation), `migrationService.js` (orchestration: dry-run, real run, rollback, integrity verification), `reconciliationReport.js` (markdown report builder). CLI: `server/src/scripts/migrateTenantData.js` (`dry-run`/`migrate`/`rollback` subcommands).

Scope is Operations-domain data only (Inventory/Customer/Sale/Repair/Expense/RecurringExpense/cash entries/Configuration) — Identity data (tenants/users) is already relational in `local.js`'s own SQLite, not a JSON blob, and out of scope for this tool. The tool never reads or writes `local.js`'s SQLite database directly — the caller extracts `tenant_data.data` into a JSON file first, keeping this tool fully decoupled from the live production database it migrates away from (a deliberate design choice, not an oversight — it means this tool cannot accidentally corrupt or delete anything in `shoperpro.db`, satisfying "customer data is never deleted" trivially by construction).

**One real, non-obvious edge case handled**: a repair job's advance payment (`job.advanceAmount`/`advanceMethod`, set at job creation) is never pushed into `RepairJob.payments[]` by `local.js` itself — only later `collectRepairPayment` calls append to that array. A naive migration copying only `payments[]` would silently lose every repair's advance payment. `transform.mapRepair()` synthesizes a payment record from `advanceAmount`/`advanceMethod` in addition to whatever's in `payments[]` — caught and verified via a real round-trip test (`jsonToRelationalMigration.integration.test.js`) before it could have caused silent data loss in a real cutover.

Tested against synthetic sample data shaped exactly like `local.js`'s `DB` object (NOT real production data) — dry-run (writes nothing, reports accurate expected counts), real run (correct row creation, unresolvable-customer sales/repairs skipped with a named reason rather than fabricated), post-migration integrity verification (row counts + financial totals reconcile), and rollback (removes every created row, never touches the `tenants` row) all verified against the same real, disposable MariaDB instance used for the rest of Phase 6's validation.

## Known gap, still open

No real tenant's actual production data has been migrated by this tool — by design, per this phase's "do not perform production cutover" instruction. The tool is built and tested; running it against real `local.js` data is a future, separately-approved cutover step.

---

# RC1 Sprint 1 additions — Licensing Domain

Full narrative: `docs/architecture/Licensing.md`. This section covers only what's specific to `003_licensing_domain.sql` and this sprint's cross-domain boundary decisions beyond what that document already states.

## Database

- **`003_licensing_domain.sql`** adds 3 tables: `subscription_plans`, `tenant_licenses`, `license_history` — matching `local.js:228-273` exactly, TEXT timestamps promoted to proper `TIMESTAMP` types (structural only).
- **`tenants.license_key_hash`/`license_expiry`/`license_plan` (legacy columns) are NOT added** to `server/src/`'s `tenants` table (Phase 2, migrations/001) — out of scope for this sprint to modify (Authentication domain). Consequence: `getLicenseStatus`'s response is narrower than `local.js`'s (see `Licensing.md` deviation #1).
- **`users.email_verify_token_hash`/`email_verify_expires`/`email_verified_at` are NOT added** to `server/src/`'s `users` table either — same reason. Consequence: `approveRegistration` omits the owner-email-verification gate (see `Licensing.md` deviation #2).

## Endpoints — one new public route, everything else service-layer-only

`GET /api/license/status` is the only public Licensing route this sprint adds — see `docs/architecture/API.md`'s "Licensing domain endpoints" table. Every admin action is a tested service function with no route, matching Phase 2's `resetPin`/`setActive` precedent exactly (their real gate, `requireAdminKey`, is Administration domain, out of scope).

## Business-rule deviations (all documented, not silent)

See `docs/architecture/Licensing.md`'s "Documented deviations" section for the full list (narrower license-status response, no email-verification gate on approval, `createPendingLicense` as signup's Licensing-only half, device-limit value/enforcement decoupling, device-management actions not ported, and the one cross-domain repository function — `revokeAllSessionsForTenant`).

## Real bugs found and fixed by this sprint's real-database integration testing

1. **A missing admin-action wrapper.** `assignPlanToTenant` (the shared, non-logging helper `local.js` itself uses internally from `startTrial`/`approveRegistration`) was ported correctly, but the STANDALONE admin action `local.js`'s `/api/admin/tenant-licenses/:tenantId/assign-plan` performs (call `assignPlanToTenant`, then log a `PLAN_ASSIGNED` history event) was missing entirely. Caught by `licensingCore.integration.test.js` asserting `license_history` contained a `PLAN_ASSIGNED` event after calling what should have been the equivalent action — fixed by adding `tenantLicenseService.assignPlan` (distinct from `assignPlanToTenant`).
2. **A test-authored bug, not an implementation bug**: the integration test's own expectation for `daysRemaining` after `extendLicense` didn't account for `extendLicense`'s real, correct behavior (stacking `days` onto an existing FUTURE `expires_at` rather than resetting it, matching `local.js:1552` exactly) — the test's expected range was fixed, not the implementation, once the real behavior was traced back to `local.js`'s own logic.

## Known gap: same real-database-verification standard as every prior phase

`server/src/tests/licensingCore.integration.test.js` reports an honest skip in environments with no real, credentialed MariaDB instance available — same pattern as every other integration test in this project. All business logic is fully tested via repository mocking in `tenantLicenseService.test.js` (32 assertions). This sprint's own real-database run (a fresh, disposable, isolated MariaDB instance, torn down afterward — same technique as Phase 6) exercised the full lifecycle for real: pending → approved → plan-assigned → extended → the complete 4-state sweep (backdated timestamps to fast-forward ACTIVE→READ_ONLY→SUSPENDED→ARCHIVED) → reactivated → suspended, with `license_history` verified to contain every transition.
