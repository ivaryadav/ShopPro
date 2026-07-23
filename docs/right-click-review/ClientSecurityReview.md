# Client Security Review — Phase 5

Status: **Findings present, none newly introduced or newly exploitable by this change.** This phase inspected the *actual served HTML* (fetched from a running server, not just the repo source) for every category requested, and found two pre-existing items worth surfacing honestly rather than silently passing over.

## Method

Booted a real instance of `server/local.js` against a disposable test database and fetched `GET /` exactly as a browser would, then searched the **served** output (post-`stripLicenseSecrets()`) for secrets, credentials, and hidden mechanisms — not just the repo source, since the server modifies the HTML before sending it.

## ✓ No server-side secrets present in the served page

Grepped the served HTML for `JWT_SECRET`, `SMTP_PASS`, `SMTP_USER`, `DB_PATH` — **zero matches**. These live only in `server/.env` (never templated into the client) and in server process memory. **PASS.**

## ✓ Offline-license master secret correctly stripped

`MASTER_SECRET` (`'SH0P3RP0-PR0-M4ST3R-K3Y-D33P4K-2025-X9Z'`) and the crypto-engine functions that use it are **not present** in the served page — confirmed by direct string search on the fetched HTML. `stripLicenseSecrets()` (`server/local.js`) removes these before ever sending the page, and fails closed (refuses to serve at all) if it can't find the exact block to strip. **PASS**, and this is the control that actually matters here — unrelated to and unaffected by right-click.

## ✓ No source maps

No `sourceMappingURL` comment in the served page — there's no build step to generate one in the first place (plain HTML/JS, no bundler). **N/A / PASS.**

## ⚠ Finding 1 (Medium, pre-existing, NOT introduced by this change): a hardcoded "Super Admin Key" hash ships in the client

`app/ShopERP_Pro_v8.html:3441` — `const _SAK_H = '<64-char SHA-256 hex>'` — the file's own comment describes this plainly: *"ACTIVATION KEYS — NEVER EXPOSE TO END USERS — DEVELOPER EYES ONLY... these are hardcoded... master activation codes."* `_checkSAK(key)` (`:3442-3449`) hashes a user-entered activation key with `crypto.subtle.digest('SHA-256', ...)` and compares it to `_SAK_H`. A match (`doActivation()`, `:4236-4243`) grants **full, unlimited, superadmin-role access** to the offline desktop app — bypassing the entire machine-locked license system — without ever contacting a server.

- **What this is**: a deliberate developer/support backdoor for the offline desktop product (a separate system from the web/hosted SaaS licensing this session otherwise covers — confirmed out of scope for every prior engagement in this repo).
- **What it is not**: a leak of the actual plaintext master key. SHA-256 is one-way; the key format is 16 characters from a 32-character alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), a keyspace of roughly 32¹⁶ ≈ 2⁸⁰ — not practically brute-forceable from the hash alone.
- **Is it newly exposed by enabling right-click?** No, and this is the important finding for *this specific review*: DevTools access via the browser's own menu (☰ → More Tools → Developer Tools) was **never** blocked by any code in this application, on any screen, before or after this change (confirmed in `RightClickAudit.md`) — anyone who wanted to read this constant via the Sources/Elements panel already could, with or without right-click enabled. Enabling right-click adds one more *convenience* path (right-click → View Page Source) on the 7 screens that used to block it, alongside an already-open path. It does not change whether the constant is reachable, only how many clicks it takes.
- **Recommendation (out of scope to implement here — would be a business-logic/architecture change)**: a client-embedded bypass secret is an inherent limitation of *any* fully-offline license validator, not something this specific change can fix. If tightening this is ever prioritized, the durable fix is moving the master-key check server-side (requiring at least one network round-trip to redeem it), not further client-side obfuscation — obfuscation doesn't change what a hash-comparison reveals once inspected, by design.

## ⚠ Finding 2 (Low, pre-existing, NOT introduced by this change): the web/hosted admin panel's credential hash uses a single unsalted SHA-256 round

`app/ShopERP_Pro_v8.html:5283` — `const ADMIN_PWD_HASH = '<64-char SHA-256 hex>'` (the same default value as `server/local.js`'s `ADMIN_KEY` fallback, by design — this is the credential compared against on every `/api/admin/*` call, see `TrustBoundaryReview.md`). `_adminHash()` computes `SHA-256(password)` with no salt and no iteration count.

- **Why this is Low, not higher**: `docs/deployment/EnvironmentSetup.md` and `SecurityDeploymentReview.md` already document that a real deployment must set a non-default `ADMIN_KEY`, and `GET /health` surfaces a warning if it's still the default. This finding is specifically about the *hashing scheme's* strength, not the default-value risk (already tracked separately in `docs/right-click-review/OWASP_ASVS_Review.md`'s V2 finding).
- **Real-world impact**: unlike user PINs (bcrypt, cost-10, salted — correctly resistant to offline cracking), a SHA-256 hash of a human-chosen admin password is crackable at GPU speed if the password is weak/common and this hash is ever obtained. It's viewable in the served client bundle today regardless of right-click state, same reasoning as Finding 1.
- **Recommendation (out of scope here)**: if this is ever revisited, bcrypt/scrypt/argon2 for the admin credential (matching the standard already used for user PINs) would remove this gap. Not touched in this change — it's a hashing-scheme/business-logic change, not a browser-restriction one.

## ✓ `LICENSE_REGISTRY` sample data — confirmed fictional, not a PII leak

`app/ShopERP_Pro_v8.html:3452-3457` — a hardcoded array of 4 "license" records (shop names, owner names, phone numbers, plans) used to populate the offline desktop's Super-Admin preview dashboard. Inspected each entry: license keys are transparently fabricated (`SH0P-3RP0-PR0X-2025`, `D3M0-K3Y0-0000-0001`, etc. — spelling out placeholder phrases), phone numbers follow the same sequential demo pattern (`98765432XX`) as the app's own `DEMO_DB.customers` seed data used for "Try Demo" mode. **This is fictional sample content, not real customer data** — no actual tenant/customer PII is present here. **PASS**, no action needed.

## ✓ No other hardcoded credentials

Beyond the two already-known constants above (both pre-existing, both already flagged in prior engagements' broad strokes — this phase adds the specific hashing-scheme/exposure-path detail), no other password, API key, private key, or connection string was found in the served page.

## ✓ localStorage / sessionStorage contents — reviewed, no leak beyond what's already documented

| Storage | Key | Contents | Risk |
|---|---|---|---|
| `sessionStorage` | `shoperpro_token` | JWT access token (15-min lifetime) | Tab-scoped by design; already documented in `SessionArchitecture.md` |
| `localStorage` | `shoperpro_refresh` | Opaque refresh token (30-day, rotates on use) | Deliberate 30-day-persistence tradeoff, documented and accepted in `SessionArchitecture.md` — the alternative (httpOnly cookie) would reintroduce CSRF |
| `localStorage` | `shoperpro_last_shop`, `shoperpro_last_user`, `shoperpro_portal_mode`, `shopErpTheme` | Non-sensitive UX convenience state (last shop name shown, theme preference) | None |
| `localStorage` | `_ag`, `_sa`, `_sproMigPending` | Internal app-state flags (admin-session flag, migration-pending flag) | None found to leak sensitive values — informational flags only |

None of this changes with right-click enabled — storage inspection has always been one DevTools-Application-tab click away, unaffected by context-menu availability.

## ✓ No hidden/undocumented admin routes discovered

Every `/api/admin/*` route was already enumerated in `docs/deployment/DeploymentAudit.md` (including the one confirmed-dead, harmless `GET /api/admin/tenants`) and `AdminOperations.md`. No additional, undocumented server route was found while searching the client for fetch/XHR call targets during this review.

## Verdict

Two genuine, pre-existing findings (Medium: hardcoded super-admin-key hash for the offline product; Low: weak hashing scheme for the shared admin credential) are documented here in full, per the instruction not to silently fix or ignore issues. **Neither is introduced, worsened, or newly exploitable because of this specific change** — both were already reachable via the browser's own Developer Tools menu, which no code in this application has ever blocked. Proceeding to Phase 6.
