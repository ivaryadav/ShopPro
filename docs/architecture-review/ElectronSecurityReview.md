# Electron Security Review

Re-examines `main.js`/`preload.js` from scratch against the 7 areas this task named, going beyond `SecurityHardeningReview.md`'s S-5/S-6 findings with a static analysis technique those findings didn't use: exhaustively grepping every actual usage pattern in `app/ShopERP_Pro_v8.html` that `webSecurity:false` could plausibly be protecting, rather than reasoning about the setting in the abstract. Neither `main.js` nor `preload.js` was modified — this is a determination, per this task's own instruction ("Determine... Generate: ElectronSecurityReview.md," no implementation named, unlike Task 2).

## 1. `webSecurity: false`

**Current state**: `main.js` line 20, with a comment: `// Allow data: URLs for local file (QR codes, logos)`.

**What `webSecurity: false` actually disables** (Chromium/Electron-documented behavior, not specific to this app): the same-origin policy for `fetch`/`XMLHttpRequest` (so cross-origin calls succeed regardless of the target's CORS headers), mixed-content blocking, and some sandboxing checks around the `file://` origin. It does **not** gate whether `<img src="data:...">` or `background-image:url(data:...)` render — those are same-document resource loads, not subject to CORS, and work identically whether `webSecurity` is `true` or `false`. This is standard, long-standing web-platform behavior, not an Electron-version-specific detail.

**Exhaustive check of what this app actually needs it for** — every `data:` URI usage in the ~16,000-line client, found via `grep -n "data:image\|data:application"` (not sampled):
```
<img class="sup-avatar" src="data:image/jpeg;base64,...">           (line 50, and 4 more identical shapes)
style="background-image:url('data:image/jpeg;base64,...')"          (customer/staff photos)
style="background-image:url('data:image/svg+xml,...')"              (an inline SVG icon)
```
**Every single occurrence is an `<img src>` or CSS `background-image: url()`.** There is no `fetch('data:...')`, no `XMLHttpRequest` to a `data:` URI, no `<script src="data:...">`. None of these require `webSecurity: false` — the comment's stated justification does not match what the setting actually gates.

**Checked whether anything else in this app might genuinely need it**:
- **The app's own API calls** (`_api`/`fetch(SHOPERPRO_API_URL + ...)`) — cross-origin from a `file://`-loaded page to `http(s)://<server>`. This is exactly the kind of call `webSecurity:false` would matter for — **except** `server/local.js`'s own CORS configuration (line 267-275) already sends permissive CORS headers: `if (!origin) return cb(null, true)` (covers Electron's `file://`-origin requests, which typically carry no `Origin` header) and, even for browser-origin requests, defaults to allow-all unless an operator explicitly sets `ALLOWED_ORIGINS`. The server-side permissiveness makes `webSecurity:false` redundant for this traffic — the server already grants what the client-side flag would otherwise be needed to bypass.
- **Third-party CDN assets** (Spline viewer, Google Fonts, unpkg, jsdelivr — all present in the CSP's allow-list): loaded via `<script src>`/`<link>` tags, which are never CORS-gated regardless of `webSecurity`. The Spline viewer's own internal asset fetches go to Spline's own domain, which — being a public SaaS platform serving a public embeddable viewer — can be expected to send permissive CORS on its own public assets (standard practice for such platforms), though this specific claim about a third-party's server behavior cannot be verified via static analysis of code this project doesn't own.

**Determination**:
1. **Exploitable**: Yes, structurally — `webSecurity:false` disables same-origin protections app-wide for the renderer, not just for the `data:` URLs the comment names. Combined with a successful XSS (if one existed unfixed and reached the Electron-loaded copy — `S-1`/`S-2` are now fixed per `SecurityFixReport.md`, reducing the realistic likelihood), injected script would face no cross-origin restriction on outbound requests. Today, with S-1/S-2 fixed, there is no known live path to trigger script execution inside the Electron build specifically — Electron mode's own input surface (machine-locked licensing, no remote registration flow) is narrower than the web/hosted mode's, as `SecurityHardeningReview.md` S-5 already noted. Likelihood: **Low** (no known trigger), Impact if triggered: **Medium-High** (no cross-origin restriction on exfiltration).
2. **Fixes backward compatible**: Very likely yes, based on the exhaustive `data:` URI audit above — every current usage is a rendering pattern unaffected by `webSecurity`. Not stated as certain, because the Spline third-party viewer's internal behavior isn't auditable from this codebase, and this sandboxed environment cannot launch Electron's GUI to confirm empirically (`ELECTRON_RUN_AS_NODE=1` prevents it, unchanged from every prior attempt this engagement).
3. **Exact risk level**: **Medium** (unchanged from `SecurityHardeningReview.md` S-5's original assessment — this review adds evidence, not a new severity).
4. **Minimal remediation**: remove the `webSecurity: false` line entirely (a one-line deletion — `data:` rendering needs no replacement, per the audit above). **Not implemented in this task** — Task 1's instruction is to determine, not implement, and the one genuine residual uncertainty (Spline's real-world behavior) is exactly the kind of thing that should be confirmed by a real click-through before shipping a change to this specific setting, consistent with how this finding has been handled at every prior pass.

## 2. `nodeIntegration`

**Current state**: `false` (`main.js` line 18). Correct, modern baseline. No `nodeIntegrationInSubFrames` or `nodeIntegrationInWorker` overrides exist either (checked — not present anywhere in `main.js`). No finding.

## 3. `contextIsolation`

**Current state**: `true` (`main.js` line 19). Correct, modern baseline, matches `nodeIntegration:false` as the complementary half of the standard secure configuration. No finding.

## 4. Preload exposure

**Current state** (`preload.js`, 9 lines total): sets `window.isElectronApp = true` and `window.electronPlatform = process.platform` directly inside a `DOMContentLoaded` listener — **not** via `contextBridge.exposeInMainWorld()`, which is Electron's documented, recommended mechanism for safely bridging values from an isolated preload context into the page's main world under `contextIsolation:true`.

**A genuine uncertainty, flagged rather than guessed at**: whether a direct `window.foo = ...` assignment inside a `contextIsolation:true` preload script reliably becomes visible to the page's own scripts is a real nuance of Electron's isolated-worlds model — Electron's own documentation recommends `contextBridge` specifically because direct assignment is not the guaranteed-correct pattern. This engagement's own prior documents have treated `window.isElectronApp` as something the app's code successfully reads (the previously-documented `SHOPERPRO_API_URL` truthiness bug is framed as a narrower, separate issue, not as "isElectronApp never arrives at all") — but that was not independently re-verified here, and this sandboxed environment cannot launch the Electron GUI to check the page's actual `window.isElectronApp` value at runtime. **This is a functional-correctness question first and a security question only secondarily** (whether or not it reaches the page, nothing sensitive is exposed either way), so it's noted here for completeness rather than scored as a security finding.

`ipcRenderer` is `require()`'d (line 5) but never used for anything — no channel is sent on or listened for. Dead code, not a security exposure (importing the module doesn't expose any capability to the page without either `contextBridge` or a channel handler, neither of which exists).

**Determination**: no sensitive data or privileged function is exposed either way (boolean/string platform flags only) — this remains Finding S-6's "clean" conclusion, unchanged. **Recommendation** (informational, not a risk-driven fix): migrating to `contextBridge.exposeInMainWorld('electronAPI', {isElectronApp: true, platform: process.platform})` would be the textbook-correct pattern and would resolve the uncertainty above outright — but isn't a security fix, since there's nothing sensitive at stake, so not proposed as a required remediation.

## 5. IPC exposure

**Current state**: checked exhaustively (`grep -n "ipcMain\." main.js` and `grep -n "contextBridge" preload.js`) — **zero** `ipcMain.handle`/`ipcMain.on` registrations exist in `main.js`, and **zero** `contextBridge` calls exist in `preload.js`. There is no IPC channel wired in either direction. A malicious renderer script (however it got there) has no IPC surface to call — not "a restricted one," genuinely none.

**Determination**: no finding. This is the maximally minimal IPC posture available.

## 6. Navigation restrictions

**Current state**: `main.js` has **no `will-navigate` handler**. `webContents.setWindowOpenHandler` (line 35) is correctly implemented and does restrict *new-window* opens (`window.open()`, `target="_blank"` links) — `http`/`https` URLs are routed to `shell.openExternal()` and denied inside the Electron window, everything else is allowed to open a new window unrestricted (see §7 below for why that second half matters). But `setWindowOpenHandler` does **not** govern **same-window navigation** — a script setting `location.href = 'https://attacker.example'`, or a `<a href="...">` click without `target="_blank"`, would navigate the existing `BrowserWindow` directly, unrestricted, since no `will-navigate` listener intercepts it.

**This is a genuinely new finding** — not named in `SecurityHardeningReview.md`, which only assessed `webSecurity`/`nodeIntegration`/`contextIsolation`/preload, not navigation. **Exploitability**: requires a script-execution vector inside the Electron-loaded page first (same precondition as the `webSecurity:false` finding above) — with S-1/S-2 fixed and no other known trigger in Electron mode's narrower input surface, there's no current live path. If one existed, unrestricted same-window navigation could redirect the user's entire app window to an attacker-controlled page (phishing the shop owner inside what looks like their own POS window) or to a `file://` URL reading another local file. **Risk level: Low-Medium** (same precondition-gating as webSecurity:false — no known trigger today, but the consequence class — the whole app window being hijacked to an arbitrary origin — is more visually deceptive than a same-page XSS alone would be).

**Minimal remediation**: add a `will-navigate` handler that denies navigation to any origin other than the app's own `file://` path (and, if hosted mode's URL is ever loaded in Electron, that specific origin) — a standard ~6-line addition:
```js
mainWindow.webContents.on('will-navigate', (event, url) => {
  const allowed = url.startsWith('file://' + path.join(__dirname, 'app'));
  if (!allowed) event.preventDefault();
});
```
**Not implemented in this task** — same reasoning as `webSecurity`: this is new code touching Electron's navigation behavior, and this sandboxed environment can't launch the GUI to confirm a legitimate in-app navigation (e.g. `Reload`/`Force Reload` menu items, or the app's own `showPage()`-style in-document navigation, which doesn't trigger `will-navigate` since it's not a full-document navigation) isn't inadvertently blocked. Flagged as a specific, scoped, ready-to-implement fix for a future pass that includes live verification.

## 7. External URL handling

**Current state**: `setWindowOpenHandler` (line 35-41) — `http`/`https` URLs open via `shell.openExternal()` (the correct, safe pattern: hands off to the OS's default browser, outside Electron's privileged context) and are denied inside the Electron window. **Everything else falls through to `{ action: 'allow' }`** — meaning a `file://`, `javascript:`, or custom-protocol URL passed to `window.open()` would be allowed to open a **new, unrestricted `BrowserWindow`** (Electron's default new-window behavior for an allowed open request, which — unless explicitly configured otherwise — would inherit dangerous defaults, not necessarily this app's own hardened `webPreferences`).

**Exploitability**: same precondition as above (requires a script-execution vector first) — no known trigger today. If triggered, `window.open('javascript:...')` specifically is blocked by Chromium itself regardless of this handler (browsers refuse `javascript:` as a `window.open()` target as a baked-in protection, unrelated to this app's code) — so the realistic residual gap is a `file://` URL opening an unrestricted second window, which could then read arbitrary local files if that new window doesn't inherit `nodeIntegration:false`/`contextIsolation:true` (Electron's default `BrowserWindow` created via an *allowed* `window.open()` does **not** automatically inherit the opener's `webPreferences` unless explicitly set). **Risk level: Low** (requires script execution first, requires the new window to somehow load attacker-chosen local content, several steps deep).

**Minimal remediation**: narrow the fallthrough from `{action:'allow'}` to `{action:'deny'}` for anything that isn't `http`/`https` (the two schemes actually intended to be handled), since no legitimate app flow currently relies on `window.open()` for anything else — checked via `grep -n "window.open" app/ShopERP_Pro_v8.html`, confirming no call site passes a non-http(s) URL. **Not implemented in this task**, same reasoning as above.

## Summary

| Item | Current state | Risk | Exploitable today | Fix backward compatible | Implemented this task |
|---|---|---|---|---|---|
| `webSecurity: false` | disabled | Medium | No known live trigger | Very likely (exhaustive `data:` URI audit found no dependency); Spline's own behavior unverifiable statically | No — determination only |
| `nodeIntegration` | `false` (correct) | None | — | — | N/A, already correct |
| `contextIsolation` | `true` (correct) | None | — | — | N/A, already correct |
| Preload exposure | 2 non-sensitive flags, direct assignment not `contextBridge` | None (security); functional uncertainty flagged | — | `contextBridge` migration would be backward compatible (same 2 values) | No — informational only |
| IPC exposure | zero channels wired | None | — | — | N/A, nothing to fix |
| Navigation restrictions | no `will-navigate` handler | **Low-Medium — new finding** | No known live trigger | Likely, pending live confirmation | No — determination only |
| External URL handling | `http`/`https` correctly deferred to OS browser; other schemes fall through to allow | Low | No known live trigger, several steps deep | Likely, pending live confirmation | No — determination only |

**No code was changed to produce this document.** All four flagged items (`webSecurity`, navigation restrictions, external URL fallthrough, and the informational preload note) have specific, minimal, ready-to-implement fixes — none applied here because each genuinely benefits from a live Electron launch to confirm zero regression, which remains outside what this sandboxed environment can perform, consistent with every prior pass at this same constraint.
