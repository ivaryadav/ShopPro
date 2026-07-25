# Independent Security Review — Release Approval Board

Every item below was re-verified directly against `server/local.js`, `server/sessions.js`, `app/ShopERP_Pro_v8.html`, and a live isolated test server — not against prior security reports. File:line references point at the reviewed evidence. Where a claim from a prior engagement is confirmed, that is stated explicitly as an independent re-confirmation, not an inherited assumption.

## 1. Super Admin Backdoor — CONFIRMED removed, but a related fallback survives

`grep -rn "_SAK_H|_checkSAK|_migrateLegacySAK|SuperAdminKey|SUPER_ADMIN_KEY" app/ server/` returns **zero matches**. The undocumented Super-Admin-Key bypass described in the prior right-click engagement is genuinely gone from both the client and any server-side equivalent.

However, independent investigation of the surrounding admin-authentication code (`server/local.js:65`) surfaced a **related, not-previously-flagged-as-such issue**:

```js
const ADMIN_KEY  = process.env.ADMIN_KEY || '2b5877210c3581cccac2431c0a5681ea1c5674ae71dbb5d664eda93e3965a3dd';
```

If the operator never sets `ADMIN_KEY` in `server/.env`, the admin credential silently falls back to a **fixed, publicly-committed SHA-256 hash** — the exact same hash is also embedded in the client at `app/ShopERP_Pro_v8.html:5278` as `_LOCAL_ADMIN_PWD_HASH` (used by the offline-desktop admin login). This is:
- **Documented and warned about** — `local.js:92-95` logs `logger.warn('ADMIN_KEY not set — using the default admin key hash', ...)` at boot, and `GET /health` exposes `startup.adminKeyIsDefault: !process.env.ADMIN_KEY` (verified live: `curl /health` on a default-config test server returns `"adminKeyIsDefault": true`).
- **Not fatal** — unlike `JWT_SECRET` (`local.js:45-52`, which calls `process.exit(1)` if unset), an unset `ADMIN_KEY` lets the server boot and serve traffic normally.
- **A single, unsalted, publicly-known hash checked into two files in the repository.** Anyone with read access to this repository (which will include this GitHub repo once pushed) has the exact hash and can attempt offline cracking of it indefinitely, with no rate limit, no account lockout, and no way for the vendor to detect or block the attempt — because the attack happens entirely offline against a hash the attacker already has. We could not recover the plaintext from a short common-password dictionary in the time available for this review, which proves nothing about its strength either way.
- **Actively fingerprintable pre-authentication**: `GET /health` requires no credentials at all and tells an attacker, for free, whether a given deployment is still using this exact known hash — turning "is this target vulnerable" into a single unauthenticated HTTP request.

**Verdict: this is not the same defect as the removed SAK backdoor (it is documented and does not silently bypass any check), but it is a real, live, default-on weak-credential fallback with a public disclosure vector via `/health`.** Severity: **High** in a hosted/multi-tenant deployment where an operator might reasonably forget to set `ADMIN_KEY`; lower in the single-shop offline-desktop product, where the same fixed hash has always been the factory-default local admin password by design (a different product with a different, previously-accepted trust model) and is expected to be changed by the shop owner.

**Recommendation**: make `ADMIN_KEY` fail-fast like `JWT_SECRET` for the hosted/`local.js` deployment, or at minimum stop returning `adminKeyIsDefault` from an unauthenticated endpoint.

## 2. No hidden developer bypass — CONFIRMED, with one important exception documented separately

No other hardcoded credential, magic header, or debug-only auth shortcut was found anywhere in `server/local.js`, `server/sessions.js`, or `server/mailer.js` (full-file read plus targeted grep for `bypass|backdoor|debug.*auth|X-Debug|X-Internal`, zero matches beyond the already-discussed `ADMIN_KEY` default). See `CodeAudit.md` for the exhaustive pattern sweep.

The one genuine authorization gap found in this review — a **live-reproduced ability for a legacy-terminated/paused tenant to still add staff accounts and enumerate users** — is not a "bypass" in the sense of a secret credential, but a real, exploitable gap in how two systems (the legacy `tenants.status` column and the new `tenant_licenses.status` column) fail to stay in sync. Full reproduction and evidence: `APIAudit.md`, Finding API-1 (Critical).

## 3. bcrypt migration — CONFIRMED complete for both admin and user credentials

- `server/local.js:14` — `bcryptjs` required.
- User PIN hashing: every `INSERT INTO users` path (`local.js:756`, `816`, `1056`) and every PIN-reset path (`1270`) calls `bcrypt.hashSync(pin, 10)`. Login verification (`940`) uses `bcrypt.compareSync`. **No SHA-256 or any other algorithm is used for user credentials anywhere** — confirmed by grepping every `createHash('sha256')` call site (`local.js:682,745,818,869,902,1086,1165`) and manually classifying each: license-key hashing (high-entropy random key, not a password), email-verify-token hashing (high-entropy random token, not a password), and the legacy admin-hash comparison (see below, not a user credential). None hash a low-entropy user secret with SHA-256.
- Admin credential migration: `admin_credentials` table (`local.js:286-291`) stores `algo` per row; `POST /api/admin/login` (`local.js:1152-1189`) verifies bcrypt if `algo==='bcrypt'`, else does a legacy SHA-256 timing-safe comparison and **transparently upgrades to bcrypt on that successful legacy login** (`local.js:1160-1173`). Independently re-ran `test/admin-auth-migration.test.js` (14 assertions, 0 failed) confirming: the same original password keeps working after migration, no reset is required, and — critically — sending the raw legacy hash or the raw bcrypt hash directly as `X-Admin-Key` (the old anti-pattern) now correctly fails with 401, proving a hash can no longer be replayed as a static bearer credential.

**Verdict: genuinely complete, no SHA-256 authentication remains for actual user or admin passwords.** The residual issue is exclusively the *default value* discussed in §1, not the *algorithm*.

## 4. User enumeration — CONFIRMED fixed

`POST /api/auth/login` returns the identical `'Invalid mobile number or PIN.'` message and identical HTTP status for both "mobile not registered" and "correct mobile, wrong PIN" (confirmed by reading the handler and by independently re-running `test/auth-enumeration.test.js`, 6/6 passed). The client (`app/ShopERP_Pro_v8.html`, `pssLogin()`) no longer branches on the removed `'not registered'` substring. Detailed reasons are logged server-side only via `logger.warn()`, never returned to the caller.

**One deliberate, disclosed scope boundary, independently confirmed still true**: the signup endpoint's duplicate-mobile-number message (`'This mobile number is already registered. Please sign in.'`, `local.js:814` and `849`) still explicitly confirms an account exists. This is a different, lower-risk surface (an attacker learns a mobile number is *registered*, not that a specific *password guess* was close) and is a standard, common UX tradeoff (most consumer apps do this on signup) — but it is a real, live enumeration vector on the signup path that was scoped out, not resolved, and should be named as such rather than implied to be covered by "user enumeration removed."

## 5. Permissions-Policy — CONFIRMED implemented

`local.js:623-625` sets a fully locked-down `Permissions-Policy` (camera/microphone/geolocation/payment/usb/magnetometer/gyroscope/accelerometer/interest-cohort all `()`). Verified live via `devops-hardening.test.js` (re-run independently, 19/19 passed) that this header is present on every response and every pre-existing header (CSP, X-Frame-Options, etc.) is byte-identical to before.

## 6. Compression — CONFIRMED enabled, correctly scoped

`local.js:637` — `app.use(compression())`, placed after security headers (so headers are never skipped for compressed responses) and before route handlers. Verified live: gzip activates only when `Accept-Encoding` allows it, decompressed content is byte-identical to the uncompressed version, and JSON API responses still parse correctly through the same middleware.

## 7. Security headers — CONFIRMED present, one real gap found

Present and verified live: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (above), `Content-Security-Policy` (below). **`Strict-Transport-Security` (HSTS) is not set anywhere in `local.js`.** This is defensible *if* HSTS is set at the reverse-proxy layer (the deployment docs correctly state TLS termination happens there, not in the app) — but nothing in this codebase enforces or even checks that the proxy actually adds it, and no documentation explicitly calls out HSTS as something the proxy config must include (the existing `DeploymentChecklist.md` covers HTTPS and reverse-proxy routing but does not name HSTS specifically). Recommend adding an explicit HSTS reminder to the deployment checklist, since its absence is invisible until someone runs a header scanner against production.

## 8. CSP — CONFIRMED present, with a known, unavoidable-for-now weakening

`local.js:626-628`: `default-src 'self'` with `frame-ancestors 'none'`, but `script-src` includes both `'unsafe-inline'` and `'unsafe-eval'`. This materially weakens CSP's ability to stop reflected/stored XSS from becoming code execution — an attacker who successfully injects a `<script>` tag or event handler is not blocked by this CSP the way a nonce/hash-based policy would block them. This is a pre-existing, previously-documented tradeoff (the app is a single large HTML file with extensive inline `<script>` blocks and no build step to hash or nonce them) — independently confirmed still true and still the single biggest thing keeping CSP from being a strong second line of defense against XSS. Not new to this engagement, but real and worth restating plainly rather than letting "CSP implemented" imply "CSP is strong."

## 9. CORS — a real, live default-permissive gap

`local.js:599-611`:
```js
const _allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : null;
app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true);
    if (!_allowedOrigins) return cb(null, true); // no restriction configured
    ...
  },
  credentials: true,
}));
```
If `ALLOWED_ORIGINS` is unset (and it has no required-at-boot check the way `JWT_SECRET` does), **every origin is reflected and allowed, with `credentials: true`.** In isolation this combination (any-origin + credentials) is a well-known CORS anti-pattern. **Mitigating factor, independently confirmed**: this app authenticates exclusively via `Authorization: Bearer` headers — `grep -n "res.cookie|req.cookies|cookie-parser" server/ → zero matches`. Browsers do not automatically attach an `Authorization` header cross-origin the way they do cookies, so the classic "steal the session via permissive CORS + credentialed cookie" exploitation path does not apply here today. The practical residual risk is: any future code change that *does* introduce a cookie (e.g., a "remember me" feature) would silently inherit an already-wide-open CORS policy. **Recommend making `ALLOWED_ORIGINS` a hard requirement in production (or at least defaulting `credentials` to `false` since no cookie exists to justify it today), rather than relying on "we don't currently use cookies" as the only reason this is safe.**

## 10. CSRF — no CSRF token mechanism exists, and independently, none is currently required

No `csrf`/`csurf` package, no anti-CSRF token generation/validation anywhere in `local.js`. Given the confirmed Bearer-token-only auth model (§9), this is the architecturally correct posture — CSRF specifically exploits ambient credentials (cookies) that browsers attach automatically; a page on another origin cannot forge an `Authorization: Bearer <token>` header without already having the token, at which point CSRF is not the relevant threat model. **Verdict: no CSRF vulnerability today, contingent entirely on cookies never being introduced** — flagged as a standing architectural invariant to watch, not a gap to fix now.

## 11. JWT validation — CONFIRMED sound

`requireAuth` (`local.js:405-417`) calls `jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] })` — the algorithm allowlist is explicitly pinned to `HS256`, which closes the classic "alg: none" / RS256-to-HS256 key-confusion attack class. `JWT_SECRET` has no fallback and fails the entire boot if unset (`local.js:45-52`) — correctly treated as more critical than `ADMIN_KEY`, which is the opposite, weaker posture (see §1). Session validity is additionally checked server-side per request via `sessions.checkSession()` against the `user_sessions` table (so a JWT that is cryptographically valid but belongs to a revoked/logged-out session is still rejected) — this is a real, meaningful defense-in-depth layer beyond stateless JWT trust, independently confirmed by reading `sessions.js` and by the passing `wave1-sessions.test.js` suite (27 assertions).

## 12. Rate limiting — CONFIRMED present and broadly applied, one real gap

A hand-rolled, dependency-free, in-memory limiter (`local.js:507-525`) is applied to every authentication and admin-mutation route (verified by listing every route declaration: 25 of the file's `app.post` routes carry a `rateLimit(...)` middleware). It is IP+path keyed and correctly reads `req.ip` (works behind a reverse proxy because `app.set('trust proxy', 1)` is set at `local.js:597`, so `req.ip` reflects `X-Forwarded-For` as long as the proxy is configured to only forward its own trusted value). **Gap, previously undocumented**: the limiter is a plain in-memory `Map` — it resets to zero on every process restart and does not coordinate across multiple server processes/instances. A horizontally-scaled deployment (more than one Node process behind a load balancer) would have effectively no rate limiting at all across instances, since each process tracks its own counters independently. This matches the app's current single-instance deployment model (confirmed via the deployment docs, which describe one Node process behind one reverse proxy), so it is not wrong for *today's* architecture, but it is a real scalability ceiling that should be called out explicitly rather than silently assumed away if the deployment model ever changes.

**Separately noted**: `express-rate-limit` is a declared dependency in `server/package.json` but is never `require`'d by `local.js` — only the vestigial `server/index.js` uses it. A minor, cosmetic dependency-hygiene note, not a security issue.

## 13. Session management — CONFIRMED sound

15-minute JWT access tokens + 30-day rotating opaque refresh tokens, both hashed at rest (`refresh_token_hash`), with a documented 20-second reuse-grace window for legitimate multi-tab races (`sessions.js:18-26`) and full revocation support (`revokeAllTenantSessions`, used by both the automatic sweep and manual admin suspend/kill-sessions actions). Independently re-verified via `wave1-sessions.test.js` (27/27) and `license-suspension.test.js` (23/23) both passing.

## 14. Tenant isolation — CONFIRMED strong on the data plane, exception on admin plane is by design

Every non-admin, tenant-scoped query in `local.js` sources `tenant_id` exclusively from `req.user.tenantId` (the JWT payload set at login, never client-suppliable) — confirmed by grepping every `tenant_id` reference outside `/api/admin/*` routes; none read `req.body.tenantId`/`req.query.tenantId`. This means there is no IDOR path for one tenant to read or write another tenant's data through any regular endpoint. `req.params.tenantId` is used exclusively inside `/api/admin/*` routes, which are correctly, and by design, cross-tenant (an admin operating on any shop) and gated by `requireAdminKey`.

## 15. Admin authorization — CONFIRMED sound for the auth mechanism itself; see API-1 for a related gap

The bcrypt-migrated, session-token-based `requireAdminKey` (§3) is itself sound. The gap found in this review (Finding API-1, `APIAudit.md`) is not in *how* admin auth is verified, but in *what a specific admin action actually accomplishes* once verified — the legacy "Terminate/Pause Account" admin action does not fully lock the target tenant out of every endpoint.

## 16. License authorization — CONFIRMED sound for tenants with a `tenant_licenses` row; fail-open by explicit design otherwise

`requireLicenseRead`/`requireLicenseWrite` (`local.js:447-468`) correctly gate `PENDING_APPROVAL`/`SUSPENDED`/`ARCHIVED` (read) and additionally `READ_ONLY` (write). Both explicitly **fail open** (`if (!lic) return next();`) when no `tenant_licenses` row exists for a tenant — a deliberate, commented design choice ("shouldn't happen post-backfill, but fail open rather than break a request over a missing row"). Independently confirmed this is not merely theoretical: `POST /api/auth/register` (the still-live legacy registration endpoint) **never creates a `tenant_licenses` row**, and the automatic backfill only runs once, at server boot, for tenants that exist *at that moment* — a tenant registered via this legacy path after the most recent restart has no license row and therefore no license-based read/write gating at all until the next restart. See `APIAudit.md` Finding API-1 for the live reproduction of the concrete consequence of this.

## 17. Trusted devices — CONFIRMED implemented as designed

`trusted_devices` table with a `UNIQUE(tenant_id, user_id, device_id)` constraint, auto-trust under the plan's `device_limit` and hard rejection over it (confirmed via `license-devices.test.js`, 25/25 passed, independently re-run). Soft-remove only (`is_active` flag, never a hard delete) — consistent with the project's stated "never delete customer data" principle.

## 18. Client secrets — one genuine finding, otherwise clean

No API keys, database credentials, or SMTP secrets are embedded in `app/ShopERP_Pro_v8.html` (grepped for common key-shaped strings and `smtp`/`db_password`-style identifiers, zero matches beyond the app's own public-facing `SHOPERPRO_API_URL` config point). The one real client-embedded secret is the offline-desktop `_LOCAL_ADMIN_PWD_HASH` constant already discussed in §1 — a fixed, unsalted hash, which is an inherent, previously-accepted property of the offline-desktop product's trust model (the whole app ships to the end user's machine; there is no server to keep a secret from an attacker with local access) and is out of scope for this review's mandate (hosted/web-mode hardening), but is worth restating precisely because it is the *same value* re-appearing as the *hosted-mode default* discussed in §1 — the two are not independent risks, they are the same one hash serving two different products' fallback credential.

## 19. Environment secrets — CONFIRMED not committed

See `RepositoryReview.md` §Repository hygiene — full-history scan found zero secrets, `server/.env` confirmed untracked and gitignored.

## 20. Hardcoded credentials — see §1, §18; no others found

Exhaustive pattern sweep in `CodeAudit.md` found no additional hardcoded credentials beyond the one already discussed.

## 21. Source maps — CONFIRMED absent

No `.map` files anywhere in the tracked tree, no `sourceMappingURL` comment in `app/ShopERP_Pro_v8.html`. Not applicable regardless — there is no build/minification step, so there is no source to map from.

## 22. Debug code / console logging — one minor finding

No `debugger` statements anywhere. 23 `console.log` calls in `local.js`, 22 of which are pure operational/informational output (boot banner, session-cleanup counts, admin-action audit lines). **One genuine finding**: `local.js:1878` prints the first 16 hex characters of the active `ADMIN_KEY` hash to stdout at every boot (`` `║  ${ADMIN_KEY.slice(0,16)}...` ``). Truncated to 64 of 256 bits, so this alone cannot reconstruct the full hash or the underlying password — but printing *any* portion of a credential-adjacent secret to stdout is bad hygiene in environments where boot logs are captured by a log aggregator, `systemd` journal, or Docker logging driver, all of which typically have broader read-access than the secret store itself. Low-to-medium severity; trivial to fix (remove the value from the printed banner, or print only a non-secret confirmation like "custom key configured: yes/no", which the `/health` endpoint's `adminKeyIsDefault` field already provides more safely — modulo §1's finding that that field itself is over-exposed to unauthenticated callers).

## Summary table

| # | Item | Verdict |
|---|---|---|
| 1 | Super Admin backdoor removed | **Confirmed removed** — related default-hash fallback found, High |
| 2 | No hidden developer bypass | **Confirmed**, except the live-reproduced tenant-status gap (see API-1, Critical) |
| 3 | bcrypt migration | **Confirmed complete** |
| 4 | No SHA-256 password auth | **Confirmed** for all real credentials |
| 5 | User enumeration removed | **Confirmed on login**; signup duplicate-check still confirms existence (disclosed scope gap) |
| 6 | Permissions-Policy | **Confirmed** |
| 7 | Compression | **Confirmed** |
| 8 | Security headers | **Confirmed**, HSTS gap (proxy-dependent, unverified) |
| 9 | CSP | **Confirmed present**, `unsafe-inline`/`unsafe-eval` weakens it |
| 10 | CORS | Default-permissive when unconfigured — real gap, low practical exploitability today |
| 11 | CSRF | Not applicable — architecturally mitigated by Bearer-only auth |
| 12 | JWT validation | **Confirmed sound**, alg pinned |
| 13 | Rate limiting | **Confirmed present**, single-process-only limitation |
| 14 | Session management | **Confirmed sound** |
| 15 | Tenant isolation | **Confirmed strong** |
| 16 | Admin authorization | **Confirmed sound mechanism**; see API-1 for a scope gap |
| 17 | License authorization | **Confirmed as designed**; fail-open path is real and reachable (API-1) |
| 18 | Trusted devices | **Confirmed** |
| 19 | Client secrets | One pre-existing, accepted, out-of-scope offline-mode constant |
| 20 | Environment secrets | **Confirmed clean** |
| 21 | Hardcoded credentials | Limited to §1/§18, both understood and disclosed |
| 22 | Source maps | **Confirmed absent** |
| 23 | Debug code / console logging | Clean except one partial-secret print (Low-Medium) |

No finding in this phase alone is disqualifying. Combined with the Critical finding in `APIAudit.md`, see `ReleaseApproval.md` for the aggregated decision.
