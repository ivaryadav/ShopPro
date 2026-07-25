# Authentication — Identity & Tenant Core (Phase 2)

Covers the hosted/SaaS mode only. Desktop authentication (`app/ShopERP_Pro_v8.html`'s own client-side, machine-salted SHA-256 PIN scheme) is a separate, unrelated system, out of scope (`docs/adr/0003-desktop-offline-architecture.md`).

## Login (`POST /api/auth/login`)

Mobile + PIN, matching `local.js:965-1037` exactly:
1. Mobile normalized to digits only; both mobile and PIN required (400 if not).
2. User looked up by mobile among **active** users only (`userRepository.findActiveByMobile`).
3. PIN checked via `bcrypt.compareSync` against the stored hash.
4. **Anti-enumeration, verified by test**: "no such account" and "wrong PIN" produce the byte-for-byte identical response — `401 { error: 'Invalid mobile number or PIN.' }`. The real reason is logged server-side only (`getLogger().warn(...)`), never returned to the caller. See `services/authService.js`'s test file for the assertion that both failure paths produce an identical error object.
5. If `deviceId` is sent, Trusted Device enforcement runs (see `SessionLifecycle.md`). Absent `deviceId` = old client build, unaffected — matches `local.js:991` exactly.
6. On success: `last_login` touched, a real session created (JWT + refresh token), and the response returned with the same field names `local.js` uses (`token`, `refreshToken`, `shopName`, `username`, `role`, `licenseExpiry`, `licensePlan`).

## PIN — password hashing

`bcryptjs`, cost factor **10**, matching every `bcrypt.hashSync(_, 10)` call in `local.js` exactly (verified by `regression.test.js`). No SHA-256, no custom hashing — this phase introduces no new hashing scheme.

## PIN Reset

`local.js`'s only PIN-reset path (`POST /api/admin/reset-user-pin`) is gated by `requireAdminKey` — the `AdminCredentials`/Super Admin system, out of scope for Phase 2 (Administration domain). The underlying business rule is implemented and tested (`services/userService.js`'s `resetPin`): **exactly 6 digits required** — a real, pre-existing inconsistency with `addStaff`'s 4-6 digit rule, preserved as-is, not "fixed" (per the mission's explicit instruction). No public HTTP route exposes this in Phase 2; it's a tested, ready-to-wire service capability for whichever future phase migrates Administration.

## JWT

- Algorithm pinned to **HS256** at verification time (`requireAuth.js`) — matches `local.js:424` exactly, closing the classic `alg:none`/RS256-confusion attack class.
- Payload: `{ userId, tenantId, role, shopName, sid, jti }` — identical field set to `sessions.js`'s `signAccessToken`.
- Access token TTL: **15 minutes**. Refresh token TTL: **30 days** (enforced by the session's own idle-expiry logic, not a JWT claim — see `SessionLifecycle.md`).
- `JWT_SECRET` has no fallback and fails fast (`config/jwt.js` throws if unset) — matches `local.js`'s posture exactly, and is stricter than `ADMIN_KEY`'s (out of scope) soft default.

## Authorization

Table-driven (`docs/adr/0006-table-driven-authorization.md`) — `requirePermission(code)` middleware replaces `local.js`'s ad hoc `role !== 'owner'` checks, seeded to produce identical outcomes for the 3 real, in-scope gates (`sessions:view`, `sessions:revoke`, `staff:add`). `GET /api/data/users` (list users) has no gate on either side — any authenticated, active tenant user may call it, matching `local.js` exactly.

## Rate limiting

Same hand-rolled, dependency-free, in-memory limiter as `local.js` (not the unused `express-rate-limit` package), with the same windows: login 10/5min, refresh 30/5min, add-staff/sessions 30/1min. See `middleware/rateLimit.js`.

## What is NOT covered here

Registration/signup (Licensing-entangled, deferred — see `docs/architecture/Architecture.md`), Admin authentication (`AdminCredentials`, out of scope), Desktop PIN authentication (separate system, out of scope).
