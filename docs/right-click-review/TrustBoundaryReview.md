# Server Trust Boundary Review — Phase 4

Status: **CONFIRMED. Every security-relevant decision is enforced server-side.** The client (browser or Electron renderer) is never trusted for permissions, licensing, admin access, subscriptions, tenant ownership, or pricing — enabling the context menu changes none of this, since the context menu is UI chrome, not a data or authorization channel.

## Why this matters for *this specific change*

Enabling right-click means a user can now open "Inspect Element," "View Page Source," and similar tools via the mouse (they could already reach all of these via the browser's own menu — see `RightClickAudit.md`). The only way that could matter for security is if some permission/license/admin decision were made or trusted client-side, such that inspecting or modifying the DOM/JS could grant something real. The enumeration below confirms that is not the case anywhere in this application.

## Permissions / role enforcement

- **Client-side check**: `_requireRole()`/`_sigOf()` in `app/ShopERP_Pro_v8.html` — an HMAC-like integrity signature over the current user object, catches someone doing `currentUser.role='owner'` in DevTools.
- **This is explicitly documented as defense-in-depth, not the boundary.** The real boundary: every server endpoint re-derives the role from the verified JWT payload (`req.user.role`), never from a request body field. Example: `POST /api/auth/add-staff` checks `if (req.user.role !== 'owner')` — server-side, from the token, before doing anything. A tampered client-side `currentUser.role` display value has zero effect on what the server will actually allow.

## Licensing

- **Client-side**: `pssRefreshLicenseStatus()` reads and displays `GET /api/license/status`'s response, shows banners/lock-screens accordingly.
- **Server-side (the actual boundary)**: `requireLicenseRead`/`requireLicenseWrite` middleware (`server/local.js`) query `tenant_licenses.status` fresh from the database on every request to a gated route (`GET/PUT /api/data`, `GET /api/data/users`, `GET /api/auth/sessions`, `POST /api/auth/add-staff`) and reject with `403` if the tenant is `PENDING_APPROVAL`/`SUSPENDED`/`ARCHIVED` (read+write) or `READ_ONLY` (write only). The client never sends its own opinion of the license status to the server — the server has no field like `licenseStatus` in any request body that it trusts.

## Admin access

- **Client-side**: a password field + `_adminHash()` computes a client-side hash purely to avoid transmitting the raw password, and to allow a quick local "wrong password" UX message.
- **Server-side (the actual boundary)**: every `/api/admin/*` route requires an `X-Admin-Key` header, compared against the server's own `ADMIN_KEY` (env var or its fallback) with `crypto.timingSafeEqual` — `requireAdminKey` middleware. This header is not derivable from anything else the client holds (it's not the same as a user JWT, not a role claim, not anything visible via DOM inspection unless the operator's own browser already has it, which is the legitimate admin's own credential).

## Subscriptions / plan / device limits

- **Client-side**: displays `plan_code`, `device_limit`, `devicesUsed` from the license-status response; the registration wizard *requests* a plan (Step 2).
- **Server-side (the actual boundary)**: `POST /api/auth/signup`'s `requestedPlan` is validated against the real `subscription_plans` table and only ever used to *default* the initial (still `PENDING_APPROVAL`, still access-nothing) plan assignment — an admin's `assign-plan`/`start-trial`/`approve` call is what actually sets the enforced `plan_code`/`device_limit`/`expires_at`. Device-limit enforcement itself happens inside `POST /api/auth/login`, counting real rows in `trusted_devices` server-side, before a session is even created — a client cannot claim "I have fewer devices than I do."

## Tenant ownership / isolation

- **Client-side**: none — the client doesn't compute or claim a tenant ID at all; it just holds whatever JWT it was issued.
- **Server-side (the actual boundary)**: `req.user.tenantId`, extracted from the verified JWT signature, is the *only* source of tenant scope for every database query. No endpoint accepts a tenant ID as a request parameter and trusts it (the one endpoint that takes a `:tenantId` URL param, every `/api/admin/tenant-licenses/:tenantId/*` route, is itself gated by `requireAdminKey` — a *different*, stronger trust boundary than tenant-JWT scoping, appropriate for an operator managing all tenants).

## Pricing

- Plan pricing/labels are defined in `subscription_plans` (server) and in one client-side `PLANS`-shaped constant used only for *display* on the legacy offline-desktop pricing screen — no endpoint accepts a client-supplied price or discount. Not applicable to the web/hosted licensing flow at all (no payment processing exists in this application, by explicit design — see the original project spec's "DO NOT: Introduce payment gateways").

## Authorization (general)

Every authenticated route follows the same pattern: `requireAuth` (verifies JWT signature+expiry+session-still-active) → `requireActive`/`requireLicenseRead`/`requireLicenseWrite` (tenant-status gates) → route-specific role checks inline (`if (req.user.role !== 'owner')`) → the actual handler, which only ever reads/writes rows scoped by `req.user.tenantId`. There is no code path where a client-supplied field substitutes for any step in this chain.

## Conclusion

Every one of the six categories called out (permissions, licensing, admin access, subscriptions, tenant ownership, authorization) has its real enforcement point server-side, confirmed by direct code reference above. The client-side checks that do exist (`_requireRole()`'s signature, the license-status UI banners) are explicitly UX/defense-in-depth layers, not the boundary — their absence, bypass, or a user having full DOM/DevTools access (already true before this change, on the main app) changes nothing about what the server will actually allow. Enabling the context menu introduces no new trust-boundary crossing anywhere in this list.
