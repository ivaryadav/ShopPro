# Administration Domain — Implementation (RC1 Sprint 2)

Migrates ONLY the Administration domain from `server/local.js` into `server/src/`: Admin Dashboard, Tenant Management, Registration Approval, Subscription Administration, License Management, User Administration, Device Management. Explicitly does not touch Inventory, Sales, Repairs, Expenses, the frontend, or database architecture — and touches Authentication/Licensing only via integration (reusing their existing, unmodified repositories/services), never by editing their files.

## Layers (ADR-0005)

```
routes/admin/                      →  Every /api/admin/* endpoint
controllers/{adminAuth,adminTenant,adminLicense}Controller.js  →  Request/response only
services/{adminAuth,adminTenant,adminUser,adminDevice}Service.js  →  Business rules
repositories/{adminCredential,adminDirectory}Repository.js  →  Persistence only
database/migrations/004_administration_domain.sql(+.rollback.sql)  →  1 new table (admin_credentials)
```

## What's implemented

- **Admin Dashboard**: `POST /api/admin/login` (real bcrypt login with automatic sha256→bcrypt upgrade, replacing the old static-key model — matches `local.js`'s own Issue-2 fix exactly), `GET /api/admin/tenants`, `GET /api/admin/web-users`.
- **Tenant Management**: `POST /api/admin/tenant/status` (pause/terminate/restore), with the exact `syncLegacyStatusToLicense` behavior — including its real fail-open no-op when a tenant has no `tenant_licenses` row yet.
- **Registration Approval**: `GET /api/admin/registrations`, approve/reject — thin wrappers around Sprint 1's `tenantLicenseService`, unmodified.
- **Subscription Administration / License Management**: the full `tenant-licenses` dashboard, history, assign-plan, start-trial, generate-license, extend, suspend, reactivate, kill-sessions, notes, call-note — all wired to Sprint 1's service, plus 3 new small integration functions (`killSessions`, `addNote`, `addCallNote`) added to `tenantLicenseService.js` since Sprint 1 had no caller for them.
- **User Administration**: `POST /api/admin/reset-user-pin`, `POST /api/admin/toggle-user` — thin wrappers around Phase 2's unmodified `userService.resetPin`/`setActive`, adding the admin-specific existence check and response shape.
- **Device Management**: list/remove/reset-all for a tenant's trusted devices, via this sprint's own `adminDirectoryRepository.js` (not Phase 2's `trustedDeviceRepository.js`).

## Cross-domain integration, not modification

Every rule in this sprint's mission ("Do NOT touch: Authentication... Licensing (except integration)... database architecture") was honored at the file level:

- **Zero lines changed** in `sessionService.js`, `sessionRepository.js`, `requireAuth.js`, `trustedDeviceService.js`, `trustedDeviceRepository.js`, `userService.js`, `userRepository.js` (Phase 2), or `tenantLicenseRepository.js`'s/`licenseHistoryRepository.js`'s existing functions (Sprint 1).
- **New, additive-only exports** were added to `tenantLicenseService.js` (`killSessions`, `addNote`, `addCallNote`) — genuinely new capability Sprint 1 never needed, not a change to any existing function's behavior.
- **New repository, `adminDirectoryRepository.js`**, holds every cross-tenant query (tenant-by-shop-name lookup, all-tenants listing, all-users-with-tenant listing, device list/remove/reset-all) that doesn't belong in any single tenant-scoped repository — consistent with how Sprint 1's `revokeAllSessionsForTenant` was added to its OWN repository file rather than to `sessionRepository.js`.
- **`tenantRepository.updateStatus`** (Phase 2, already exists) is reused directly by `adminTenantService.setTenantStatus` — read-only reuse of a stable, existing function, not a modification.
- **`config/env.js`** gained one new declarative entry (`ADMIN_KEY`, matching `local.js`'s own default fallback hash exactly) — this is Phase 1's general, cross-cutting config layer (already extended by Sprint 1 for `LICENSE_*` variables), not an Authentication-domain file.

## Admin's own auth system

`adminAuthService.js`/`requireAdminSession.js` are Administration's OWN credential/session mechanism — a real bcrypt login (with automatic legacy-sha256 upgrade) exchanged for a short-lived (12-hour), random, in-memory session token, matching `local.js`'s post-Issue-2 model exactly (`local.js:482-517, 1191-1232`). This is entirely separate from the tenant-user JWT auth Phase 2 built — building it is not "touching Authentication," it completes Administration's own missing piece.

## Documented deviations (none silent)

1. **`POST /api/admin/login`'s "admin_credentials row missing" case returns 401, not `local.js`'s 500.** `local.js` returns a distinct `{error: 'Admin credentials not configured'}` 500 for this scenario. Phase 1's `errorHandler` deliberately never leaks internal-state messages to the caller (a security posture already tested in `errors.test.js`) — reproducing `local.js`'s specific message here would mean bypassing that design. This scenario should be unreachable in a correctly-booted system (the boot-time seed always creates the row), so the minor status-code deviation was judged acceptable; the missing-password case (a genuine, non-security-sensitive input-validation branch) still reproduces `local.js`'s exact 400 status.
2. **`GET /api/admin/web-users`'s response omits `licensePlan`.** `local.js`'s query reads `tenants.license_plan`, a Licensing-domain column living on that table historically — Phase 2's `server/src/` `tenants` table (migrations/001) deliberately excludes it, out of scope for this sprint to add.
3. **`adminUserService.resetUserPin`/`toggleUser` call `userRepository.findById` once for the admin-side existence check, and `userService.setActive`'s own last-owner guard calls it again internally** — a minor, accepted double-read (not a bug) rather than changing Phase 2's `setActive` to accept a pre-fetched user object.

## Explicitly NOT introduced

No new admin-facing workflow, no renamed endpoint, no new business rule. `/api/admin/generate-key`/`validate-key` (the offline-desktop license engine, `server/license.js`) and `/api/cloud/*` (Cloud Backup) are untouched — out of scope for this sprint.

## Frontend, Database Architecture

Untouched, per this sprint's explicit instructions.

## Deployment status

Same as every prior phase/sprint: not deployed, not cut over. `server/src/app.js` now also mounts `/api/admin` and seeds `admin_credentials` at boot (idempotent, matching `local.js`'s own seed-on-first-boot behavior exactly).
