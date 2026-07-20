# Wave 0 + Wave 1 — Security Report

Scoped to what this implementation changed. Findings from the original `SecurityReview.md` that this work didn't touch (F-5 through F-9: tenant isolation, CSRF, XSS audit status, privilege escalation, PIN storage) are unchanged and not re-litigated here.

## Findings resolved by this work

| Original finding | Resolution |
|---|---|
| F-1: `JWT_SECRET` optional, random-per-boot fallback | Now mandatory; server refuses to boot without it (verified: tested with `.env` removed, exit code 1, clear message; restored and confirmed normal boot). |
| F-2: No server-side, persisted audit log | Not addressed by Wave 0/1 — remains open, correctly deferred to Phase 3E per the approved sequencing. |
| F-3: No conflict detection on `PUT /api/data` | Resolved — optimistic concurrency, verified under both sequential and true concurrent (`Promise.all`) conditions. |
| F-10: Replay window (7-day token, no revocation) | Resolved — access tokens now expire in 15 minutes, and a session can be revoked immediately regardless of token expiry (verified: revoked session's still-cryptographically-valid token is rejected on the very next request). |

## New attack surface introduced, and how each is handled

1. **Refresh token theft.** Mitigated by rotation-on-use: a stolen-but-unused token becomes worthless the moment the legitimate owner refreshes. Reuse of an already-rotated token is rejected outside a 20-second grace window (added to fix a same-device multi-tab race — see `Wave01-EdgeCaseReport.md`). Verified directly that reuse *within* the grace window still only issues an access token, never a second refresh token, and reuse *outside* it is a hard `401`.
2. **Refresh token storage moved to `localStorage`.** This is the one deliberate storage-location expansion in this work — the access token stays in `sessionStorage` as before (tab-scoped, short-lived); the refresh token needed to survive tab close for the requested 30-day persistence, which `sessionStorage` cannot do. Tradeoff: a `localStorage`-resident refresh token has a larger XSS blast radius than the previous single `sessionStorage` token. Not independently mitigated beyond the existing XSS surface (F-7, still not exhaustively audited, unrelated to this wave) — worth weighing if that audit hasn't happened yet.
3. **New endpoints' authorization.** `GET /api/auth/sessions` and `POST /api/auth/sessions/:id/revoke` are owner-role-gated. The revoke endpoint additionally checks the target session's `tenant_id` matches the caller's own before acting — verified live that attempting to revoke another tenant's session returns `404` (not `403`, so a session ID from another shop can't even be confirmed to exist by the response code).
4. **Heartbeat and refresh endpoints are unauthenticated-reachable** (`heartbeat` requires a valid access token via `requireAuth`; `refresh` requires a valid refresh token but no access token, by design — that's the point of a refresh endpoint). Both are rate-limited: `refresh` at 30/5min, matching the sensitivity of an auth-adjacent endpoint without being so tight that a legitimate burst of tab-restores would trip it.
5. **`sendConflict()`'s `updatedByName` lookup** exposes which user (by display name/mobile) last saved — only to another already-authenticated user of the *same* tenant (the 409 response is only ever seen by a caller who already passed `requireAuth`+`requireActive` for that exact tenant). Not a cross-tenant leak.

## Rate limiting — observed working, not just configured

During this review's own testing, the `/api/auth/register` rate limiter (5 requests / 10 minutes / IP) was tripped for real by repeated test registrations, and correctly blocked further attempts with a `429` and a `Retry-After` header until the window elapsed. This is incidental but genuine confirmation the existing rate-limiting infrastructure functions correctly under this new code, not a designed test.

## What this review did NOT re-audit

- XSS surface (F-7 in the original `SecurityReview.md`) — status unchanged, still flagged as needing a dedicated pass, independent of this work.
- Anything in the ~200+ `innerHTML=` assignments across `app/ShopERP_Pro_v8.html` unrelated to auth/session/data-save flows.
- Load-bearing security of the underlying crypto primitives (`bcrypt`, `jsonwebtoken`, Node's `crypto.randomBytes`) — these are well-established libraries, not re-derived or re-verified here.

## Residual security posture, honestly stated

No critical or high-severity findings from this pass. The two bugs found (`Wave01-RegressionReport.md` §4 and §7) were functionality/availability bugs, not confidentiality or integrity breaches — neither exposed data across tenants or allowed unauthorized access; both would have manifested as legitimate users being incorrectly blocked or logged out, which is a real production-readiness concern but not a security compromise. Testing was thorough but ran against the live production database with careful cleanup rather than an isolated environment — see the Production Readiness Report for why that itself is flagged as a gap worth closing before further waves.
