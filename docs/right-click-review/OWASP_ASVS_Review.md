# OWASP ASVS Level 1 Review — Phase 3

Status: **Substantially compliant.** A handful of genuine, pre-existing (not introduced by this change) gaps are recorded below with honest severity ratings — this is not a "zero findings" report, per the instruction not to claim the application has no vulnerabilities.

Scope: this evaluates the application's ASVS Level 1 posture as it stands *after* the right-click change, to confirm the change itself introduces no regression against any control. It is not a from-scratch ASVS certification audit — where a control was already assessed in a prior engagement, that's cited rather than re-derived.

## V1 — Architecture, Design and Threat Modeling
- **1.1 Secure SDLC**: Informal but real — every change in this repo goes through a documented audit/test/verification cycle (see `docs/architecture-review/` and `docs/deployment/`). **PASS.**
- **1.2 Authentication architecture**: JWT + server-side session table, documented in `SessionArchitecture.md`. **PASS.**
- **1.4 Access control architecture**: Tenant-scoped queries derived from JWT claims only. **PASS.**

## V2 — Authentication
- **2.1 Password/PIN security**: bcrypt cost-10 hashing, 4-6 digit PIN, no plaintext storage anywhere (grep-verified this session in `SecurityDeploymentReview.md`). **PASS.**
- **2.2 General authenticator security**: Rate-limited login (10/5min), no user enumeration on login failure beyond a generic "incorrect PIN"/"mobile not registered" pair. **PASS.**
- **2.3 Authenticator lifecycle**: PIN reset requires admin action or license-key re-verification. **PASS.**
- **2.7 Out-of-band verification**: Email verification (new this engagement) uses a 24h-expiring, single-use, hashed token. **PASS.**

**Finding (Low)**: `ADMIN_KEY` has a well-known default fallback hash if the operator never sets a real one. `GET /health` surfaces `adminKeyIsDefault: true` in that case, and `docs/deployment/EnvironmentSetup.md` calls this out as a deploy-blocking item — but nothing in the *code* prevents booting with the default in production the way the missing-`JWT_SECRET` check does. **Recommendation**: consider failing loudly (like `JWT_SECRET`) rather than just warning, for a future hardening pass — out of scope to change in *this* engagement (would be a business-logic/behavior change, not a right-click-adjacent fix).

## V3 — Session Management
- **3.2 Session binding**: Sessions tied to a signed JWT + server-side row; revocation actually invalidates the token immediately (verified, `wave1-sessions.test.js`). **PASS.**
- **3.3 Session logout/timeout**: 15-min access token, 30-day refresh with rotation; explicit logout revokes the session. **PASS.**
- **3.7 Defenses against session hijacking**: Refresh-token reuse detection. **PASS.**

## V4 — Access Control
- **4.1 General access control**: Server-side role/tenant checks on every endpoint, not client-trusted (see `TrustBoundaryReview.md` for the full enumeration). **PASS.**
- **4.2 Operation-level access control**: IDOR-style checks present (e.g. session-revoke ownership check returns 404 for cross-tenant, not 403). **PASS.**
- **4.3 Other access control considerations**: Admin routes gated by a separate credential (`X-Admin-Key`), not just a role claim on the same token a regular user could obtain. **PASS.**

## V5 — Validation, Sanitization and Encoding
- **5.1 Input validation**: Mobile/PIN/email format validation server-side on every relevant endpoint. **PASS.**
- **5.2 Sanitization**: `escHtml()`/`esc()` applied consistently at every confirmed injection-risk render site (prior XSS hardening engagement, regression-guarded). **PASS.**
- **5.3 Output encoding**: Same as above. **PASS.**
- **5.5 Deserialization**: `JSON.parse`/`JSON.stringify` only, no unsafe deserialization (`eval`, `vm`, `Function` constructor on untrusted input) found in server code. **PASS.**

**Finding (Informational)**: the client's own DevTools-detection trick (`RightClickAudit.md` finding #4) constructs a function via `['constructor']('debugger')` — this is *dynamic code construction*, but on a hardcoded literal string (`'debugger'`), never on any user- or server-supplied input. Not a real deserialization/injection risk, flagged only for completeness since it's the one place in the codebase resembling dynamic-code-execution syntax.

## V7 — Error Handling and Logging
- **7.1 Log content**: No PIN/password/token/secret ever logged (grep-verified, `SecurityReview.md` this engagement and `SecurityDeploymentReview.md`). **PASS.**
- **7.4 Error handling**: Generic client-facing error messages, real errors logged server-side only (`security-phase2.test.js` regression-guards the one historical leak, S-9, now fixed). **PASS.**

## V8 — Data Protection
- **8.1 General data protection**: Tenant data isolated by `tenant_id`, never mixed across tenants (concurrency-tested). **PASS.**
- **8.2 Client-side data protection**: JWT access token in `sessionStorage` (tab-scoped), refresh token in `localStorage` (a documented, deliberate 30-day-persistence tradeoff — see `SessionArchitecture.md`). **PASS with a documented tradeoff**, not a gap — the alternative (httpOnly cookies) would reintroduce CSRF, a worse trade for this app's threat model.
- **8.3 Sensitive data in storage**: The offline-license `MASTER_SECRET` and crypto engine are stripped server-side before any browser ever receives the HTML (`stripLicenseSecrets()`) — this is the control that actually matters for this ASVS item, verified again in `ClientSecurityReview.md` (Phase 5, next). **PASS.**

## V9 — Communications
- **9.1 Client communication security**: The app itself doesn't terminate TLS (`server/local.js` is plain HTTP) — TLS is expected to be provided by a reverse proxy in production, documented explicitly in `docs/deployment/DeploymentChecklist.md`'s HTTPS section. **Finding (Medium, pre-existing, already documented)**: a deployment that skips the reverse-proxy/HTTPS step would serve everything — including Bearer tokens in headers — over plaintext HTTP. This is a real risk if the checklist isn't followed, not a code defect; already flagged in Phase 6 of the deployment-readiness engagement, repeated here because ASVS 9.1 specifically calls for it.

## V10 — Malicious Code
- **10.1 Code integrity**: `package-lock.json` committed and used (`npm install` reproducible); no known-malicious dependency patterns observed. No formal SCA (software composition analysis / dependency vulnerability scan) has been run as part of any reviewed engagement. **Finding (Low)**: recommend running `npm audit` (or an equivalent SCA tool) as a standing practice, not currently part of the CI pipeline.

## V11 — Business Logic
- **11.1 Business logic security**: License status transitions, device limits, and subscription gating are all server-enforced state machines, not client-trusted (see `LicenseArchitecture.md`). **PASS.**

## V12 — Files and Resources
- **12.1 File upload**: N/A — no file upload endpoint exists anywhere in this application (verified fresh, `SecurityReview.md` Phase 2). **N/A.**
- **12.3 File execution**: N/A, same reason.

## V13 — API and Web Service
- **13.1 Generic API security**: Every API response is JSON (or, for the one HTML-returning endpoint, `verify-email`, a static confirmational page with no user-controlled script injection point). Rate-limited, authenticated, and authorized per-endpoint. **PASS.**

## V14 — Configuration
- **14.1 Build and deployment**: No build step for the server/client (documented, `BuildVerificationReport.md`); dependencies pinned via lockfile. **PASS.**
- **14.4 HTTP security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a `Content-Security-Policy` are all set server-side on every response (grep-verified this session). **PASS** — see `DevOpsReview.md` (Phase 6) for the full header inventory and any gaps (e.g. no `Strict-Transport-Security` set by the app itself, since HSTS is a reverse-proxy/TLS-layer concern per the deployment checklist).

## Severity summary

| Severity | Count | Items |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | V9.1 — plaintext HTTP if the reverse-proxy/HTTPS step is skipped (deployment-process risk, already documented, not a code defect) |
| Low | 2 | V2 — `ADMIN_KEY` default fallback only warns, doesn't fail boot; V10.1 — no standing dependency/SCA scan in CI |
| Informational | 1 | V5.5 — dynamic-code-construction pattern used for DevTools detection, on a hardcoded literal only, not a real risk |

## Verdict

No Critical or High findings. The two Low findings and one Medium finding are all pre-existing, already-documented operational/process items, unrelated to and unaffected by enabling the context menu. Proceeding to Phase 4.
