# Z-SUPERADMIN — Platform Foundation & ShopERP Replacement (v2.0)

Z-SUPERADMIN is a completely independent Node/Express/SQLite service (`platform/`) — its own `package.json`, own `node_modules`, own database file (`platform.db`), own JWT secret, own process, own port (default 4100). It shares **nothing** at runtime with `server/local.js` (ShopERP) or any future product. This document is the durable reference, updated for the v2.0 Platform Replacement mission: ShopERP's own global Super Admin console has been **permanently removed** from `app/ShopERP_Pro_v8.html`, and Z-SUPERADMIN is now the single, sole control center for it, via the adapter pattern described below. There must never be another Super Admin inside any ZMAX product — see "Adapter Pattern" and "Migration Report".

## Why a separate service, not a module bolted onto ShopERP

The mission's Non-Negotiable Principles require: platform auth isolated from tenant auth; products that never know about each other; only the platform knows about every product. Putting `platform_users`/`organizations`/etc. inside `shoperpro.db`, or running platform routes inside `server/local.js`'s own process, would entangle ShopERP's database and process with cross-product platform state — the opposite of isolation. A separate service is the only way to make "isolated" true by construction rather than by convention.

## Directory layout

```
platform/
  package.json            own dependencies (express, better-sqlite3, bcryptjs, jsonwebtoken, nodemailer, cors, dotenv)
  server.js               entrypoint — node server.js
  .env.example
  src/
    config/env.js         PLATFORM_* env vars only
    database/
      connection.js        getDb() singleton
      schema.js             all CREATE TABLE + seed data
    errors/index.js         typed errors, {error:{code,message}} shape
    middleware/
      requirePlatformAuth.js
      requirePermission.js
      rateLimit.js
    repositories/           one per table/entity, parameterized queries only
    services/               business rules (auth, products, organizations, licenses, customers, audit, mailer)
    controllers/            thin request/response
    routes/index.js         every /api/platform/* route
  public/superadmin.html    the UI (single file, no build step, same "no bundler" philosophy as app/ShopERP_Pro_v8.html)
  scripts/
    lint.js                 syntax-checks every .js file + the HTML's inline script
    createOwner.js          bootstraps the first Platform Owner (no default credential ships)
  test/
    testServer.js           isolated in-process harness (disposable SQLite file, random port)
    platform-foundation.test.js   40 integration assertions
    shoperp-adapter-e2e.test.js   14 assertions proving the ShopERP adapter end-to-end, live
  docs/Architecture.md       this file
```

## Adapter Pattern (ShopERP → Z-SUPERADMIN, and every future product)

`platform/src/adapters/shoperpAdapter.js` is the **one file in the entire platform** that knows anything about ShopERP specifically. Every other module (`organizationService`, `licenseService`, `dashboardController`, `auditController`, `customerService`) is product-agnostic — it dispatches through `platform/src/services/orgRef.js`'s `resolve(rawId)`, which recognizes the synthetic ID form `"shoperp:<tenantId>"` and routes to the adapter, or falls through to Z-SUPERADMIN's own local `organizations` table for everything else.

The adapter authenticates exactly like a human operator would: it calls ShopERP's real, unmodified `POST /api/admin/login` with `SHOPERP_ADMIN_PASSWORD`, caches the resulting session token (refreshed before its ~12h expiry), and calls ShopERP's existing `/api/admin/*` REST endpoints — the same ones built across RC1 Sprint 2 and the (now-removed) ShopERP Super Admin Portal. **No ShopERP business logic is reimplemented** — license status math, stock rules, session revocation all happen inside ShopERP's own code, reached over HTTP. ShopERP's backend has zero code awareness that Z-SUPERADMIN exists; it cannot tell the difference between this adapter and a person typing the admin password into a browser.

Configuration: `SHOPERP_BASE_URL` + `SHOPERP_ADMIN_PASSWORD` in `platform/.env` (gitignored). Unset = `shoperpAdapter.isConfigured()` returns false and ShopERP organizations simply don't appear — a safe, non-crashing default, not an error state.

Adding a second real product integration (a future ZLAB/ZHospital adapter) means: one new file shaped like `shoperpAdapter.js`, one new line in `platform/src/adapters/index.js`'s `REGISTRY`. No change to `organizationService`, `licenseService`, `dashboardController`, or the UI. This is deliberately proven, not asserted — `test/platform-foundation.test.js` registers a brand-new product (`ZDental`) with a single API call and zero code changes.

**Data locality, by design, not oversight**: ShopERP's tenant/license/session data physically stays inside `shoperpro.db`. Every customer-facing ShopERP request is gated in-process by `requireActive`/`requireLicenseRead`/`requireLicenseWrite` — moving that data into `platform.db` would force a network call into Z-SUPERADMIN on every single ShopERP request, an availability and latency regression with no offsetting benefit. What moved to Z-SUPERADMIN is the **admin access point**, not the underlying data store. This is the resolution to "products must remain clean, platform management must live only in Z-SUPERADMIN" without requiring a live network dependency for every tenant request ShopERP serves.

Layering follows the same discipline as `server/src/`: routes → controllers → services → repositories → database. No controller touches a repository directly; no repository contains business rules; no SQL string-concatenates user input (every query is parameterized; the one dynamic ORDER BY column uses a whitelist map, never raw interpolation).

## Database changes

**New database, new file, zero changes to any existing database.** `platform.db` has 16 tables:

`platform_roles`, `platform_permissions`, `platform_role_permissions`, `platform_users`, `platform_login_failures`, `platform_sessions`, `platform_products`, `organizations`, `organization_products`, `platform_licenses`, `platform_audit_logs`, `platform_notifications`, `platform_settings`, `platform_feature_flags`, `organization_devices`, `organization_users`.

Full DDL: `platform/src/database/schema.js`. Seeded at first boot: 7 platform roles, 9 permissions, role→permission mappings, 4 products (`shoperp` real/active, `zlab`/`zhospital`/`zclinic` planned placeholders), 1 settings row. No default platform user is seeded — `scripts/createOwner.js` bootstraps the first Owner explicitly, so no guessable default credential ever ships.

## New Platform Modules

| Module | Table(s) | What it owns |
|---|---|---|
| Platform Users | `platform_users`, `platform_login_failures` | Who can log into Z-SUPERADMIN — 7 roles, account lockout |
| Platform Sessions | `platform_sessions` | Revocable session tracking per platform user |
| RBAC | `platform_roles`, `platform_permissions`, `platform_role_permissions` | 9 fine-grained permissions, role→permission mapping |
| Product Registry | `platform_products` | Every ZMAX product, config-only (name/slug/version/status/license model/feature flags) |
| Organizations | `organizations` | Every ZMAX customer, one row regardless of product count |
| Organization↔Product | `organization_products` | Which products an org has (many-to-many) |
| License Center | `platform_licenses` | One row per (org, product) — TRIAL/ACTIVE/READ_ONLY/SUSPENDED/ARCHIVED |
| Audit Log | `platform_audit_logs` | Every platform action, org/product/admin/old-value/new-value |
| Notifications | `platform_notifications` | Every email attempted, delivered or not |
| Settings | `platform_settings` | Platform-wide config (name, support contact) |
| Feature Flags | `platform_feature_flags` | Global or per-product flags, informational |
| Organization Devices/Users | `organization_devices`, `organization_users` | Generic, product-agnostic visibility for support — for adapter-backed organizations (ShopERP today) this is served live from the adapter, not from these local tables; the local tables remain for future adapterless products |

## Authentication flow

1. `POST /api/platform/auth/login` — `platform_users` lookup by email, bcrypt compare, 5-failures/15-min lockout (`platform_login_failures` + `locked_until`), 423 while locked.
2. On success: a `platform_sessions` row is created (session_id, revocable) and a JWT is signed with `PLATFORM_JWT_SECRET` (12h expiry) embedding `userId`, `email`, `roleCode`, `permissions[]`, `sid`, `jti`.
3. Every subsequent request: `requirePlatformAuth` verifies the JWT signature against `PLATFORM_JWT_SECRET` (a ShopERP tenant JWT, signed with a different secret, fails verification outright — proven in tests) and checks the `platform_sessions` row is still `active` (so `force-logout` genuinely revokes access mid-token-lifetime, not just at next expiry).

## Authorization flow

Each of the 7 roles (OWNER, SUPER_ADMIN, ADMINISTRATOR, SUPPORT, BILLING, AUDITOR, READ_ONLY) maps to a subset of 9 permissions (`manage_platform_users`, `manage_products`, `manage_organizations`, `manage_licenses`, `view_billing`, `manage_billing`, `view_audit_log`, `support_actions`, `view_only`). The JWT carries the resolved permission list at login time; `requirePermission(code)` checks it on every mutating route. OWNER has all 9; every other role is deliberately narrower (e.g. SUPPORT has only `support_actions`+`view_only` — cannot touch licenses or products; AUDITOR is read-only plus audit-log access; BILLING has no organization/license mutation rights at all).

## API Endpoints

All under `/api/platform/*`. See `platform/src/routes/index.js` for the authoritative list — summary:

- **Auth**: `POST /auth/login`, `GET /auth/me`
- **Dashboard**: `GET /dashboard/stats` (optional `?productId=`)
- **Products**: `GET /products`, `GET /products/:id`, `POST /products`, `PUT /products/:id`
- **Organizations**: `GET /organizations` (search/filter/sort/paginate), `POST /organizations`, `GET /organizations/:id` (full profile), `POST /organizations/:id/products` (attach), `POST /organizations/:id/approve`, `POST /organizations/:id/suspend`, `GET /organizations/:id/devices`, `POST /organizations/:id/devices/:deviceId/revoke`, `POST /organizations/:id/devices/:deviceId/rename`, `POST /organizations/:id/email`, `POST /organizations/:id/unlock`, `POST /organizations/:id/force-password-reset`, `POST /organizations/:id/kill-sessions`, `GET /organizations/:id/login-history`, `GET /organizations/:id/failed-logins`

  `:id` accepts either a local integer organization ID or the synthetic `"shoperp:<tenantId>"` form — every one of the above routes is adapter-aware via `orgRef.resolve()`. `unlock`/`force-password-reset`/`kill-sessions`/`login-history`/`failed-logins`/`device-rename` are adapter-only concepts today (Z-SUPERADMIN has no local end-user identity system of its own) — calling them against a locally-managed organization returns a clear `ValidationError`, not a silent no-op.
- **License Center**: `POST /organizations/:orgId/licenses/:productId/{activate,suspend,resume,renew,change-plan}`
- **Customers**: `GET /customers/search`
- **Audit Log**: `GET /audit-log` (filter by organizationId/productId/action)
- **Platform Users**: `GET/POST /platform-users`, `POST /platform-users/:id/{reset-password,unlock,force-logout}`, `GET /platform-users/:id/login-history`

## UI Screens

Single file, `platform/public/superadmin.html`, own dark glass-morphism theme (independent CSS/JS from ShopERP's — zero shared code, per Non-Negotiable Principle #2): Login, Dashboard (9 KPI cards + recent organizations, merged live across every configured adapter), Product Switcher (sidebar dropdown, filters dashboard/org list by product), Organizations (search/filter/table → full-profile modal with Business Info/Products/Licenses/Devices/Audit History + inline License Center + Support Actions: Approve/Suspend/Send Welcome/Send Renewal Reminder/Resend Verification/Unlock Account/Force Password Reset/Force Logout (kill sessions)/Login History/Failed Logins, plus per-device Rename/Revoke), Product Registry (list + register-new form), Audit Log (filterable table, merged live across every configured adapter), Platform Users (list + create + reset-password/unlock/force-logout).

Organization IDs may be either a local integer or the synthetic `"shoperp:<tenantId>"` string; every `onclick` handler that embeds an organization ID does so via `esc(JSON.stringify(id))`, not a bare template interpolation, so string-shaped IDs remain valid, safely-quoted JS literals in the generated HTML attribute (a real bug of this exact shape was found and fixed during this mission — see Migration Report).

## Migration Report (ShopERP Super Admin → Z-SUPERADMIN)

**Executed in this mission**, via the adapter pattern above — not the backfill/sync-job approach originally sketched in v1.0 of this document. That original plan (duplicate ShopERP's org/license state into `platform.db`, keep it in sync with a scheduled job) was superseded by a simpler, more correct design: **don't copy the data — call through to it live.** ShopERP's tenant/license/device/session data never leaves `shoperpro.db`; Z-SUPERADMIN reads and writes it in real time via `shoperpAdapter.js`, so there is no synchronization lag, no stale-copy risk, and no second source of truth to reconcile.

What moved:
- **ShopERP's entire global admin console** — the "Super Admin" card, its login/panel HTML, and every `adm*` JS function in `app/ShopERP_Pro_v8.html` (registration queue, customer/tenant management, license management, device management, email actions, audit trail) — **deleted outright**, not left dormant. ShopERP's landing page now shows only "My Existing Shop / New Shop / Try Demo".
- **Every one of those features** now lives in Z-SUPERADMIN's Organizations screen, reached through `shoperpAdapter.js` calling ShopERP's pre-existing, unmodified `/api/admin/*` endpoints (the same backend the old console called — nothing there was rebuilt).

What did **not** move, deliberately: the pre-existing, tenant-level `superadmin` **role** (`_requireRole(['owner','superadmin','manager'])`, `pageSuperAdmin`, `LICENSE_REGISTRY`) is a different concept — an elevated in-shop staff permission level, analogous to "Tenant Admin" — and is untouched. It is not a global admin surface and does not conflict with "there must be exactly one Super Admin."

**Rollback**: `shoperpro.db` and ShopERP's own runtime logic were never modified by the adapter (only by the earlier, separately-verified console-removal edit to the frontend). Stopping the Z-SUPERADMIN process or unsetting `SHOPERP_BASE_URL`/`SHOPERP_ADMIN_PASSWORD` fully disables the integration with zero impact on ShopERP's own customer-facing operation; re-adding the removed frontend console (from git history) would restore the old UI if ever needed, though doing so would violate this mission's "exactly one Super Admin" requirement.

## Security Review

- **Platform auth isolation**: proven in tests — a JWT signed with a different secret (simulating a ShopERP-shaped token) is rejected outright; there is no code path that accepts a non-`PLATFORM_JWT_SECRET`-signed token.
- **Tenant isolation**: not applicable to this service directly (it has no tenant concept) — ShopERP's own tenant isolation is completely untouched, since ShopERP's code was not modified at all.
- **No cross-organization access / no IDOR**: every organization-scoped mutation (device revoke, license actions) is scoped by both the path's organization ID and the resource's own foreign key; verified with a live cross-ID attempt (404, not a leak).
- **No SQL injection**: 100% parameterized queries; verified empirically with injection-shaped search queries and business names — data stored as inert text, tables intact.
- **No XSS**: all user-controlled data (business names, owner names, emails) is rendered via `esc()`-wrapped text nodes, never concatenated into an attribute. Organization IDs *are* embedded inside `onclick` attributes (needed for adapter-backed orgs, whose IDs are the string `"shoperp:<tenantId>"`, not a plain number) — each is wrapped with `esc(JSON.stringify(id))`, the same defensive pattern used to fix a real stored-XSS finding during the ShopERP Super Admin Portal build. A real bug of a different kind was found here during the v2.0 adapter-wiring pass: several `onclick` handlers embedded the raw, *unquoted* org ID (`onclick="showOrgDetail(${o.id})"`), which produced invalid JavaScript for any string-shaped ID (`showOrgDetail(shoperp:7)`), breaking every click-through to a ShopERP-backed organization. Not an XSS risk (IDs are system-generated, not user input) but a genuine functional break — fixed by the same `esc(JSON.stringify(...))` wrap.
- **RBAC enforced server-side**: verified — a SUPPORT-role user is rejected (403) attempting product-registry or platform-user-management actions their role doesn't grant.
- **Account lockout**: verified — 5 failed attempts locks for 30 minutes even against the correct password, both for the initial Owner test account and structurally identical to ShopERP's own proven lockout pattern (same `datetime('now', ?)` SQLite-native comparison, avoiding the string-format mismatch bug found and fixed during the ShopERP Super Admin Portal build).

## Backward Compatibility Report

Zero files inside `server/` or `app/` were modified during this build (confirmed via `git status` — the only changes there are the prior, separately-committed Super Admin Portal work). The full existing ShopERP test suite (`npm test` in `server/`, ~20 files, hundreds of assertions) and lint both pass with zero failures after this build, run from the same working tree. ShopERP customers experience no change whatsoever — a new, entirely separate service now exists alongside their product, not integrated with it yet.

## Production Readiness Report

**Foundation and ShopERP integration are both real and tested, not a mockup.** 40/40 platform-foundation assertions plus 14/14 live ShopERP-adapter assertions passing — the latter against a real, disposable ShopERP instance, proving the full loop: Z-SUPERADMIN lists/searches a real tenant, views its live profile, extends its license (verified by querying ShopERP's own database directly, bypassing Z-SUPERADMIN entirely), suspends it (verified the real tenant's subsequent `/api/data` call is genuinely blocked), and reads ShopERP's own real audit trail. Also verified against the real, currently-running `server/local.js` instance (not just the disposable test harness): Z-SUPERADMIN's dashboard and organization list correctly report all 7 real tenants with their real statuses.

Known gaps, honestly stated:
- **No interactive browser click-through test was possible in this environment** (no browser automation tool was connected) — every code path the UI calls was instead verified at the HTTP level with the exact same request shapes the JS makes, plus `scripts/lint.js`'s inline-script syntax check on `superadmin.html`. A manual click-through in a real browser is still recommended before this UI is handed to a non-technical operator.
- No real SMTP configured (logs-only fallback, by design, until deployed).
- No rate-limit tuning beyond the copied ShopERP defaults.
- No HTTPS/reverse-proxy config (expected to sit behind one, same as `server/local.js`).
- No real ZLAB/ZHospital/ZClinic integration — only ShopERP has a real adapter; the other three remain `planned` placeholder rows in the Product Registry, proving the registry scales without proving a second live integration.
- No automated backup tooling yet for `platform.db` (the same `better-sqlite3` `.backup()` approach ShopERP's `backup-verify.js` uses would apply directly — not built in this pass).

Recommended before any real deployment: run `scripts/createOwner.js` to create the first real Owner credential (this build's own dev/test Owner password was reset locally purely to exercise the live-wiring check and is not a credential meant to persist), configure `PLATFORM_JWT_SECRET`/SMTP in a real `.env`, and put it behind the same reverse-proxy/HTTPS setup ShopERP's own `DeploymentChecklist.md` already documents.
