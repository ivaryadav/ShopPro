# Wave 0 + Wave 1 — Edge Case Report

Every case below was actually run against the live server or the `sessions.js` module directly — none are theoretical.

## Found, fixed, and verified during this review

### EC-1: Tenant with no `tenant_data` row can never save (Severity: High — complete feature loss for affected accounts)
Real tenants #1–4 are in this state right now. Root cause, fix, and verification: `Wave01-RegressionReport.md` §4. Now covered by a permanent regression test.

### EC-2: Same-device, multi-tab refresh race causes a spurious logout (Severity: Medium-High — hits a very ordinary usage pattern)
Two tabs of the same browser share `localStorage` (where the refresh token lives). Both tabs' access tokens tend to expire around the same moment (issued moments apart at login) and the invisible 60-second heartbeat in every open tab guarantees both tabs attempt a refresh within a short window of each other roughly every 15 minutes. Root cause, fix (20s reuse grace window), and verification (both the race resolving cleanly and theft-detection surviving it): `Wave01-RegressionReport.md` §7 and `Wave01-SecurityReport.md`.

## Investigated and found to be handled correctly already

### EC-3: Revoking your own currently-active session
Tested: an owner revokes the session tied to the token they're using to make the request. The revoke call itself succeeds (the revocation write happens, then the response is sent for that already-in-flight request). The *next* request with that same token correctly gets `401`. No special-case handling needed or added — this is exactly the intended behavior (self-revoke is a valid way to force your own re-login, e.g. after suspecting your own device was compromised).

### EC-4: Cross-tenant session revoke attempt
Tested live: tenant A's owner attempts to revoke a session ID belonging to a different tenant. Returns `404`, not `403` or `200` — confirmed the endpoint doesn't leak whether the session ID exists at all to a caller outside its tenant.

### EC-5: Re-login after a session is revoked
Tested: after revoking a session, the same user (same mobile+PIN) can immediately log in again and receive a brand-new, independent session. Revocation is per-session, not a lockout of the account — confirmed this doesn't accidentally lock a user out of their own account.

### EC-6: Legacy (pre-Wave-1) token backward compatibility
A token in the old shape (no `sid` claim), signed with the real current `JWT_SECRET`, still authenticates. Verified directly rather than assumed from reading the code.

### EC-7: Registration race on the same license key
Not newly introduced by this work (pre-existing `UNIQUE` constraint on `license_key_hash`), but re-confirmed still functioning: attempting to register two tenants with the same key returns a clean `409` on the second attempt, not a crash or a silently-merged account. Discovered incidentally when a deterministic key-generation collision broke one of this review's own test runs (see EC-9).

### EC-8: Migration idempotency
Server restarted twice in immediate succession; both `ALTER TABLE ADD COLUMN` (Wave 0) and `CREATE TABLE IF NOT EXISTS` (Wave 1) migrations ran cleanly both times with no errors, confirming the try/catch-wrapped migration pattern is safe to re-run.

## Found during review, not a code bug — process learnings

### EC-9: License keys are deterministic per plan+day
`generateKey()` has no random/nonce component — the same plan requested twice on the same day produces the identical key. This is by design (documented in the crypto engine's own comments: "custId does NOT affect the key... guarantees keys always validate regardless of customer number"), not a bug, but it meant several of this review's own rapid-fire test registrations collided with each other and with a tenant left over from an earlier, pre-fix test run that this review's author forgot to clean up. Root-caused and worked around (varied plans, direct DB cleanup) rather than mistaken for a product defect — noted here so it doesn't cause confusion in future testing.

### EC-10: Rate limiting affects rapid manual/automated testing
`/api/auth/register`'s 5-per-10-minutes limit was tripped by this review's own repeated test registrations. Not a bug — correct behavior — but worth knowing for anyone else writing tests against the live register endpoint: space out registration-heavy test runs, or expect to wait out the window.

## Investigated, not applicable / out of scope for this wave

- **True multi-process/multi-instance concurrency** (two separate `node local.js` processes against the same SQLite file) — not applicable; this deployment model is explicitly single-instance (`better-sqlite3` is a single-process embedded database; see `ArchitectureReview.md §10` on scalability limits, unrelated to this wave).
- **Clock skew between client and server** for token expiry — not tested; `jsonwebtoken`'s expiry checking is server-side only (the server's own clock), so client clock skew doesn't affect correctness, only the client's own (non-authoritative) sense of "is my token about to expire."
- **What happens to an in-flight request when a session is deleted by cleanup mid-request** — theoretically possible (the 30-minute cleanup interval could fire between `requireAuth`'s session check and the handler completing), but the window is a single synchronous request's duration (milliseconds) against a 30-day idle threshold — not tested directly, assessed as negligible risk given the timescale mismatch.
