# Authentication Review — Issue 3 (Prevent User Enumeration)

Status: **Fixed.** This exact issue was first surfaced as a Low-severity finding in the prior right-click-focused engagement (`docs/right-click-review/PenTestReview.md`, live-tested at the time) — this is where it gets actually resolved.

## What was wrong

`POST /api/auth/login` returned two distinguishable failure messages:
- *"Mobile number not registered. Please do First Time Setup."* — for a mobile number with no account.
- *"Incorrect PIN. Please try again."* — for a registered mobile with the wrong PIN.

An attacker submitting a list of candidate mobile numbers could determine exactly which ones are registered ShopERP customers, purely from which of the two messages came back — a classic user-enumeration side channel.

## Fix

Both cases now return the **identical** response: `401 {"error": "Invalid mobile number or PIN."}`. The real reason is still recorded — **server-side only**, via `logger.warn()`, distinguishing `"mobile not registered"` from `"incorrect PIN"` (the latter also logging `tenantId`/`userId` for real accounts, to support genuine operational diagnostics) — so an operator investigating a support ticket or a suspicious pattern of failed logins can still see exactly what happened; the *client* just never learns which case occurred.

## Scope decision — login only, not registration's duplicate-mobile check

`POST /api/auth/signup` still tells a user *"This mobile number is already registered. Please sign in."* when they try to register a mobile that already has an account. **This is deliberately left unchanged**, and the distinction matters:
- Issue 3's own wording is about **authentication** (a login attempt trying to determine whether an account exists) — the classic enumeration attack model is an anonymous attacker probing arbitrary numbers at the login endpoint.
- The registration duplicate-check is initiated by someone filling out a form claiming to be that shop's owner — telling them "you already have an account, sign in instead" is standard, expected UX (and revealing it here is a widely-accepted industry tradeoff — GitHub, Google, and most production systems do exactly this at signup while being strict about it at login).
- Silently making this message generic too would degrade a genuinely helpful "did you mean to sign in?" nudge for a benefit the issue didn't ask for and that doesn't fit the same attack model.

This scoping is stated explicitly here rather than left as an unstated assumption.

## Client-side consequence, handled

`pssLogin()` (the newer registration/login panel) previously inspected the login error message for the substring `"not registered"` to auto-open the registration panel and pre-fill the mobile number — a convenience that **depended on knowing which case had occurred**, i.e., depended on the exact thing this fix removes. Since the server can no longer tell it that, this branch is now permanently unreachable dead code if left in place — it was removed, not left to silently stop firing. Every failed login now just shows the generic message via `pssShowErr()`. (`webLogin()`, the older duplicate login screen, and `pssLicenseLogin()`, the "My Existing Shop" flow's final PIN step, never had this branching — they already just displayed `res.error` directly, so they needed no change and inherit the fix automatically.)

## What else was checked and found already correct

- `POST /api/admin/login` (Issue 2's new endpoint) already returns a single generic `"Invalid credentials"` for a wrong password, a missing password, and an internal error alike — no enumeration surface was introduced there.
- `POST /api/auth/resend-verification` already returns an identical generic response whether the mobile exists, is already verified, or is genuinely pending (built this way from the start in the original licensing-feature engagement — see `docs/architecture-review/RegistrationFlow.md`).
- `POST /api/auth/verify-license` (the "find my shop by key" lookup) intentionally returns `{found:false}` for an unregistered key — this is the endpoint's documented purpose (a customer must be able to check their own key), not an incidental account-existence leak, and it's separately rate-limited. Unrelated to Issue 3's account-enumeration concern (a license key isn't an account identifier — it's checked in the SAME code path used to walk a legitimate customer through a legitimate multi-step sign-in).

## Verification

New regression test: `server/test/auth-enumeration.test.js` (6 assertions) — confirms an unregistered mobile and a wrong PIN on a real account produce byte-identical HTTP status and error text, that neither response leaks the words "registered" or "incorrect PIN," and — critically — that a correct mobile+PIN combination still logs in successfully (the fix changed only the failure message, not the actual authentication check).
