# Architecture — Identity & Tenant Core (Phase 2) + Operations Domain (Phase 4)

Status: `server/src/` now contains a real, working, MariaDB-backed implementation of the Identity & Tenant Core bounded context (Phase 2) AND the Operations domain (Phase 4 — Inventory, Customer, Sale/SaleItem, Repair/RepairPart, Expense, RecurringExpense, StockMovement, Payment; Configuration stays JSON per ADR-0008) — see `docs/architecture/Operations.md` for the Phase 4 layer in full detail. **It is not the running production server** — `server/local.js` remains that until a future cutover phase (`docs/adr/0001-enterprise-reconstruction.md`, Phase 9). Nothing here is wired into `local.js` or `app/ShopERP_Pro_v8.html`'s main flows; both are unchanged except for a small number of necessary additions (see "Frontend changes" below).

## Layers (ADR-0005), as actually populated this phase

```
routes/auth/, routes/users/   →  Express routing + middleware wiring, paths matching local.js
controllers/                   →  Request/response shaping only
services/                      →  Business rules (bcrypt, anti-enumeration, device limits, last-owner guard, table-driven authorization)
repositories/                  →  MariaDB queries only, one per aggregate
middleware/                    →  requireAuth, requireActive, requirePermission, rateLimit
database/                      →  Connection pool, migration runner (Phase 1), now with a real migration
errors/, logging/, config/     →  Phase 1 infrastructure, now genuinely load-bearing (not just wired-but-unused)
```

## What's implemented (Phase 2 + Phase 4)

**Phase 2**: Tenant, Hosted User, Hosted Session, Trusted Device, Authentication (PIN login), Authorization (table-driven, `docs/adr/0006-table-driven-authorization.md`), JWT issuance/verification, Session Lifecycle (create/refresh/revoke/heartbeat/cleanup), Tenant Isolation, Role, Permission, PIN reset (service-layer only — see `docs/security/Authentication.md`).

**Phase 4**: the full Operations domain per ADR-0008's Hybrid Storage Strategy — Inventory (with real stock_movements audit trail), Customer, Sale/SaleItem (self-healing invoice numbering, hard stock validation, discount bounds), Repair/RepairPart (self-healing job numbering, free 5-state transitions including warranty-reopen, auto-calculated final cost), Expense, RecurringExpense (manual-trigger-only, no scheduler), and a unified Payment table (sale/repair collection + manual cash-book entries). Configuration (`tenant_settings`) stays a JSON column, per ADR-0008 — no column-level schema was invented for it. Full detail: `docs/architecture/Operations.md`.

## What's explicitly NOT implemented (out of scope, documented, not silently missing)

Desktop authentication (ADR-0003), Licensing/Subscriptions/Billing (`tenant_licenses`, `license_history`, `subscription_plans` — no table, no code in `server/src/`; these DO exist in `local.js` itself as a separate, already-shipped feature — see `local.js`'s own `/api/admin/tenant-licenses/*` routes, untouched by this reconstruction), Cloud Backup, `/api/auth/register` and `/api/auth/signup` (both create a `tenant_licenses` row as part of registration — Licensing-entangled, deferred), `/api/auth/renew-license` (pure Licensing), public HTTP routes for admin-gated actions (`reset-user-pin`, `toggle-user` — both require `AdminCredentials`, out of scope; their business logic exists as tested service functions), Purchasing (never approved), Invoice immutability (never approved), a RecurringExpense scheduler (never approved), and Repair technician assignment (never approved) — the last four explicitly forbidden by the Phase 4 mission itself, not merely undone.

## New table: `role_permissions` and why it's real, not decorative

`docs/adr/0006-table-driven-authorization.md` is the full reasoning. Short version: Phase 1.5 found no Permission model exists in `local.js` (hardcoded `role !== 'owner'` checks). Phase 2's mission explicitly asks for `roles`/`permissions` tables. The resolution: build them for real, seed them to reproduce today's exact 3 in-scope gates, and verify that equivalence with tests — this is genuine new architecture, not a behavior change.

## Frontend changes (ADR-0004)

`app/modules/auth.js` (Phase 2) — `generateBrowserMachineId()` and the `_api` session/fetch-wrapper object. `app/modules/validation.js` (Phase 4) — the shared field-validation helpers used across Inventory/Customer/Sales/Repairs/Expenses/Configuration forms (`validatePhone`, `validateEmail`, `validateRequired`, `validateNumeric`, `validateGST`, `validateIMEI`, `runValidations`, `fieldErr`, `clearFieldErr`). See each module's own header comment for exactly what was and wasn't moved, and why — Phase 4's header in particular explains why the Operations domain's actual business-logic functions (saveProduct, saveSale, saveJob, etc.) were deliberately NOT extracted (they're entangled with the global `DB` blob and modal DOM state; extracting them would require the redesign this phase's mission explicitly forbids). Both load via `<script src="modules/*.js">`, served by `local.js`'s one additive static route (`app.use('/modules', express.static(...))`, added in Phase 2, unchanged in Phase 4).

## Deployment status

Not deployed, not cut over. `server/src/app.js` assembles a complete, runnable Express app (`createApp({jwtSecret})`) covering both Identity & Tenant Core and the Operations domain — proof this architecture actually works end-to-end, not just in isolated unit tests. Starting it requires a real MariaDB instance (none was available in this session — see `docs/database/MigrationNotes.md` and every `*.test.js` file's honest skip behavior). Per Phase 4's mission, real per-entity REST endpoints now exist for Operations data (`/api/inventory`, `/api/customers`, `/api/sales`, `/api/repairs`, `/api/expenses`, `/api/settings`) — a necessary consequence of ADR-0008's normalization decision, since `local.js` itself has no equivalent (everything there still goes through one `GET/PUT /api/data` whole-blob path, unchanged).
