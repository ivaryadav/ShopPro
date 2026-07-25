# Code Audit — Exhaustive Pattern Sweep

Every pattern requested by the mission was searched across the actual tracked source (`server/*.js`, `server/scripts/*.js`, `app/ShopERP_Pro_v8.html`), not against documentation claims. Results below are the literal grep output plus manual classification of every hit — "no matches" is stated only where the search genuinely returned nothing.

## TODO / FIXME / XXX / HACK

```
grep -n "// *TODO|// *FIXME|// *HACK|/\* *TODO|/\* *FIXME" server/*.js app/ShopERP_Pro_v8.html
```
**Zero matches.** (An earlier broad, unanchored grep for the bare string `XXX` produced false positives inside base64-encoded image data embedded in the HTML — re-run anchored to comment syntax specifically, confirmed clean.)

## SAK / Super Admin Key / master key

```
grep -rn "_SAK_H|_checkSAK|_migrateLegacySAK|SuperAdminKey|SUPER_ADMIN_KEY" app/ server/
grep -rniE "master.?key" server/*.js app/ShopERP_Pro_v8.html
```
**Zero matches**, both patterns. The previously-flagged backdoor is genuinely gone from the tracked source. (The `isSuperAdmin()` / `_superAdmin` flag mechanism still exists and is unrelated — it's a persisted role flag set through the ordinary admin-approval flow, not a bypass; confirmed no code path sets it except the documented one.)

## Hardcoded password

```
grep -rniE "hardcoded.?password" server/*.js app/ShopERP_Pro_v8.html
```
**Zero matches** for the literal phrase. The actual hardcoded-credential finding in this codebase is the `ADMIN_KEY` default-hash fallback (`server/local.js:65`) and its client-side twin `_LOCAL_ADMIN_PWD_HASH` (`app/ShopERP_Pro_v8.html:5278`) — both are a fixed *hash*, not a plaintext password, and both are covered in full in `IndependentSecurityReview.md` §1/§18 rather than repeated here.

## console.log

`local.js` contains 23 `console.log` calls. Each was individually classified:

| Line(s) | Content | Classification |
|---|---|---|
| 539, 1095, 1197, 1272, 1294 | Operational audit lines (session cleanup counts, license renewal, admin pause/terminate, PIN reset, user toggle) | Benign — no secret material |
| 1868-1881 | Boot banner (ASCII box, listening URLs) | Benign |
| 1887-1890 | DB path confirmation | Benign |
| **1878** | `` console.log(`║  ${ADMIN_KEY.slice(0,16)}...` `` — prints the first 16 of 64 hex characters of the active admin-key hash at every boot | **Finding CA-1 (Low-Medium)**: partial secret material in stdout logs. See `IndependentSecurityReview.md` §22 for full analysis. |

No `console.log` call anywhere prints a full password, PIN, JWT, refresh token, or session token in plaintext.

## debugger

```
grep -n "^\s*debugger" server/*.js app/ShopERP_Pro_v8.html
```
**Zero matches.**

## SHA256 authentication (for real user/admin credentials)

Every `createHash('sha256')` call site in `local.js` was individually classified:

| Line | Purpose | Is it credential auth? |
|---|---|---|
| 682, 745, 1086 | License-key hashing (`licenseKey.toUpperCase()`) | No — a high-entropy, server-generated key, not a user secret |
| 818, 902 | Email verify-token hashing | No — a `crypto.randomBytes(32)` token, not a user secret |
| 869 | Generic token-hash lookup (verify-email/resend) | No — same as above |
| 1165 | Legacy admin-password comparison inside `POST /api/admin/login` | **Yes, but with an automatic bcrypt upgrade on the very next line (1171-1173) and it is the explicitly-designed migration path**, not new SHA-256 usage — see `PasswordMigration.md`/`IndependentSecurityReview.md` §3 |
| 1878 | Not a hash call — printing a slice of an existing hash | N/A |

**Verdict: no user PIN and no *new* admin password is ever hashed with SHA-256.** The only SHA-256-hashed credential comparison remaining is the intentional, temporary legacy-login path that self-upgrades on use, plus the `ADMIN_KEY` env var's own seed value (which was always SHA-256 by definition — it's documented as "set `ADMIN_KEY` = sha256 hash of your password" — that hasn't changed and isn't part of what Issue 2 was scoped to fix, since the *storage/verification* is what moved to bcrypt, not the env var's input format).

## Unsafe comparison (non-timing-safe secret comparison, loose `==`)

```
grep -n "ADMIN_KEY ==|password ==|pin ==|token ==" server/local.js
```
**Zero matches.** Every credential comparison found during this audit uses either `bcrypt.compareSync` (constant-time by construction) or `crypto.timingSafeEqual` after an explicit length check (`local.js:1166-1168`, and the `requireAdminKey` session-token loop at `local.js:493-503`). No `===`/`==` string comparison is used anywhere for a secret value.

## Additional patterns checked, not in the mission's literal list but relevant to "no hidden bypass"

- `Math.random()` — 5 client-side call sites (`app/ShopERP_Pro_v8.html:4289,4332,4356,5115,16581`). None are used as a security token sent to or verified by the server: two are DOM-element-ID generators, one is a fallback machine-ID suffix, one generates fake demo revenue numbers, and one (`getRegCode()`, line 5109-5120) generates a client-side "registration code" using `Math.random()` that is **never called anywhere else in the file** — confirmed via a whole-file grep for `getRegCode` returning only its own definition. **Finding CA-2 (informational, dead code)**: `getRegCode()` is unreachable, unused code. Its weak randomness would matter if it were ever wired up as a real credential; today it is inert.
- `eval(` — zero matches in the client despite CSP's `script-src` permitting `'unsafe-eval'`. The app's own code does not need `unsafe-eval`; it is likely present for a third-party dependency (Spline viewer or similar) or as a historical carry-over. Recommend re-testing whether `'unsafe-eval'` can be dropped from CSP now that no first-party code requires it — a smaller CSP attack surface for free if the third-party scripts don't need it either.
- `require('child_process')`, `exec(`, `spawn(` outside the test harness — checked in `server/local.js`, `sessions.js`, `mailer.js`, `license.js`: zero matches. No command-injection surface exists in the production server code (the test harness's own use of `spawn` in `testServer.js` is test-only infrastructure, not reachable in production).
- SQL construction — every database query in `local.js` uses `db.prepare(...).run/get/all(...)` parameterized statements; zero string-concatenated SQL was found (`grep -n "db.prepare(\`.*\${" ` and manual read of every multi-line template-literal `db.exec`/`db.prepare` call — all interpolations are either static schema DDL or `runMigration` labels, never request-derived values inside the SQL text itself).

## Verdict

No backdoor, no hardcoded plaintext credential, no unsafe comparison, no command-injection or SQL-injection surface, no debug statements. The one real, live authorization gap discovered during this audit (a legacy tenant-status action failing to lock out two specific endpoints) is a **logic/consistency defect between two parallel status systems**, not a hidden bypass placed intentionally — fully detailed with live reproduction in `APIAudit.md`, Finding API-1.
