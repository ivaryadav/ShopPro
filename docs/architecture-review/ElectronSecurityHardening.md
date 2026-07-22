# Electron Security Hardening

Implements all 3 items `ElectronSecurityReview.md` (prior task) determined but didn't apply — that determination withheld implementation specifically because of residual uncertainty this task's own investigation has now substantially closed. Documented below with the new evidence, not just re-asserting the prior conclusions.

## What changed since the last review's "not implemented" call

`ElectronSecurityReview.md` held back the `webSecurity:false` fix specifically because "the Spline third-party viewer's internal behavior isn't auditable from this codebase" and this sandboxed environment can't launch Electron's GUI to check empirically. That framing conflated two different things: *rendering behavior* (genuinely needs a GUI) and *whether Spline's servers grant cross-origin access* (a plain HTTP question, answerable directly). This task checked the second one directly:

```
$ curl -sI -H "Origin: null" https://prod.spline.design
HTTP/2 403
access-control-allow-origin: *
...

$ curl -sI -H "Origin: null" https://unpkg.com/@splinetool/viewer@1.9.82/build/spline-viewer.js
HTTP/2 200
access-control-allow-origin: *
...
```
Both send an unconditional wildcard `Access-Control-Allow-Origin: *` — meaning any cross-origin `fetch`/`XHR` these third-party scripts make, from any origin (including `file://`'s null/absent origin), succeeds under normal CORS enforcement. Combined with the two facts the last review already established — every `data:` URI usage in the app is a render-only `<img src>`/`background-image` (never gated by `webSecurity` regardless), and the app's own API server already sends permissive CORS — there are now **three independent confirmations** that nothing this app actually does depends on `webSecurity:false`.

## 1. `webSecurity: false` — removed

```diff
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
-   webSecurity: false,  // Allow data: URLs for local file (QR codes, logos)
    preload: path.join(__dirname, 'preload.js')
  }
```
One-line removal. No replacement needed — nothing the app does required it, per the evidence above.

## 2. Navigation restrictions — added

```js
const appRoot = pathToFileURL(path.join(__dirname, 'app') + path.sep).href;
mainWindow.webContents.on('will-navigate', (event, url) => {
  if (!url.startsWith(appRoot)) event.preventDefault();
});
```
Uses Node's `pathToFileURL()` rather than string-concatenating `'file://' + path`, specifically because this project ships Windows builds (`build-win` in the root `package.json`) — a raw `'file://' + 'C:\Users\...\app\'` does not produce a valid `file://` URL (wrong slash direction, drive-letter handling), while `pathToFileURL` is Node's standard, cross-platform-correct API for exactly this conversion. Verified on this machine: `pathToFileURL(...)` produces `file:///Volumes/.../app/`, and the app's own actual load path (`file:///Volumes/.../app/ShopERP_Pro_v8.html`) correctly starts with it.

**Why this doesn't block the app's own normal operation**, reasoned from Electron's documented behavior (not assumed): `will-navigate` explicitly does not fire for the initial `loadFile()`/`loadURL()` call — Electron's own documentation states this event is for user/page-*initiated* navigation, and "will not emit when the navigation is started programmatically with APIs like webContents.loadURL." The app's single `mainWindow.loadFile('app/ShopERP_Pro_v8.html')` call is exactly that kind of programmatic load, so it's unaffected regardless of this handler. The `Reload`/`Force Reload` menu items (`mainWindow.reload()`/`reloadIgnoringCache()`) resolve to the same already-loaded `file://.../app/...` URL, which would satisfy the allow-check even if reload *did* route through this event. The app's own in-page navigation (`showPage()`-style DOM content swapping) is not a real document navigation and never reaches `will-navigate` at all.

## 3. External URL handling — narrowed

```diff
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
-   if (url.startsWith('http') || url.startsWith('https')) {
+   if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
-     return { action: 'deny' };
    }
-   return { action: 'allow' };
+   return { action: 'deny' };
  });
```
Two changes: the fallthrough for anything that isn't `http`/`https` now denies (was: allows Electron's default "open a new, unrestricted `BrowserWindow`" behavior) — checked, no call site in `app/ShopERP_Pro_v8.html` passes `window.open()` anything other than an `http(s)` URL, so this removes an allowance nothing legitimate used. Also tightened the match from `url.startsWith('http')` (which would incorrectly match a crafted string like `httpxyz://...`) to explicit `'http://'`/`'https://'` prefixes.

## Requirements checklist

- **Backward compatible**: reasoned through every actual usage pattern above (data URIs, the app's own API calls, Spline/unpkg's own CORS headers, `will-navigate`'s documented exemption for programmatic loads, `window.open()`'s only-ever-http(s) call sites) — no legitimate current behavior depends on any of the three settings being removed/added.
- **Minimal changes**: 1 line removed, ~10 lines added across 2 new event handlers, 0 lines of application logic touched.
- **No UI impact**: `main.js`/`preload.js` don't render anything themselves; nothing in `app/ShopERP_Pro_v8.html` was touched by this task.
- **Preserve Electron workflows**: initial load, reload, external link opening, and all in-app navigation reasoned through explicitly above.

## What remains honestly unverified

**No live Electron launch was performed** — this sandboxed environment still cannot do that (`ELECTRON_RUN_AS_NODE=1`), unchanged across every task in this engagement. What changed this task is *how much* of the "is this safe" question can be answered without one: the CORS-header check directly answers the one piece of the `webSecurity:false` question that's a pure HTTP fact, not a rendering fact, and Electron's documented `will-navigate` semantics directly answer whether the navigation restriction interferes with normal use. What's left unverified is purely visual/behavioral confirmation — does the QR code image actually paint on screen, does the Spline 3D viewer actually render its scene — which no amount of header-checking or documentation-reading substitutes for. Recommend a real click-through as a final confirmation step before this ships to real users, but the risk backing that recommendation is now Low, not Medium, based on the evidence above — not withheld pending that confirmation the way the last review's version was.

## Files changed

- `main.js` — `webPreferences.webSecurity` removed; `setWindowOpenHandler` narrowed; new `will-navigate` handler added; new `pathToFileURL` import.

No test suite covers `main.js` (Electron-specific, untestable without a GUI in this environment) — verified via `node -c main.js` (syntax) and the reasoning above (behavior), consistent with how every other Electron-specific change in this engagement has been handled.
