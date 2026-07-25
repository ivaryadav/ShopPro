# Backdoor Removal — Issue 1

Status: **Removed. No replacement mechanism needed — confirmed with the product owner before implementation.**

## Why it existed

`_SAK_H` (`app/ShopERP_Pro_v8.html`, formerly ~line 3441) was a hardcoded SHA-256 hash of a 16-character "Super Admin Key," compared against via `_checkSAK()`. Entering a key matching this hash — either at first-time activation (`doActivation()`) or later via the Settings → renew-license flow — granted, on that one offline-desktop installation:
- A permanent, never-expiring license (`licenseExpiry: '2099-12-31'`).
- Owner-equivalent access (`_superAdmin: true`, checked by `isSuperAdmin()` throughout the app).
- Access to a "Super Admin" preview page.

It was never documented anywhere (`README.txt`, `server/DEPLOY.md` — zero mentions), marked in-source as *"NEVER EXPOSE TO END USERS — DEVELOPER EYES ONLY."*

## Where it was used

Three call sites, all now removed:
1. `doActivation()` — the first-time activation screen accepted this key as an alternative to a real machine-locked license key.
2. The Settings page's "change/renew license key" flow — accepted the same key at any later point, not just at first activation.
3. `_migrateLegacySAK()` — a one-time boot-time migration that converted any *already-stored* plaintext SAK (from before the `_superAdmin` flag existed) into the flag.

## Whether it was still required

**No.** Investigated and confirmed before removing anything:
- **Its own "Super Admin" preview page only ever showed hardcoded demo data** (`LICENSE_REGISTRY`, a fictional array — confirmed in the prior `ClientSecurityReview.md`) — it never connected to a server or managed any real customer, so it provided no genuine cross-customer administrative capability, only a local demo view.
- **The app already has a real recovery mechanism that does everything a legitimate "I need to get a customer unblocked" case requires**: the admin console's existing "Generate Key" flow (`admDoGenerate`/`generateKey()`) can issue a fresh, machine-ID-locked key on any plan — including `lifetime` — to a *specific* customer, with a real basis for an audit trail. The SAK was not a distinct capability; it was a strictly weaker, universal, un-auditable shortcut around a capability that already existed properly.
- This was surfaced to the product owner directly (given the operational stakes of removing something that *might* have been relied on for informal support) and confirmed: **remove entirely, no replacement.**

## What was removed

- `_SAK_H` (the hash constant) and `_checkSAK()` (the comparison function) — deleted entirely.
- The bypass branch inside `doActivation()` — deleted.
- The bypass branch inside the Settings renew-license flow — deleted.
- `_migrateLegacySAK()` and its call in `continueBootApp()` — deleted (its sole purpose was migrating *toward* the now-removed flag-granting mechanism; nothing depends on it going forward).

## What was deliberately kept (backward compatibility)

- **`isSuperAdmin()` and the `_superAdmin` flag itself are completely unchanged.** Any installation that already has `DB.settings._superAdmin === true` stored locally (from having used the SAK at some point before this release) continues to work exactly as before — this flag is read from that installation's own saved local database, not re-derived from the now-deleted hash check. No existing user is locked out; no data migration or reset is required. This satisfies the mission's "maintain complete backward compatibility" requirement precisely: the *state* persists, only the *path to newly acquire that state via a hardcoded universal key* is closed.
- `LICENSE_REGISTRY` (the demo data array) and the Super Admin preview page it feeds are unchanged — they're harmless, already-reviewed demo content unrelated to the actual bypass mechanism.
- The offline desktop's machine-locked license system (`server/license.js`, `validateKey()`/`generateKey()` in the client) is completely untouched — out of scope, as it has been throughout every engagement in this repo.

## Verification

- `grep` confirms zero remaining references to `_SAK_H`, `_checkSAK`, or `_migrateLegacySAK` anywhere in the codebase.
- `isSuperAdmin`/`_superAdmin` references: 16 remaining (unchanged), confirming the backward-compatible state mechanism is intact.
- Lint passes (`npm run lint`) — no syntax errors introduced by the removal.
- No server-side code was touched by this issue — it's entirely a client-side (offline desktop) removal.
