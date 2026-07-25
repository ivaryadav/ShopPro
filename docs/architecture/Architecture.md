# Architecture — Identity & Tenant Core (Phase 2)

Status: `server/src/` now contains a real, working, MariaDB-backed implementation of the Identity & Tenant Core bounded context (`docs/architecture/CanonicalDomainModel.md`). **It is not the running production server** — `server/local.js` remains that until a future cutover phase (`docs/adr/0001-enterprise-reconstruction.md`, Phase 9). Nothing here is wired into `local.js` or `app/ShopERP_Pro_v8.html`'s main flows; both are byte-for-byte unchanged except for two small, necessary additions (see "Frontend changes" below).

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

## What's implemented (in scope, per the Phase 2 mission)

Tenant, Hosted User, Hosted Session, Trusted Device, Authentication (PIN login), Authorization (table-driven, `docs/adr/0006-table-driven-authorization.md`), JWT issuance/verification, Session Lifecycle (create/refresh/revoke/heartbeat/cleanup), Tenant Isolation, Role, Permission, PIN reset (service-layer only — see `docs/security/Authentication.md`).

## What's explicitly NOT implemented (out of scope, documented, not silently missing)

Desktop authentication (ADR-0003), Licensing/Subscriptions/Billing (`tenant_licenses`, `license_history`, `subscription_plans` — no table, no code), Cloud Backup, the entire Operations domain (Inventory/Sales/Repairs/Expenses/etc.), `/api/auth/register` and `/api/auth/signup` (both create a `tenant_licenses` row as part of registration — Licensing-entangled, deferred), `/api/auth/renew-license` (pure Licensing), and public HTTP routes for admin-gated actions (`reset-user-pin`, `toggle-user` — both require `AdminCredentials`, out of scope; their business logic exists as tested service functions, ready for a future phase to wire up once Administration is migrated).

## New table: `role_permissions` and why it's real, not decorative

`docs/adr/0006-table-driven-authorization.md` is the full reasoning. Short version: Phase 1.5 found no Permission model exists in `local.js` (hardcoded `role !== 'owner'` checks). Phase 2's mission explicitly asks for `roles`/`permissions` tables. The resolution: build them for real, seed them to reproduce today's exact 3 in-scope gates, and verify that equivalence with tests — this is genuine new architecture, not a behavior change.

## Frontend changes (ADR-0004)

`app/modules/auth.js` — `generateBrowserMachineId()` and the `_api` session/fetch-wrapper object, extracted verbatim from `app/ShopERP_Pro_v8.html`. See that file's own header comment for exactly what was and wasn't moved, and why. **One necessary, non-optional server change accompanied this**: `local.js` serves its HTML by reading file content directly (not `express.static`), so the new `<script src="modules/auth.js">` tag would 404 in hosted/browser mode without an explicit static route — `local.js` now has one (`app.use('/modules', express.static(...))`), verified live. This is the one line of `local.js` this phase touches, and it is purely additive infrastructure, not a business-logic change.

## Deployment status

Not deployed, not cut over. `server/src/app.js` assembles a complete, runnable Express app (`createApp({jwtSecret})`) for testing purposes — proof this architecture actually works end-to-end, not just in isolated unit tests. Starting it requires a real MariaDB instance (none was available in this session — see `docs/database/MigrationNotes.md` and every `*.test.js` file's honest skip behavior).
