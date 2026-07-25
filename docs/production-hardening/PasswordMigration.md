# Password Hash Migration — Issue 2

Status: **Implemented.** Web admin authentication now uses bcrypt (auto-migrated from the legacy single-round SHA-256), with a real login exchange replacing the old "send a static hash as the bearer credential forever" model.

## Why this required more than swapping a hash function

The previous scheme (`ADMIN_PWD_HASH` client-side, `ADMIN_KEY` server-side) worked by having the client compute `SHA-256(password)` once and then **send that exact value as the `X-Admin-Key` header on every subsequent admin API call** — the hash itself functioned as a long-lived bearer credential, not just a one-time login check.

bcrypt is **non-deterministic by design** (a fresh random salt every time) — `bcrypt(password)` produces a different string on every computation, so it cannot be used as a repeatable value a client sends on every request. A real fix therefore required introducing an actual login exchange: verify the password once, issue a short-lived session token, use the token (not a hash of the password) for subsequent calls. This is a bounded, necessary change to the *admin auth transport*, not a redesign of anything else in the "completed architecture" — every downstream `/api/admin/*` route's own logic, and the `requireAdminKey` middleware's function signature, are completely unchanged.

## What changed

### Server (`server/local.js`)

- **New table** `admin_credentials` — a single row (`id=1`) holding `password_hash` + `algo` (`'sha256'` or `'bcrypt'`). Seeded once, on first boot, from the existing `ADMIN_KEY` env var (or its hardcoded default) with `algo='sha256'` — this is the exact legacy value, so the existing operator's password keeps working unchanged.
- **New endpoint** `POST /api/admin/login { password }`:
  - If `algo === 'bcrypt'`: `bcrypt.compareSync(password, stored)`.
  - Else (`algo === 'sha256'`, legacy): timing-safe-compare `SHA-256(password)` against the stored value — and **on a successful match, automatically re-hash with bcrypt (cost 10) and persist it**, flipping `algo` to `'bcrypt'`. This is the "automatic migration on successful login" requirement: no forced reset, no new password, the *same* password the operator already uses just gets a stronger hash from that point on.
  - On success: issues a random 32-byte session token (`crypto.randomBytes(32)`), valid for 12 hours, tracked in an in-memory map.
  - On failure: generic `401 {error:'Invalid credentials'}` regardless of *why* it failed (see `AuthenticationReview.md`, Issue 3) — the specific reason is logged server-side only.
- **`requireAdminKey` middleware** — same signature, same 401-on-failure contract every existing route already depends on, but now validates the presented `X-Admin-Key` against the set of currently-active session tokens (timing-safe per candidate) instead of a single static secret. **New accounts always use bcrypt** trivially falls out of this: there's only ever one admin identity in this system, and once its `admin_credentials` row exists with `algo='bcrypt'` (either freshly seeded that way, or migrated from `sha256` on first login), every future check goes through the bcrypt path.

### Client (`app/ShopERP_Pro_v8.html`)

- `ADMIN_PWD_HASH` — previously a hardcoded constant, now a runtime variable that holds the **session token** returned by a successful login. Every existing admin `fetch()` call site (12 of them, across the older and newer admin-panel entry points) already sends this exact variable as `X-Admin-Key` — reusing the name meant **zero of those call sites needed to change**.
- `adminLogin()` (older `admin-login-screen` entry point) and `pssAdminLogin()` (newer `pss-` entry point) both now branch:
  - **Web/hosted mode** (`SHOPERPRO_API_URL` set): POST the plaintext password to `/api/admin/login`, store the returned token in `ADMIN_PWD_HASH`.
  - **Offline/local desktop mode** (no server to verify against — the same structural constraint the whole offline-license system already has): unchanged, still a client-only SHA-256 comparison, now against a separate constant `_LOCAL_ADMIN_PWD_HASH` (same default value as before, so offline installs are completely unaffected). This mode was explicitly out of scope — there is no server in this mode to bcrypt-verify against, and Issue 2 is scoped to "web admin authentication."

## Requirement-by-requirement

| Requirement | How it's satisfied |
|---|---|
| Existing users continue to log in | The exact existing password verifies via the legacy path on first post-upgrade login |
| No password reset required | Never prompted; the same password is simply re-hashed transparently |
| Automatic migration on successful login | `algo` flips `sha256` → `bcrypt` inside the same request that verifies the legacy password |
| New accounts always use bcrypt | Only one admin identity exists; once migrated (immediately, on first login), all subsequent checks are bcrypt-only |
| Timing-safe comparisons | Legacy-path SHA-256 comparison uses `crypto.timingSafeEqual` (unchanged from before); the new session-token lookup also compares each candidate with `crypto.timingSafeEqual`, not `===` |

## A real backward-compatibility issue this surfaced — and how it was fixed

The existing test harness (`server/test/testServer.js`) and every test file that calls an admin endpoint used the pre-migration anti-pattern themselves: generate a random value, set it as `ADMIN_KEY`, and send that *same raw value* directly as `X-Admin-Key` — no login step, because the old system didn't have one. Under the new model this can't work (there's no password whose bcrypt hash equals an arbitrary pre-existing string).

Fixed at the harness level, not by editing every test file: `startTestServer()` now generates a real random *password*, seeds `ADMIN_KEY` with its legacy `sha256(password)` (exactly matching a real pre-migration deployment), and — after boot — performs one real `POST /api/admin/login` call itself, resolving `adminKey` to the **returned session token** instead of the raw seed value. Every existing test file that referenced `srv.adminKey` as its `X-Admin-Key` bearer value continues to work with **zero changes**, and every single test run now incidentally exercises the sha256→bcrypt auto-migration path at least once. One test (`license-backfill-regression.test.js`) reboots the server multiple times against the same database file and needed one addition — an explicit, shared `adminPassword` option (new, optional, backward-compatible on `startTestServer()`) so a later boot uses the same password the first boot already seeded, rather than a fresh random one that would no longer match the persisted credential.

## Verification

New dedicated regression test: `server/test/admin-auth-migration.test.js` (14 assertions) — confirms the row auto-migrates to bcrypt, the original password still works post-migration, each login issues a distinct token, wrong/missing passwords get the identical generic rejection, a valid token authorizes real admin API calls, and — the actual vulnerability fix — that sending either the raw legacy hash *or* the raw bcrypt hash directly as a bearer credential (the old anti-pattern) no longer works at all. All 369 pre-existing assertions across the rest of the suite still pass unmodified.
