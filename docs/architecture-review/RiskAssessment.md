# ShopERP Pro — Risk Assessment & Implementation Plan

This is the output-requirements document: migration strategy, phased zero-risk plan, files affected, risk score per change, rollback plan. Everything here is a **proposal to review before any code is written** — nothing has been implemented yet, matching your Phase 2/3 gate.

---

## Risk register

| ID | Finding | Severity | Likelihood today | Addressed by |
|---|---|---|---|---|
| R-1 | `PUT /api/data` last-write-wins, no conflict detection | Medium (data loss) | Low today, High once multi-device is encouraged | New: optimistic concurrency (Wave 0) |
| R-2 | No server-side session record / no revocation | Medium (can't respond to lost/stolen device) | Low-Medium | Phase 3B |
| R-3 | No centralized/persisted audit log | Medium (no forensics across restarts or tenants) | N/A (already true) | Phase 3E |
| R-4 | `JWT_SECRET` optional, random-per-boot fallback | Low (availability, not security) | Certain, if unset | Wave 0 (config hardening) |
| R-5 | Rate-limit state in-memory only | Low at current scale | Low | Note only, no change recommended yet |
| R-6 | XSS surface not exhaustively audited | Unknown (not yet fully scoped) | Unknown | Recommend a dedicated pass, separate from Phase 3 |
| R-7 | New feature: WebSocket presence adds a new network-facing surface | New surface = new risk by definition | N/A | Auth-gate the WS handshake with the same JWT/session check as REST, from day one |
| R-8 | New feature: trusted-device fingerprinting can be spoofed (client-supplied UA/fingerprint) | Low-Medium (fingerprint is a UX signal, not a security boundary) | Medium | Treat trust as "skip extra friction," never as "skip PIN check" (per design in `ArchitectureReview.md §A`) |

---

## Why a phased plan, not one big change

Your own Rule #5 ("additive, not destructive") and the Phase 2 gate ("do not code until architecture review is complete") point the same direction: Phase 3 A–F is six subsystems, several of which depend on each other (Session Management is the foundation Trusted Devices and Presence both sit on; conflict detection needs to land before or with Resume-Work, or Resume-Work actively makes data loss more likely). Shipping all six at once is exactly the kind of change that's hardest to roll back safely if any one piece has a problem. The plan below sequences them so each wave is independently shippable, independently testable, and independently revertible.

## Zero-risk implementation plan

### Wave 0 — Foundation (no visible feature, pure hardening)
- Make `JWT_SECRET` required at boot (loud failure, matching existing `stripLicenseSecrets()` pattern).
- Add optimistic concurrency to `PUT /api/data`: client sends the `updatedAt` it last read; server rejects with `409` if it doesn't match current, client re-fetches and retries. **Backward compatible by construction** — if the client omits the check value (old cached page, or Electron build that hasn't been updated), the server falls back to today's unconditional-write behavior. No existing caller breaks.
- **Files touched**: `server/local.js` only. **Risk score: Low.** **Rollback**: revert the one file; no schema change, no data migration.

### Wave 1 — Session Management (Phase 3B)
- New table `user_sessions`. Server issues an access token (short-lived) + refresh token instead of one 7-day JWT; `requireAuth` additionally checks `user_sessions.status = 'active'`.
- **Backward compatibility**: existing 7-day JWTs already issued keep working until they naturally expire (no forced logout of current users on deploy) — `requireAuth` accepts either shape during a transition window, then the old shape is retired once its 7-day max lifetime has elapsed.
- **Files touched**: `server/local.js` (new table, new/changed auth endpoints), `app/*.html` (`_api` helper gains refresh-token handling — additive, existing `_api.get/post/put` signatures unchanged).
- **Risk score: Medium** (touches the auth path everyone depends on). **Rollback**: schema addition is additive (new table, doesn't alter `tenants`/`users`); code rollback removes the session check, JWTs continue working as they do today.

### Wave 2 — Trusted Devices (Phase 3A)
- New table `trusted_devices`. New endpoints: register device, list devices (owner-facing), revoke device (owner/admin-facing). Login flow gains an *optional* device-check step — untrusted device still works exactly as today (PIN + full re-verification), trusted device gets the shortcut.
- **UI note honoring your Rule #1/#2**: no new screen is required to *use* this — the existing PIN screen and the existing "My Existing Shop" license-key screen already cover the two states (trusted = PIN only, untrusted = PIN + key). A device-management list is new admin-console content, additive to the existing Web Users page, not a redesign of it.
- **Files touched**: `server/local.js`, `server/license.js` (unchanged), `app/*.html` (login flow branches, admin console additive panel).
- **Risk score: Medium.** **Rollback**: drop the device-check branch; login reverts to always-full-verification, which is today's behavior — zero data loss on rollback since the table is purely additive.

### Wave 3 — Realtime Presence (Phase 3C)
- New WebSocket listener alongside the existing Express server (same process, different upgrade path — doesn't touch existing REST routes). New tables `shop_presence`/`user_presence`, populated by 20s heartbeats from already-authenticated sessions (reuses Wave 1's session validation — this is why Session Management comes first).
- **Files touched**: `server/local.js` (or a new `server/presence.js` required by it, keeping the diff to `local.js` small), `app/*.html` (a small heartbeat client, additive — doesn't touch any existing page's markup or logic), admin console (new read-only panel on the Web Users page).
- **Risk score: Medium** (new always-on connection type; needs its own auth check per R-7). **Rollback**: the heartbeat client can be feature-flagged off client-side instantly; server-side, stopping the WS listener doesn't affect REST traffic at all.

### Wave 4 — Resume Work From Any Device (Phase 3D)
- Persist `last_page`, filters, draft sale/repair, selected customer, scroll position as a small additional JSON field alongside (not replacing) the existing `DB` blob — written on the same save path Wave 0 already made conflict-safe.
- Explicitly **depends on Wave 0 landing first** — without conflict detection, "resume your draft from another device" is the exact scenario most likely to silently overwrite a co-worker's in-progress sale.
- **Files touched**: `app/*.html` only (new fields in the settings/draft object, a "resume?" prompt on login — additive, no existing form/page changes).
- **Risk score: Low-Medium**, conditional on Wave 0. **Rollback**: the new fields are simply ignored by older clients; no schema break.

### Wave 5 — Expanded Audit Log (Phase 3E)
- New table `security_audit_log`, one `INSERT` added at each of the ~10 server code paths listed in `SecurityReview.md`. Purely additive logging — cannot change any existing response or behavior by construction.
- **Files touched**: `server/local.js`. **Risk score: Low.** **Rollback**: remove the inserts; no dependency from anything else on this table existing.

---

## Sequencing summary

```
Wave 0 (foundation) → Wave 1 (sessions) → Wave 2 (devices) → Wave 3 (presence)
                    ↘ Wave 4 (resume work, needs Wave 0)
Wave 5 (audit log) — independent, can land anytime after Wave 1 (wants session_id for context)
```

Recommend confirming Wave 0 + Wave 1 as the actual next coding task, rather than starting all six — that's the smallest slice that's independently valuable (fixes the two real risks found, R-1 and R-2/R-4) and de-risks everything after it. Happy to proceed on that basis, or reprioritize if a specific piece (e.g. Trusted Devices) is the actual business driver right now.
