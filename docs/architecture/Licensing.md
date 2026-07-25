# Licensing Domain — Implementation (RC1 Sprint 1)

Migrates ONLY the Licensing domain from `server/local.js` into the layered `server/src/` architecture: License, Subscription, Activation, Renewal, Expiry, Grace Period, Device Limits. Explicitly does not touch Inventory, Sales, Repairs, Expenses, the frontend, Administration, Cloud Backup, or Authentication — per this sprint's own mission.

## Layers (ADR-0005)

```
routes/license/           →  GET /api/license/status only
controllers/licenseController.js  →  Request/response only
services/tenantLicenseService.js  →  Every Licensing business rule
repositories/{subscriptionPlan,tenantLicense,licenseHistory}Repository.js  →  Persistence only
database/migrations/003_licensing_domain.sql(+.rollback.sql)  →  3 real tables
```

## What's implemented

- **`subscription_plans`**: the 3 real tiers (TRIAL/BASIC/PREMIUM), seeded identically to `local.js:312-314`.
- **`tenant_licenses`**: the 5-state lifecycle (`PENDING_APPROVAL → ACTIVE → READ_ONLY → SUSPENDED → ARCHIVED`), plan/billing/device-limit assignment, license key generation, expiry/grace tracking, offline-grace anchor (`last_verified_at`).
- **`license_history`**: an append-only audit trail — every service function that changes state writes a row, matching `local.js`'s `addLicenseHistory` call sites exactly.
- **Business rules preserved exactly**: self-healing plan assignment (`assignPlanToTenant`), the approve-registration auto-default-to-TRIAL-if-unconfigured behavior, extend-stacks-onto-existing-future-expiry (not reset), the 3-stage transition sweep (ACTIVE→READ_ONLY on expiry, →SUSPENDED after 30 days, →ARCHIVED after 365 days, with session-kill on the SUSPENDED transition), and the exact license-key format/charset.
- **The sweep runs for real** — wired into `createApp()` on the same `setInterval` pattern as Phase 2's session cleanup, env-configurable via `LICENSE_SWEEP_INTERVAL_MS` (matches `local.js:564` exactly, including the same test-friendly override).

## API surface

Only `GET /api/license/status` is a public route — matches `local.js:1152` exactly (`requireAuth` only, deliberately no `requireActive` gate, since this is the one endpoint that must stay reachable for a suspended/archived tenant). Every other Licensing action (`approveRegistration`, `rejectRegistration`, `assignPlan`, `startTrial`, `generateLicenseForTenant`, `extendLicense`, `suspendTenant`, `reactivateTenant`, `setDeviceLimit`, `listTenantLicenses`, `listPendingRegistrations`, `getHistory`) is a fully implemented, fully tested **service function with no public route** — identical precedent to Phase 2's `resetPin`/`setActive`, because their real-world gate (`requireAdminKey`) belongs to the Administration domain, out of scope for this sprint.

## Documented deviations (none silent)

1. **`GET /api/license/status`'s response is narrower than `local.js`'s.** `local.js`'s version returns an outer `{status, reason, licenseExpiry, licensePlan}` object sourced from legacy columns on the `tenants` table (`license_key_hash`/`license_expiry`/`license_plan`), plus a nested `license: {...}` object sourced from `tenant_licenses`. Phase 2's `tenants` migration deliberately excluded those legacy columns as "Licensing-domain columns living on that table historically, out of scope for Phase 2" — and modifying that table now would mean touching the Authentication domain, explicitly forbidden by this sprint's own mission. `getLicenseStatus` therefore returns only the `tenant_licenses`-sourced `license` object; the outer legacy-compatibility fields are not reproduced.
2. **`approveRegistration` omits the owner-email-verification gate.** `local.js`'s approve endpoint (`local.js:1408-1411`) refuses to approve a registration until the owner's email is verified. That check reads `users.email_verified_at`, a column that exists only in `local.js`'s SQLite schema (added for the signup/email-verification flow) — Phase 2's `users` table (`migrations/001`) has no email-verification columns at all, since email verification is Identity-domain, out of scope for this sprint. Documented, not silently dropped: a future Identity-domain phase that ports email verification must add this gate back to `approveRegistration` before it's relied on for a real approval flow.
3. **`createPendingLicense` is the Licensing-only half of `/api/auth/signup`.** `local.js`'s signup handler creates `tenants` + `users` + `tenant_data` + `tenant_licenses` rows in one transaction (`local.js:862-877`) specifically so a tenant is never left without a `tenant_licenses` row (the exact condition the license middleware fails open on — `TenantStatusConsistency.md`, Blocker 3). Creating a tenant/user is Identity-domain, out of scope here. `createPendingLicense` assumes the tenant already exists and creates only its `tenant_licenses` row; a future Identity-domain phase composing the full signup flow must wrap this call together with tenant/user creation in one transaction, exactly as `local.js` does, to preserve that same guarantee.
4. **The device-limit VALUE (this sprint) is decoupled from device-limit ENFORCEMENT (Phase 2, Authentication domain).** Phase 2's `trustedDeviceService.js` uses a hardcoded `FALLBACK_DEVICE_LIMIT=2` specifically because `tenant_licenses` didn't exist in `server/src/` yet. This sprint builds the real, authoritative `tenant_licenses.device_limit` value and its assignment rules — but does not modify `trustedDeviceService.js` to read it, since doing so means touching Authentication domain, explicitly forbidden. The two systems remain decoupled; wiring the real device limit into device-trust enforcement is a well-scoped, cross-domain integration task for a future phase, not silently done here.
5. **Device-management actions that mutate `trusted_devices` directly are not ported.** `local.js`'s `/api/admin/tenant-licenses/:tenantId/devices/{remove,reset-all}` and the devices-listing endpoint all write to or read `trusted_devices` (Authentication domain). Only `setDeviceLimit` (which touches `tenant_licenses.device_limit` alone) was ported.
6. **`revokeAllSessionsForTenant` lives in `tenantLicenseRepository.js`, not `sessionRepository.js`.** Suspending a tenant (manually, or via the sweep) killing that tenant's active sessions is real, required Licensing behavior `local.js` performs (`sessions.revokeAllTenantSessions`). Preserving it exactly requires one `UPDATE user_sessions` statement — added as a new function in this sprint's own repository rather than by editing any Phase 2 file, so "Do NOT touch: Authentication" is honored at the file level while the real behavior is preserved.

## Explicitly NOT introduced

Nothing new — every business rule above is a direct port. No new plan tiers, no new status values, no new device-limit logic beyond what `local.js` already does.

## Frontend

Untouched, per this sprint's explicit "Do NOT touch: Frontend" instruction.

## Deployment status

Same as every prior phase: not deployed, not cut over. `server/src/app.js` now also mounts `/api/license` and runs the transition sweep on a timer.
