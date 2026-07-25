# Security Deployment Review — Phase 5

Status: **PASS.** This is a deployment-readiness spot-check of security-relevant behavior already built and reviewed in depth across the prior `docs/architecture-review/` engagement (`SecurityReview.md`, `SecurityHardeningReview.md`, `SecurityHardeningPhase2.md`) and the licensing-feature phase (`LicenseArchitecture.md`). Nothing here is a new finding requiring a code change — this phase re-verifies each area concretely against the current code, right before shipping.

## Authentication

- Login is mobile + PIN (`POST /api/auth/login`, `server/local.js:866`), PIN hashed with bcrypt (cost factor 10) — never stored or logged in plaintext.
- JWT access tokens are signature- and expiry-checked, **and algorithm-pinned** (`{algorithms: ['HS256']}`, `local.js:391`) — prevents an algorithm-confusion attack where a token signed with a different algorithm using the same secret bytes would otherwise be accepted (verified by `server/test/security-phase2.test.js`, run fresh for this report: HS384-signed tokens with the same secret are rejected with 401).
- `JWT_SECRET` is mandatory at boot — an unset secret fails the server to start rather than falling back to a per-boot random value (which would silently invalidate every session on every restart). No default, no fallback.

## Sessions

- Every login/register/signup mints a `user_sessions` row (`server/sessions.js`) tied to the JWT via a `sid` claim — a cryptographically valid, unexpired token is still rejected if its session has been revoked (`checkSession()`), which is what makes `logout`, per-session revoke, and the new licensing `kill-sessions` admin action actually work.
- Refresh tokens rotate on every use; presenting an already-rotated token is treated as a theft signal and rejected (not silently re-issued) outside a short same-device multi-tab grace window. Verified by `server/test/wave1-sessions.test.js` (27 assertions, re-run fresh: theft-detection-after-grace-window case passes).
- `revokeAllTenantSessions()` (new this phase, `server/sessions.js`) is the mechanism behind both the automatic READ_ONLY→SUSPENDED sweep transition and the manual admin "Suspend"/"Kill Sessions" actions — confirmed to actually invalidate every active session for a tenant, verified by `server/test/license-suspension.test.js` and `license-state-machine.test.js`.

## License middleware

- `requireLicenseRead`/`requireLicenseWrite` (`local.js`) are wired onto every data-bearing route: `GET /api/data`, `PUT /api/data`, `GET /api/data/users`, `GET /api/auth/sessions`, `POST /api/auth/add-staff` — confirmed by direct grep, matching exactly what `LicenseArchitecture.md` documents.
- Both middlewares run **after** the existing `requireActive` check (legacy pause/terminate/expiry gate) — the new gate is additive, it never bypasses or weakens the old one.
- Fail-open only for tenants with no `tenant_licenses` row at all (pre-feature tenants that haven't been through the backfill yet, which shouldn't exist post-deploy per `MigrationSafetyReport.md`) — every other case (`PENDING_APPROVAL`/`READ_ONLY`/`SUSPENDED`/`ARCHIVED`) fails closed with a `403` and a machine-readable `licenseStatus` field.

## Trusted devices

- Device identity is the client's browser/hardware fingerprint (`generateBrowserMachineId()`), sent as an **optional** `deviceId` on login — a request with no `deviceId` (an old client build) gets byte-identical old behavior; this was a deliberate compatibility choice, not an oversight.
- Over-limit devices are rejected with `403 {code:'DEVICE_LIMIT_REACHED'}` **before** a session is created (`local.js:901`) — a rejected device never gets a valid token, confirmed by `server/test/license-devices.test.js`.
- Device removal is soft (`is_active=0`), never a hard delete — preserves an audit trail for support/security investigation.

## Rate limiting

Every auth-adjacent endpoint that could be abused (credential stuffing, registration spam, token-refresh flooding) has an in-memory, no-new-dependency rate limiter (`local.js`, confirmed by grep):

| Endpoint | Limit |
|---|---|
| `/api/auth/login` | 10 / 5 min |
| `/api/auth/register` (legacy) | 5 / 10 min |
| `/api/auth/signup` | 5 / 10 min |
| `/api/auth/resend-verification` | 3 / 10 min |
| `/api/auth/refresh` | 30 / 5 min |
| `/api/auth/verify-license` | 20 / 5 min |

All admin `/api/admin/*` mutation endpoints are additionally rate-limited (30–60 per minute depending on the action) on top of requiring the `X-Admin-Key` header.

## Password/PIN hashing

Every PIN-setting code path — `register`, `signup`, `add-staff`, `admin/reset-user-pin`, `admin/reset-pin` — hashes with `bcrypt.hashSync(pin, 10)` before storage (confirmed by grep: 5 call sites, all cost factor 10, zero plaintext-storage call sites found). PINs are never logged; the one PIN-reset log line records *who* (user id/name/mobile), never the PIN value itself.

## Input validation

Consistent across every endpoint that accepts them: mobile numbers require ≥10 digits after stripping non-digits, PINs must match `/^\d{4,6}$/`, and (new this phase) email addresses must match a basic `local@domain.tld` shape before `/api/auth/signup` accepts them. Every validation failure returns `400` with a specific, non-leaky message — never a stack trace or raw exception text to the client (confirmed in the prior `SecurityHardeningPhase2.md` review and unchanged by this phase's additions).

## No sensitive logs

Grepped every `console.log`/`console.error`/`logger.*` call in `server/local.js` for any that might print a PIN, password, JWT, refresh token, or SMTP credential — found none. Log lines reference identifying metadata only (user ID, display name, mobile number, tenant/shop name, event type) — e.g. `[Admin] PIN reset for user 42 (Ravi Kumar)`, never the PIN itself. `server/mailer.js`'s boot-time SMTP failure log prints only the connection error message, never the configured password.

## Verdict

No security regressions or new gaps found. Every area reviewed matches what's already documented and tested in the prior architecture-review engagement and the licensing-feature phase. Proceeding to Phase 6.
