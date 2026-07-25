# Security Review — Phase 2

Status: **PASS. No new risk introduced by enabling the context menu.**

Scope honesty note: the change under review is a **6-line removal** of a client-side `contextmenu` event listener (see `RightClickAudit.md`) — it touches zero server code, zero API contracts, zero auth logic. Most of the categories below were already reviewed in depth by prior engagements in this repo (`docs/architecture-review/SecurityReview.md`, `SecurityHardeningReview.md`, `SecurityHardeningPhase2.md`, `ElectronSecurityReview.md`/`ElectronSecurityHardening.md`, and this session's own `docs/deployment/SecurityDeploymentReview.md`). This review's job is to (a) confirm each area is genuinely unaffected by *this specific change*, not to re-litigate settled findings, and (b) spot-check the categories this session hasn't examined yet (SQL injection patterns, file uploads, path traversal, open redirect, SSRF). Findings are marked **[unaffected — prior review]** or **[checked fresh this session]** accordingly.

## Authentication — **[unaffected — prior review]**
Mobile+PIN, bcrypt (cost 10), JWT access tokens with algorithm pinning (`HS256` only). Right-click has never been part of the authentication boundary; removing its block changes nothing here.

## Authorization / Broken access control — **[unaffected — prior review]**
Every tenant-scoped query is filtered by `req.user.tenantId` derived from the verified JWT, never from client input. `requireAuth`/`requireActive`/`requireLicenseRead`/`requireLicenseWrite`/`requireAdminKey` are all server-side Express middleware — none of them read anything about mouse-button state or context menus.

## Session management — **[unaffected — prior review]**
`user_sessions` table, 15-min access token + 30-day rotating refresh token, revocation on logout/kill-sessions. Enabling right-click doesn't touch session creation, validation, or revocation code at all.

## JWT handling — **[unaffected — prior review]**
Signed with `JWT_SECRET` (mandatory at boot), verified with `{algorithms:['HS256']}` (prevents algorithm-confusion attacks). No JWT is stored anywhere retrievable via right-click that wasn't already retrievable via `sessionStorage`/`localStorage` inspection through DevTools — which right-click was never actually preventing access to in the first place (see `ClientSecurityReview.md` for the storage-location discussion).

## Cookie security — **N/A**
No cookies are used anywhere in this application. Auth is `Authorization: Bearer <token>` only — confirmed by grepping for `res.cookie`/`Set-Cookie` in `server/local.js`: zero matches. No cookie-based session to secure, and therefore no cookie-flag posture (`httpOnly`/`Secure`/`SameSite`) to regress.

## CSRF protection — **N/A, unaffected**
Not applicable for the same reason as above — CSRF requires an ambient credential (a cookie) the browser attaches automatically; a Bearer token in a JS-set header is not ambient and isn't attached by the browser to a forged cross-site request. Right-click has no relationship to this.

## CORS — **[unaffected — prior review]**
`server/local.js`'s CORS middleware allows all origins by default (documented, local/dev-friendly default) or an explicit allowlist via `ALLOWED_ORIGINS`. Neither behavior reads mouse/context-menu state. Unaffected.

## Rate limiting — **[unaffected — prior review]**
In-memory rate limiter on every auth-adjacent endpoint (login 10/5min, signup 5/10min, resend-verification 3/10min, etc. — full table in `docs/deployment/SecurityDeploymentReview.md`). Server-side, IP+path keyed, nothing to do with the client's context menu.

## XSS (stored / reflected / DOM) — **[unaffected — prior review, re-confirmed]**
The prior `SecurityHardeningReview.md`/`SecurityHardeningPhase2.md` engagement audited all 108 `innerHTML=` sites in the client and fixed the confirmed stored-XSS findings (S-1/S-2), guarded by `server/test/xss-regression.test.js` (28 assertions, still passing — see `VerificationReport.md`). Enabling right-click does not add a new `innerHTML` sink, does not change what user input reaches the DOM, and does not affect `escHtml()`/`esc()` output encoding anywhere. A user being *able* to right-click and "Inspect Element" does not let them inject anything that a determined attacker couldn't already do via DevTools opened through the browser's own menu (never blocked) — this was already true before this change.

## SQL / NoSQL injection — **[checked fresh this session]**
Grepped every `db.prepare()`/`db.exec()` call in `server/local.js` for string concatenation or template-literal interpolation of untrusted input into SQL text: **zero matches**. Every parameterized query uses `?` placeholders with values bound via `.run()/.get()/.all()` arguments — the standard `better-sqlite3` parameterization pattern, immune to injection by construction. No NoSQL datastore is used in the `local.js` path (SQLite only). Unaffected by, and unrelated to, this change either way.

## Input validation / Output encoding — **[unaffected — prior review]**
Mobile/PIN/email regex validation on every relevant endpoint (unchanged); `escHtml()`/`esc()` used consistently at render sites per the XSS hardening above. Not touched by this change.

## File uploads — **N/A**
Grepped for `multer`, `express-fileupload`, `req.files` — zero matches anywhere in `server/`. **This application has no file-upload endpoint at all** — zero attack surface in this category, unaffected by this change or otherwise.

## Download endpoints — **[checked fresh this session]**
The only "download" surfaces are client-side (`admExportCSV()` builds a CSV `Blob` and triggers a browser download — no server endpoint involved) and the cloud-backup pair `POST /api/cloud/backup` / `GET /api/cloud/restore/:keyHash`, both `requireAdminKey`-gated, keyed by a hash path param (not a filesystem path) — no path-traversal surface (confirmed: no `fs.readFile`/`createReadStream` call anywhere uses a request parameter as a filesystem path; the only non-constant `fs.readFileSync` call reads the fixed, hardcoded `.env` file location at boot).

## Password reset — **[unaffected — prior review]**
PIN reset (`/api/admin/reset-user-pin`, `/api/admin/tenant-licenses/:id/devices/limit` etc.) is admin-key-gated; the customer-facing "Forgot PIN" flow requires re-entering the license key. Unaffected.

## Registration — **[unaffected — prior review]**
`POST /api/auth/signup` validation, rate limiting, and email-verification-gated approval are all server-side (`RegistrationFlow.md`). Unaffected.

## Admin endpoints — **[unaffected — prior review]**
Every `/api/admin/*` route requires `X-Admin-Key`, compared with `crypto.timingSafeEqual` (not `===`, avoiding a timing side-channel). Right-click cannot forge this header — it's not readable or settable via DOM inspection, it lives only in `local.js` server memory / the admin operator's own request.

## Subscription APIs / License validation — **[unaffected — prior review]**
`requireLicenseRead`/`requireLicenseWrite` enforce the 5-state license machine server-side on every data-bearing route (`LicenseArchitecture.md`). A client that can now right-click has no new way to influence `tenant_licenses.status` — that column is never client-writable by any path.

## Trusted devices — **[unaffected — prior review]**
Device-limit enforcement happens at `POST /api/auth/login` server-side before a session is even created. Right-click grants no new ability to fabricate a `deviceId` that wasn't already fabricatable via DevTools console (unblocked on the main app already, and on 3 of 7 auth screens even before this change) or a basic HTTP client like `curl`. The actual security property here (a device limit, not device *authentication*) was never dependent on hiding the fingerprinting function's source.

## Tenant isolation / IDOR — **[unaffected — prior review]**
Every tenant-scoped table lookup filters on `tenant_id` derived server-side from the JWT (`req.user.tenantId`), confirmed across `server/test/wave1-sessions.test.js`'s cross-tenant checks and `server/test/concurrency-stress.test.js`'s tenant-isolation-under-load checks. No endpoint accepts a raw tenant ID or object ID from the client and trusts it without an ownership check — e.g. `POST /api/auth/sessions/:sessionId/revoke` explicitly verifies the session belongs to the caller's own tenant (404, not leaked as 403, for a cross-tenant attempt). None of this is reachable or influenced by whether the browser's context menu is enabled.

## Privilege escalation — **[unaffected — prior review]**
Role (`owner`/`staff`/`superadmin`) is carried in the signed JWT payload, not re-derived from anything client-supplied per-request beyond that token. The client does have a role-tamper *integrity check* (`_requireRole()`/`_sigOf()`, an HMAC-like signature over the current-user object, to catch someone doing `currentUser.role='owner'` in DevTools) — this is defense-in-depth on top of, not instead of, every real privilege check being server-side (an attacker who bypasses the client check still hits `role !== 'owner'` checks in the actual API handlers). Right-click access doesn't change what's reachable through DevTools, which was already fully reachable before this change on the main app.

## Race conditions — **[unaffected — prior review]**
Optimistic concurrency (`tenant_data.version`) prevents lost updates under concurrent saves — `server/test/wave0-concurrency.test.js` and `concurrency-stress.test.js` (2/5/10/20 simulated actors). Unrelated to context-menu state.

## Session fixation / hijacking — **[unaffected — prior review]**
Session IDs are server-generated (`crypto.randomBytes`), never accepted from the client at login. A hijacked token (however obtained) is exactly as powerful with or without right-click enabled — right-click was never a barrier to token theft (tokens live in `sessionStorage`/`localStorage`, readable via DevTools console regardless, and DevTools access was already unblocked on the main app).

## Replay attacks — **[unaffected — prior review]**
Refresh-token rotation with reuse-detection (`server/sessions.js`) — presenting an already-rotated refresh token outside the same-device grace window is treated as theft and rejected. Unrelated to this change.

## API authorization — **[unaffected — prior review]**
Every mutating endpoint re-checks role/tenant/license-status server-side, independent of anything the UI does or doesn't restrict.

## Sensitive logs / Error disclosure / Stack traces — **[unaffected — prior review, re-confirmed]**
`docs/deployment/SecurityDeploymentReview.md` (this session) already grepped every log statement for PIN/password/token/secret leakage — none found. Client and server error responses return generic, specific-but-non-leaky messages (`SecurityHardeningPhase2.md`'s S-9 fix: the `generate-key` error path no longer interpolates `e.message`, verified by `server/test/security-phase2.test.js`). None of this depends on whether a user can right-click a page to view its rendered output — the *server's* response body is identical either way.

## Directory traversal — **[checked fresh this session]**
No endpoint accepts a client-supplied filesystem path. See "Download endpoints" above.

## Open redirect — **[checked fresh this session]**
Grepped for `res.redirect` anywhere in `server/local.js`: zero matches. No redirect surface exists to abuse.

## SSRF — **[checked fresh this session]**
Grepped for outbound HTTP calls from the server itself (`fetch(`, `axios.`, `http.request`, `https.request`) driven by request input: zero matches in `server/local.js`. The only outbound-request-shaped code (`wa.me` WhatsApp links) is client-side, browser-initiated navigation to a fixed domain — not a server-side fetch, and not attacker-controllable beyond a phone number that's already validated input.

## Electron security — **[unaffected — prior review]**
`ElectronSecurityReview.md`/`ElectronSecurityHardening.md` already covered `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:false` removal, `will-navigate` restriction, and `setWindowOpenHandler` narrowing. Grepped `main.js`/`preload.js` fresh this session for any Electron-level `context-menu` override or `before-input-event` interception: **none exists** — Electron's native right-click behaves exactly like the web build, governed by the same page JS this change modifies. No separate Electron-specific right-click restriction to reconcile.

## Verdict

No category above is weakened by removing the `contextmenu` block. Every real security boundary in this application (auth, session, tenant isolation, license enforcement, rate limiting, input validation, output encoding) is enforced server-side and was never dependent on, nor even correlated with, whether the browser's native right-click menu was available. Proceeding to Phase 3.
