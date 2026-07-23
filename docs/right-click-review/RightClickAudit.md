# Right-Click / Browser-Restriction Audit — Phase 0

Status: **Complete. No changes made yet** (this document is read-only research).

Scope note: this and every doc under `docs/right-click-review/` belong to a self-contained review of one specific, small change (enabling the native context menu). Two of the requested filenames (`SecurityReview.md`, `VerificationReport.md`) already exist in `docs/architecture-review/` from prior engagements — to avoid overwriting that history, this engagement's reports live in this new, dedicated directory instead.

## Method

Searched `app/ShopERP_Pro_v8.html` (the entire client), `main.js`, and `preload.js` (the Electron main/preload processes) for every category requested: `contextmenu`, `copy`/`paste`/`cut` events, `drag`/`dragstart` events, `selectstart`, keyboard-shortcut interception (`keydown` listeners), DevTools/F12/Ctrl+Shift+I/Ctrl+U blocking, and any CSS-level `user-select` restriction. Also checked Electron's `main.js`/`preload.js` for a native `context-menu` override (Electron can suppress the OS-native right-click menu independently of the web page's own JS) — none exists.

## Findings

All 4 findings live in one place: the "App Hardening" IIFE, `app/ShopERP_Pro_v8.html:7456-7494`.

| # | File : Line | What it does | Still required? | Recommendation |
|---|---|---|---|---|
| 1 | `app/ShopERP_Pro_v8.html:7458-7462` | Overrides `console.log/info/debug/warn/table/group*/time*/count` to a no-op in every browser session (keeps `console.error`). | **Not a right-click/copy/paste block** — out of scope for this change, not touched. Its actual purpose is hiding internal debug chatter from a casual "View Source → Console" look; it has no bearing on the license secret (that's protected server-side, see `TrustBoundaryReview.md`) and no bearing on right-click. | Leave as-is. Unrelated to this objective. |
| 2 | `app/ShopERP_Pro_v8.html:7464-7469` | `contextmenu` listener: calls `e.preventDefault()` — blocks the native right-click menu — but **only** while one of 7 specific pre-login screens is visible (`portal-select-screen`, `activation-screen`, `new-user-screen`, `admin-login-screen`, `setup-pin-screen`, `user-select-screen`, `pin-login-screen`). The main authenticated app (`#app`) is **not** in this list — right-click already works there today. | **No.** Client-side `preventDefault()` on `contextmenu` is trivially bypassed (disable JS, browser menu → "More Tools" → Developer Tools, type `view-source:` directly in the address bar, or right-click a different, unblocked page element like a text input). It blocks zero real attacks and only inconveniences legitimate users (no "open link in new tab," no browser spell-check menu, no "Inspect" for accessibility tooling) on exactly the screens where users most need help (activation, first-time setup). The thing it was presumably trying to protect — the offline-license `MASTER_SECRET` and crypto engine — is **already** removed from the HTML before it's ever sent to a browser, by `stripLicenseSecrets()` in `server/local.js` (fails closed if it can't find the exact block to strip). That server-side control makes this client-side one redundant even in its own stated goal. | **Remove.** This is the finding this change acts on. |
| 3 | `app/ShopERP_Pro_v8.html:7471-7482` | `keydown` listener (capture phase): blocks `F12`, `Ctrl+Shift+I`, `Ctrl+Shift+J`, `Ctrl+Shift+C`, `Ctrl+U` — but only on 4 of those same pre-login screens (not `admin-login-screen` or `user-select-screen`, and not the main app). | **No**, same reasoning as #2 — trivially bypassed via the browser's own menu (⋮ → More Tools → Developer Tools needs no keyboard shortcut at all), and DevTools already works freely on the main app and 3 of the 7 auth screens today. | **Out of scope for this change** (the request is specifically about right-click/copy/paste/select, not DevTools/F12) — left untouched. Flagged here since it's the same category of theater; happy to remove in a follow-up if wanted, but not silently bundled into this change. |
| 4 | `app/ShopERP_Pro_v8.html:7484-7493` | A timing-based DevTools-open heuristic (`debugger` statement inside a dynamically-constructed function — pauses noticeably if DevTools is open and breakpoints-on-debugger-statements is enabled). On detection, just recolors some auth-screen labels red — no functional block, no redirect, no logout. | Already inert against any DevTools user with breakpoints off (the common case), and does nothing functionally significant even when it does fire. | **Out of scope for this change**, left untouched — it doesn't block right-click, copy, paste, or selection, and doesn't gate any real functionality either way. |

## What was searched for and found to be **absent** (confirms no other restrictions exist)

- **Copy/paste/cut blocking**: zero `addEventListener('copy'|'paste'|'cut', ...)` calls anywhere in the client.
- **Drag blocking**: zero `dragstart`/`drag` event listeners.
- **Text-selection blocking**: zero `selectstart` listeners. CSS `user-select:none` appears on a handful of decorative/clickable elements (buttons, a background watermark, table rows with an `onclick` handler) — standard UX practice to stop accidental highlight-on-click, not a security or anti-scraping measure. Notably, `user-select:all` is used *to make copying easier* on machine-ID, license-key, and admin-key display boxes — the opposite of a restriction.
- **Electron-level right-click suppression**: `main.js`/`preload.js` contain no `context-menu` event override, no `before-input-event` interception. Electron's native context menu behaves exactly as the web version does (governed by the same page JS).

## Verdict

Exactly one finding is in scope and recommended for removal: **#2, the `contextmenu` blocker**. Proceeding to Phase 1 with only that change. Findings #3 and #4 are documented for transparency but intentionally left untouched — they weren't asked for, and unilaterally expanding scope to remove them isn't this phase's call to make silently.
