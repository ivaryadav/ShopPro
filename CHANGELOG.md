# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versioning per `docs/architecture/Versioning.md`.

## [Unreleased] — v2.0 Enterprise Reconstruction (in progress)

Tracked in `docs/adr/0001-enterprise-reconstruction.md`. Not deployed, not cut over — `v1.0.0` remains the released, running product throughout this work.

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
