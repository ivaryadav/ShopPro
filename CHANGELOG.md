# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versioning per `docs/architecture/Versioning.md`.

## [Unreleased] — v2.0 Enterprise Reconstruction (in progress)

Tracked in `docs/adr/0001-enterprise-reconstruction.md`. Not deployed, not cut over — `v1.0.0` remains the released, running product throughout this work.

### RC1 Sprint 1 — Licensing Domain
- Migrated ONLY the Licensing domain into `server/src/`: `subscription_plans`/`tenant_licenses`/`license_history` tables, full repository/service layer (`tenantLicenseService.js`), and `GET /api/license/status`. Every admin action (approve/reject/assign-plan/start-trial/generate-license/extend/suspend/reactivate/device-limit) is a fully tested service function, matching `local.js` exactly — no public route yet, since the real gate (`requireAdminKey`) is Administration domain.
- The status-transition sweep (`ACTIVE→READ_ONLY→SUSPENDED→ARCHIVED`) runs for real, wired into `createApp()` on the same timer pattern as Phase 2's session cleanup.
- Two real bugs found and fixed by this sprint's real-MariaDB integration testing: a missing `assignPlan` admin-action wrapper that never logged its `PLAN_ASSIGNED` history event (the shared `assignPlanToTenant` helper was ported correctly, but the standalone admin action wrapping it was not), and a test's own incorrect expectation about `extendLicense` stacking days onto an existing future expiry rather than resetting it.
- Explicitly did not touch Inventory, Sales, Repairs, Expenses, the frontend, Administration, Cloud Backup, or Authentication — one small, documented exception: a `revokeAllSessionsForTenant` function was added to this sprint's own `tenantLicenseRepository.js` (not any Authentication-domain file) to preserve the real "suspending a tenant kills their sessions" behavior.
- Full detail, including every documented deviation (narrower `license.status` response, no email-verification gate on approval pending a future Identity-domain phase, device-limit value/enforcement decoupling): `docs/architecture/Licensing.md`.
- 32 new mocked assertions + 20 new real-MariaDB integration assertions (a fresh, disposable, isolated instance, torn down afterward). Zero regressions: existing 436-assertion suite and every prior `test:src` file pass unmodified.

### RC1 Repository Audit
- Full-repository audit ahead of an eventual release candidate: read every ADR/Phase Review/architecture doc, then checked every module for dead code, duplicate utilities, large files, circular dependencies, naming/folder inconsistencies, TODOs/FIXMEs, and layering violations.
- Removed `renderer/` (`index.html` + `license-engine.js`) — confirmed dead: an early Electron renderer draft from before the `main`/`master` branch consolidation, already documented in `docs/architecture/BranchingStrategy.md` as "superseded by `app/ShopERP_Pro_v8.html`", never loaded by `main.js`, and not included in `package.json`'s `build.files` packaging list.
- Added the missing root `README.md` (none existed before).
- Fixed the ADR index (`docs/adr/README.md`) — ADR-0007 and ADR-0008 existed as real, accepted ADRs but were never added to the index table.
- Corrected two stale `server/src/routes/*/README.md` files (`tenants/`, `licenses/`) that referenced an old, superseded phase-numbering scheme (a different "Phase 3"/"Phase 4" than the ones this reconstruction actually executed).
- Verified: layered architecture boundaries hold with zero violations (no SQL outside `repositories/`+`database/`, no controller touches a repository directly, no route contains business logic); zero circular service dependencies; zero hardcoded secrets in tracked files; existing 436 + `test:src` suites and lint all pass unmodified.
- No business logic changed, no UI redesigned, no new features added — pure audit-and-cleanup, per this task's explicit scope.
### Phase 6 — Cutover Readiness Implementation
- Closed every blocker Phase 5's parity review identified. Applied `rateLimit(120, 60s)` consistently to all 6 Operations route groups (a real gap — these routes had no rate limiting at all, unlike every auth-related route in both codebases).
- Performed real MariaDB validation for the first time across this entire reconstruction, without bypassing any existing credentials: provisioned a dedicated, isolated MariaDB instance (separate Homebrew install, own port/datadir/credentials) and ran migrations, rollback, CRUD, transactions (including a forced real constraint-violation rollback), FK enforcement, 20-way connection-pool concurrency, and a real performance baseline against it.
- Found and fixed a real bug in the process: `inventoryService.createProduct`'s SKU-fallback path passed snake_case DB fields into a function expecting camelCase, silently nulling every other NOT NULL column — invisible to mocked tests, caught only by a real database constraint. Fixed with a dedicated `inventoryRepository.setSku()`. Also fixed two stale `database.test.js` assertions (hardcoded from when only 1 migration existed) that had never actually run against a real database before now.
- Built a JSON→Relational migration tool (`server/src/migrationTools/jsonToRelational/` + `migrateTenantData.js` CLI): dry-run mode, real migration, per-tenant rollback, post-migration integrity verification, and a markdown reconciliation report. Tested against synthetic sample data through a full round trip against real MariaDB — not run against any real tenant's data, per this phase's "no production cutover" scope. Catches a genuinely non-obvious edge case: a repair job's advance payment is never reflected in `RepairJob.payments[]` by `local.js` itself, and would be silently lost by a naive migration.
- Generated production readiness documentation: `docs/architecture/ProductionReadinessChecklists.md` (5 checklists), `docs/architecture/DeploymentGuide.md`, `docs/architecture/Runbook.md`.
- No production deployment performed. `local.js` and the frontend remain completely unchanged.

### Phase 5 — Cutover Preparation & Parity Validation
- Systematically compared `server/local.js` against `server/src/` across 15 behavioral areas, producing a Parity Matrix, Behavior Matrix, API/Database Compatibility Matrices, and a Migration Readiness Checklist (`docs/architecture/ParityValidation.md`).
- Attempted a real MariaDB connection more rigorously than any prior phase; still not reachable in that environment (closed in Phase 6, above). Found the missing-rate-limiting gap fixed in Phase 6. Zero source code changed — pure verification and documentation.

### Phase 4 — Operations Domain Implementation
- Implemented the Operations domain against real MariaDB per ADR-0008's Hybrid Storage Strategy: `inventory_items`, `customers`, `sales`/`sale_items`, `repairs`/`repair_parts`, `expenses`, `recurring_expenses`, `stock_movements` (new), `payments` (new, unifying `Sale.payments[]`/`RepairJob.payments[]`/`DB.cashEntries[]`) — layered routes/controllers/services/repositories, parallel to `server/local.js`, same as Phase 2's Identity & Tenant Core. Configuration (`tenant_settings`) stays JSON, per ADR-0008.
- Real per-entity REST endpoints (`/api/inventory`, `/api/customers`, `/api/sales`, `/api/repairs`, `/api/expenses`, `/api/settings`) — a necessary, approved consequence of normalizing the domain, since `local.js` itself has no equivalent (one `GET/PUT /api/data` whole-blob path).
- Two documented, deliberate deviations from Phase 3's schema design where "preserve existing behavior" overrode a never-approved proposal: `inventory_items` keeps `local.js`'s hard-delete (no `is_deleted` soft-delete column), and sale/repair payment-collection overpayment is rejected explicitly rather than reproducing a client-side split-arithmetic quirk. Full detail: `docs/architecture/Operations.md`.
- Extracted the shared field-validation helpers (`validatePhone`, `validateEmail`, `runValidations`, etc.) from `app/ShopERP_Pro_v8.html` into `app/modules/validation.js` — the one genuinely self-contained layer in the Operations domain; the actual business-logic functions (`saveProduct`, `saveSale`, `saveJob`, etc.) remain unextracted, entangled with the global `DB` blob by design (extracting them would require the redesign this phase's mission forbids).
- 60 new test assertions across 8 files (`server/src/tests/`), all passing; 4 database-integration assertions honestly skip (no credentialed MariaDB available in this environment). Zero regressions: the existing 436-assertion suite (`server/test/`) and Phase 2's 151 assertions both pass unmodified (one pre-existing assertion in `database.test.js` updated to expect 2 migrations instead of 1, reflecting the new migration file, not a behavior change).
- Explicitly did NOT introduce: Purchasing, Invoice immutability, a RecurringExpense scheduler, Repair technician assignment, or SKU/phone uniqueness enforcement — none exist in `local.js` today and none were approved by any prior phase.

### Phase 3 — Operations Domain Architecture
- Pure architecture/design phase (no code) — analyzed the entire Operations domain, decided the Hybrid Storage Strategy (ADR-0008: normalize Inventory/Sale/SaleItem/Customer/Repair/Expense/RecurringExpense/StockMovement/Payment, keep Configuration as JSON), and wrote the full column-level schema design (`docs/database/OperationsSchemaDesign.md`) that Phase 4 implements.
- Added ADR-0007 (API Error Response Strategy — the structured `{error:{code,message}}` shape is the permanent standard going forward).

### Phase 2 — Identity & Tenant Core
- Added a MariaDB-backed, layered (routes/controllers/services/repositories) implementation of Tenant, Hosted User, Hosted Session, Trusted Device, Authentication, Authorization, and Role/Permission — parallel to, not replacing, `server/local.js`.
- Added `docs/adr/0006-table-driven-authorization.md`: a real `roles`/`permissions`/`role_permissions` schema, seeded to reproduce `local.js`'s exact 3 authorization gates.
- Extracted `generateBrowserMachineId()` and the `_api` session/auth-helper object from `app/ShopERP_Pro_v8.html` into `app/modules/auth.js` (`docs/adr/0004-incremental-frontend-modularization.md`). Added a static-file route in `local.js` so this loads correctly in hosted/browser mode, not just Electron.
- 151 new test assertions across 12 files (`server/src/tests/`), all passing; 8 database-integration assertions honestly skip (no credentialed MariaDB available in this environment).
- Zero behavior change to `server/local.js`'s business logic, `server/index.js`, or `app/ShopERP_Pro_v8.html`'s existing functions — the existing 436-assertion suite (`server/test/`) passes unmodified.

### Phase 1 — Foundations & Governance
- Git branching strategy (`main`/`develop`/`feature`/`refactor`/`release`/`hotfix`); resolved the historical `main`-vs-`master` default-branch divergence.
- Repository governance (`CODEOWNERS`, PR/issue templates, `SECURITY.md`, `CONTRIBUTING.md`).
- `server/src/` layered folder skeleton with real (not stub) config/logging/error-handling/MariaDB infrastructure.
- 5 ADRs (`docs/adr/0001`-`0005`).

### Phase 1.5 — Canonical Domain Model
- Extracted the actual business domain from the live implementation into `docs/architecture/{CanonicalDomainModel,DomainModel,EntityRelationship,BusinessRules,LifecycleDiagrams}.md`. Found 14 of 31 expected entities don't exist as distinct concepts (most notably: no Purchase/PurchaseItem entity at all; Invoices are not immutable, contradicting an initial assumption).

## [1.0.0] — released

SaaS licensing/registration/subscription system, security hardening (bcrypt migration, backdoor removal, enumeration fix, DevOps headers), independent Release Approval Board audit and remediation of its one Critical finding. See `docs/independent-audit/` and `docs/production-hardening/` for full detail.
