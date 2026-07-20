# Security Fix Report — S-1 and S-2

Implements the two confirmed findings from `SecurityHardeningReview.md`. No other findings from that review (S-3 through S-12) were touched — out of scope per this task's explicit "implement only the already confirmed findings" instruction.

## S-1: Stored XSS via `u.name` — `app/ShopERP_Pro_v8.html:6351`

**Change**: wrapped both interpolated values in `pssLicenseVerify()`'s user-list rendering in `escHtml()`:

```diff
- btn2.innerHTML='<div class="pss-user-avatar">'+initials+'</div><div><div class="pss-user-info-name">'+u.name+'</div>...
+ btn2.innerHTML='<div class="pss-user-avatar">'+escHtml(initials)+'</div><div><div class="pss-user-info-name">'+escHtml(u.name)+'</div>...
```

`u.name` was the confirmed sink (`SecurityHardeningReview.md` S-1). `initials` was additionally wrapped even though its exploitability is much lower (derived from `u.name.split(' ').map(w=>w[0])`, so at most a stray leading character survives, not a full tag) — escaping it is free and closes even that narrow theoretical gap, consistent with "minimal code change" (one extra function call, not a redesign).

`roleLabel` on the same line was **not** wrapped — it's a fixed ternary of three hardcoded strings (`'Owner'|'Manager'|'Staff'`), never derived from user input, so escaping it would be a no-op that adds nothing.

**Requirements checklist**:
1. Minimal code change — 2 function-call wrappers, same line, no other edits to this function. ✅
2. UI behavior preserved — `escHtml()` only affects strings containing `&`, `<`, `>`, `"`; a legitimate name/initials value (letters, spaces, numbers) renders character-for-character identically. ✅
3. Formatting preserved — no whitespace/indentation changes beyond the two wrapper calls. ✅
4. Regression test added — see `XSSRegressionReport.md`. ✅
5. Cross-tenant exploitation verified no longer possible — see `XSSRegressionReport.md` §Verification. ✅

## S-2: toast()/confirm() escaping gaps

**Scope correction, stated plainly**: `SecurityHardeningReview.md` grouped `toast()` and `confirm()` together as "message-building call sites" with a shared risk pattern. Re-verifying before fixing found this was **imprecise for `confirm()`**: `window.confirm()` is never overridden anywhere in the file (checked — no `function confirm(` or `confirm =` reassignment exists), so every `confirm(...)` call in the app is the **native browser confirmation dialog**, which renders its argument as plain text, not HTML. It is not an `innerHTML` sink and cannot execute injected markup. The two `confirm()` call sites carrying an unescaped name (`u.name` at line 6005, `dup.name` at line 11122) were **left unchanged** — wrapping them in `escHtml()` would be a no-op for security (nothing to neutralize) and a real, if minor, **display regression** for names containing `&`, `<`, `>`, or `"` (native `confirm()` would show the literal escaped entities as text, e.g. `O&#39;Brien` instead of `O'Brien`). This correction is captured as an explicit negative-control assertion in the regression test.

**`toast()` real sink, confirmed**: `toast(msg,type)` (`app/ShopERP_Pro_v8.html:3902-3909`) builds `t.innerHTML=\`<span>${icon}</span><span>${msg}</span>\`` — genuinely unescaped HTML injection if `msg` contains an unescaped free-text field.

**Call-site audit**: re-ran the audit rather than trusting the original review's "representative, not exhaustive" example list. Grepped every `toast(` call for variable interpolation (`grep -n "toast(" ... | grep -E "\+[a-zA-Z_]|\$\{[a-zA-Z_]"`), then judged each match against its actual source (free-text user field vs. system-generated ID/number/enum/error-message). Found **20 real sinks total** (the S-1 site plus 19 `toast()` sites) — 8 more than the original review's illustrative examples named, all in the same confirmed category (product names, customer names, shop names, staff/user names, expense category names) the review already scoped in as S-2.

**Minimal escaping utility**: none added — `escHtml()` already exists (`app/ShopERP_Pro_v8.html:14971`, used correctly at 193 other call sites) and is in scope at every fix site via function-declaration hoisting (all 20 sites live inside the file's single `<script>` block spanning lines 3256+). Introducing a second, duplicate helper would violate "minimal changes only."

### All 20 fixed call sites

| Line | Function context | Field | Fix |
|---|---|---|---|
| 6351 | `pssLicenseVerify()` | `u.name`, `initials` | S-1, above |
| 4395 | PIN set | `u.name` | `escHtml(u.name)` |
| 4562 | PIN updated | `u.name` | `escHtml(u.name)` |
| 7904 | duplicate customer match | `dup.name` | `escHtml(dup.name)` |
| 8419 | duplicate IMEI (add product) | `dup.name` | `escHtml(dup.name)` |
| 8468 | duplicate IMEI (edit product) | `dup.name` | `escHtml(dup.name)` |
| 9187 | cart stock limit | `prod.name` | `escHtml(prod.name)` |
| 9235 | qty-change stock limit | `item.name` | `escHtml(item.name)` |
| 10385 | warranty part insufficient stock | `prod.name` | `escHtml(prod.name)` |
| 10576 | out of stock | `p.name` | `escHtml(p.name)` |
| 10644 | repair part stock limit | `prod.name` | `escHtml(prod.name)` |
| 14345 | staff added | `name` | `escHtml(name)` |
| 5544 | admin: key generated | `shopName` | `escHtml(shopName)` |
| 5799 | admin: account paused | `c.shopName` | `escHtml(c.shopName)` |
| 5818 | admin: account terminated | `c.shopName` | `escHtml(c.shopName)` |
| 5827 | admin: account restored | `c.shopName` | `escHtml(c.shopName)` |
| 5836 | admin: server status synced | `shopName` | `escHtml(shopName)` |
| 6095 | admin: web PIN reset | `userName` | `escHtml(userName)` |
| 9384 | checkout stock-insufficient list | `item.name` | `escHtml(item.name)` (escaped at construction, in the array-building line, not at the later `.join()` call — same effective result, cleaner source) |
| 11634 | expense category added | `n` (from `window.prompt()`, **no client-side filter at all**) | `escHtml(n)` |

**Sites deliberately left unchanged** (checked, confirmed not real sinks, per "no speculative improvements"):
- `p.unit` (line 8503) — a fixed 4-option `<select>` dropdown (`pcs`/`pair`/`box`/`set`), not free text.
- `fieldErr(id, msg)` call sites (e.g. 8419, 8468's first argument) — uses `.textContent`, not `innerHTML`; already safe, and wrapping in `escHtml()` there would be a display bug (literal `&amp;` shown as text).
- `d.error` / `e.message` / `r.message` reflected server/exception messages (e.g. 6087, 5545, 9573, 14407) — a different, unconfirmed risk category (reflected error content) not named in `SecurityHardeningReview.md`'s S-2 finding; not touched to stay within the task's explicit scope.
- The two `confirm()` sites (6005, 11122) — see scope correction above.
- `_glassModal()` (admin pause/terminate dialogs, lines 5787/5806) — audited; both its only two call sites already correctly wrap `c.shopName` in `esc()`. Nothing to fix.
- `_auditLog('user-remove','name='+u.name...)` (line 14352) — writes to `DB.auditLog`, an in-memory array; confirmed (grep) it is never rendered via `innerHTML` anywhere, only ever read back programmatically. Not a sink.

**Requirements checklist**:
1. All affected call sites identified — 20 confirmed, documented above, with the `confirm()` scope correction explicitly called out rather than silently reinterpreted. ✅
2. Minimal escaping utility — reused the existing `escHtml()`, no new function added. ✅
3. No UI regression — same reasoning as S-1: `escHtml()` is a no-op for any name without `&<>"` in it, which is the overwhelming majority of real shop/product/customer names. ✅
4. Regression tests — see `XSSRegressionReport.md`. ✅

## Files changed

- `app/ShopERP_Pro_v8.html` — 20 lines edited (the sink-side `escHtml()` wrappers above). No other lines touched.
- `server/test/xss-regression.test.js` — new file, regression test (see `XSSRegressionReport.md`).
- `server/package.json` — added `test:security` script, added to the aggregate `test` script.
- `.github/workflows/ci.yml` — added a "Security tests — XSS regression (S-1/S-2)" CI step.

No server-side code (`server/local.js`, `server/sessions.js`) was touched by this task — S-1/S-2 are both purely client-side rendering fixes.
