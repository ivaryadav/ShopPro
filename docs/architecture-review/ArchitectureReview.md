# ShopERP Pro — Architecture Review

Companion to `DependencyMap.md` (what connects to what) and `SecurityReview.md` (what's exploitable). This file is the maturity assessment per subsystem, plus forward-looking design proposals for the three new subsystems requested in Phase 3 (Trusted Devices, Session Management, Realtime Presence). No code is touched in this document.

---

## 1. Authentication Architecture

Two independent auth systems exist today, which is expected given two deployment modes, but worth stating plainly since it affects everything downstream:

- **Desktop**: PIN-only, checked against a local hash, zero network calls. There is no concept of "sign in as this user from this device" beyond having the DB file locally.
- **Web/Hosted**: mobile + PIN against `bcrypt`, JWT issued. This is the one Phase 3 A/B/C actually extend.

**Maturity: adequate for a single-tenant-per-machine desktop app; minimal for the hosted multi-device case.** The hosted path has login, but nothing between "logged in" and "logged out" — no device concept, no session list, no way for an owner or Ravi to see or revoke a specific login. That gap is exactly what Phase 3A/B fill.

## 2. Session Architecture

Current state: **one JWT, one shared secret, one 7-day expiry, no server-side session record at all.** The server is fully stateless w.r.t. sessions — `requireAuth` only checks the signature and expiry, nothing else. Practical consequences:

- There is no way to log a device out remotely. A stolen or lost device stays valid for up to 7 days with no recourse except rotating `JWT_SECRET` (which logs out *everyone*, not just the one device).
- There is no session list to show an owner ("where am I logged in?").
- **`JWT_SECRET` is optional in `.env` and falls back to a fresh random value generated at process start if unset** (`server/local.js:34`). Today, unless an operator explicitly sets it, every server restart silently invalidates every outstanding token — everyone gets logged out. This isn't a vulnerability (a random-per-boot secret is safer than a hardcoded default), but it's an availability characteristic worth fixing *before* building a session table on top of it, since a session table's whole point is durability across restarts.

This is precisely why Phase 3B (session table + revocation) is a reasonable next step rather than scope creep — the current design has nothing to revoke.

## 3. Security Architecture

Full findings in `SecurityReview.md`. Headline: tenant isolation and the license-secret exposure (fixed earlier this engagement) were the two things that would have been genuinely dangerous; both are now sound. What remains are hardening items appropriate for the "thousands of shops" framing but not urgent for the current scale — rate-limit persistence, session revocation, and centralizing the audit trail server-side (today it's 100% client-held, inside the same JSON blob as business data, with no cross-tenant visibility for Ravi at all).

## 4. Multi-Tenant Isolation

**Sound.** Every server-side data query is scoped by `req.user.tenantId` sourced from the verified JWT claim — confirmed by exhaustively grepping every use of `tenantId` in `server/local.js`; there is no code path where a client can supply a tenant ID. The one soft spot is the *admin console's* local bookkeeping (`ADMIN_DB`), which isn't tenant data at all but is worth naming here since Phase 3C (presence) will want to show "which shop" for every heartbeat — that mapping needs to go through the server's `tenants` table, not `ADMIN_DB`, to stay accurate across devices/browsers.

## 5. Licensing Architecture

Already substantially hardened this engagement: server-side key generation/decoding, secret never shipped to browsers, continuous expiry enforcement via `requireActive`, working renewal endpoint. See `docs/architecture-review/` is new — the licensing work itself predates this specific review and is described in the git history (`0ba59b2`) and the earlier-published architecture reference artifact. Nothing further recommended here beyond what Phase 3E already covers (expanding the audit log to include license events, which the client already partially does via `_auditLog('license-change', ...)`, just not server-side).

## 6. Cloud Backup Architecture

`POST /api/cloud/backup` / `GET /api/cloud/restore/:keyHash` exist, keyed by SHA-256 of the license key, gated by `requireAdminKey`. This is a manually-triggered, admin-mediated backup path — not automatic, not per-device, not versioned (one blob per key, overwritten each time, same last-write-wins characteristic as `tenant_data`). Adequate as a disaster-recovery mechanism for "the shop's PC died, get me back running," inadequate as a multi-device sync mechanism — it isn't trying to be one today.

## 7. Admin Architecture

Documented in full in the earlier architecture reference (Admin Panel Relationship Map). Restated because it's directly relevant to Phase 3C: **the admin console reads two unrelated stores**, and only "Web Users" plus the pause/terminate/restore actions are server-backed. Realtime presence (3C) must be built entirely against the server's tables (`tenants`, `users`, and the new session/presence tables) — it cannot be layered onto `ADMIN_DB`, or it will show Ravi's own local bookkeeping instead of live shop activity, which would be a correctness regression disguised as a feature.

## 8. Multi-Device Readiness

**This is the one place I'd push back on scope before coding, not after.** The data layer is a single JSON blob per tenant with unconditional last-write-wins on every save (`DependencyMap.md §3.2-3.3`). Phase 3D ("resume work from any device") and the general spirit of Phase 3A (trusted devices, implying multi-device use is now expected) both assume a shop owner might have two devices active. Today, if Device A and Device B both have the app open and both save, the second save silently discards the first device's changes — including a completed sale, a saved job card, a stock adjustment. This isn't a new risk Phase 3 introduces; it's a **pre-existing risk that Phase 3 will make far more likely to actually happen**, because right now multi-device use is rare (most shops run one PC), and trusted-device support is explicitly designed to encourage exactly the usage pattern that triggers it.

Recommendation, detailed further in `RiskAssessment.md`: add optimistic concurrency to `PUT /api/data` (compare-and-swap on `updated_at`, reject with 409 + let the client re-fetch and re-apply) *before or alongside* Phase 3D, not after. This is additive (old clients that don't send the check value keep working exactly as today — see Migration Strategy) and directly derisks the feature you're asking for.

## 9. Realtime Readiness

None today — no WebSocket, no SSE, no polling loop for presence. `server/local.js` is a plain Express app on `better-sqlite3` (synchronous, single-process). Adding a WebSocket layer for Phase 3C is a clean addition (a second `ws` server sharing the same HTTP server instance, or a separate port) with no conflict against the existing REST surface. Design proposal below.

## 10. Future Scalability

`better-sqlite3` is synchronous and single-writer — fine for the realistic scale of this product (one shop-owner's own server, or a small number of shops on a modest VPS), and the license/session/presence tables proposed below fit that model without issue. If the ambition genuinely is "thousands of shops" on one shared server, `better-sqlite3` becomes the bottleneck well before any of Phase 3's features do — that's a separate, much larger conversation (Postgres migration, connection pooling, horizontal scaling) and explicitly out of scope for an additive, backward-compatible change set. Flagging it once here so it's a conscious deferral, not an oversight.

---

## Forward-Looking Design Proposals (Phase 3, pre-implementation)

### A. Trusted Device — proposed design

```
trusted_devices(
  id INTEGER PRIMARY KEY,
  tenant_id, user_id,
  device_uuid TEXT UNIQUE,       -- generated client-side, stored in localStorage (not sessionStorage — must survive tab close)
  browser, os, ip_first_seen,
  first_seen, last_seen, trusted_at,
  is_active INTEGER DEFAULT 1,
  expires_at TEXT NULL           -- optional trust expiry
)
```
Flow (matches your spec exactly): first login from an unrecognized `device_uuid` requires full PIN + license-key re-verification; on success, the device row is written and `device_uuid` is echoed back for the client to persist. Subsequent logins send `device_uuid` alongside mobile+PIN; if it matches an active, non-expired row, PIN alone suffices — server still validates PIN, "trusted" only skips the *extra* license re-check, it never skips authentication itself. Suspicious-login detection = new device_uuid + new IP range + short time-since-last-login-elsewhere, flagged (not blocked) into the audit log for the owner to review, per your "additive, not destructive" rule.

### B. Session Management — proposed design

```
user_sessions(
  id INTEGER PRIMARY KEY,
  session_id TEXT UNIQUE,        -- separate from the JWT's own jti, so revocation doesn't require reissuing all tokens
  device_id, tenant_id, user_id,
  login_time, last_activity, current_page,
  status TEXT                    -- active | revoked | expired
)
```
JWT gains a short-lived access token (e.g. 15 min) + a longer-lived refresh token, with `requireAuth` checking the access token's signature *and* that its `session_id` is still `active` in `user_sessions` (one indexed lookup, negligible cost on `better-sqlite3`). Revocation becomes a single `UPDATE user_sessions SET status='revoked'` — no secret rotation, no mass logout. `JWT_SECRET` should also move from optional-with-random-fallback to required-with-a-loud-startup-error, so this table's durability guarantee actually holds.

### C. Realtime Presence — proposed design

`shop_presence` / `user_presence`, updated by a lightweight WebSocket heartbeat (every 20s, matching your spec) carrying `{session_id, current_page}`; IP/browser/login_time/license status are looked up server-side from `user_sessions`/`tenants` at connection time rather than trusted from the client. The admin console's "Web Users" page (the one screen already confirmed server-backed — see `ArchitectureReview.md §7`) is the natural place to surface this, as an additive read-only panel — no existing admin screen's layout changes.

---

*No code changes accompany this document. Per your Phase 2 instruction, this is understanding and design only.*
