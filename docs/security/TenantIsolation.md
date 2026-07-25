# Tenant Isolation — Identity & Tenant Core (Phase 2)

`docs/independent-audit/APIAudit.md` (the independent audit) found `local.js` has no IDOR path in any non-admin endpoint — every tenant-scoped query sources `tenant_id` exclusively from the verified JWT payload. Phase 2 preserves this exactly and re-verifies it structurally.

## How isolation is enforced in the new code

- **`requireAuth`** decodes the JWT and sets `req.user = payload` — `tenantId` comes from the signed, server-issued token, never from a request body/query/param.
- **Every repository method that's tenant-scoped takes `tenantId` as an explicit parameter** (`userRepository.listByTenant(tenantId)`, `sessionRepository.listActiveByTenant(tenantId)`, etc.) — a controller can only pass `req.user.tenantId`, never a client-supplied value, because no route in `routes/auth/` or `routes/users/` reads a tenant ID from anywhere else.
- **`sessionService.revokeOwned(tenantId, sessionId)`** explicitly checks the target session's `tenant_id` matches the caller's before revoking — matches `local.js:1077-1078` exactly, including the choice of `404` (not `403`) so a caller can't even confirm a session ID exists in another tenant.
- **`user_sessions` gains real FK constraints** on `tenant_id`/`user_id` (see `docs/database/ERD.md`) — `local.js`'s SQLite version has none. This is a defense-in-depth hardening: a session row referencing a nonexistent tenant/user is now impossible at the database level, not just avoided by application logic.

## What this phase does NOT change

The Critical finding fixed in `docs/independent-audit/FinalBlockerResolution.md` (tenant-status consistency between `tenants.status` and `tenant_licenses.status`) is entirely about the Licensing domain, out of scope here — Phase 2's `tenants` table carries only `status`/`suspend_reason` (no `tenant_licenses` table exists in this schema at all), so that specific two-column-drift bug has no surface to reappear on in this phase's code. A future phase that migrates Licensing must re-verify this exact class of consistency issue doesn't reappear once `tenant_licenses` is (re)introduced server-side in MariaDB.

## Verified by

`server/src/tests/sessionService.test.js`'s `revokeOwned` ownership-check assertion; every repository test's explicit `tenantId` parameter passing (`server/src/tests/authService.test.js`, `userService.test.js`); manual code review of every file in `server/src/repositories/` confirming no query accepts an unscoped or client-suppliable tenant identifier.
