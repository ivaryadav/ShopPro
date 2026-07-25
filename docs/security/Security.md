# Security Review — Identity & Tenant Core (Phase 2)

Mission requirement: "Never weaken existing security." Reviewed item by item against `docs/independent-audit/IndependentSecurityReview.md` (the standing, from-scratch security audit of `local.js`).

| Control | Status | Detail |
|---|---|---|
| bcrypt | **Preserved** | Cost factor 10, identical to every `local.js` call site (`regression.test.js` asserts this). |
| JWT | **Preserved** | HS256-pinned, same payload shape, same 15-minute TTL. |
| Trusted Devices | **Preserved, with one documented gap** | Auto-trust/reject logic ported exactly; the device-limit *value* falls back to a fixed 2 rather than a real per-plan value, because the source of that value (`tenant_licenses.device_limit`) is Licensing-domain, out of scope. This is `local.js`'s own existing fallback behavior for a missing license row, not a new default (`services/trustedDeviceService.js`'s header). |
| PIN verification | **Preserved** | `bcrypt.compareSync`, timing-safe by construction (bcrypt's own comparison is constant-time relative to the hash, not raw string length). |
| Tenant isolation | **Preserved, structurally hardened** | Every tenant-scoped repository query sources `tenant_id` from the JWT (`req.user.tenantId`), never client input — confirmed by reading every repository. `user_sessions` additionally gains real FK constraints `local.js` doesn't have (see `ERD.md` — a hardening, not a new restriction on any reachable state). |
| Authorization middleware | **Preserved, re-architected** | Table-driven (ADR-0006), verified to produce identical outcomes to `local.js`'s hardcoded checks for all 3 real, in-scope gates. |
| Timing-safe comparisons | **Preserved** | bcrypt handles this for PIN comparison; no new raw string-equality check on secret material was introduced anywhere in this phase's code. |
| Audit hooks | **Partial — a real, disclosed gap** | `local.js` has no persisted, queryable audit log for auth events either (only `console.log`/`logger.warn`, same as this phase's code) — so this is not a regression, but it's also not an improvement. A real structured audit trail for auth events is a legitimate future-phase candidate, not attempted here (would be new feature work). |
| Session expiration | **Preserved** | 15-min access token, 30-day idle expiry, 90-day hard-delete retention — all three constants verified identical to `sessions.js` by `regression.test.js`. |
| Lockout behavior | **Not applicable to hosted mode** | `local.js` has no login lockout/backoff beyond the rate limiter (which is preserved). The desktop app's own PIN lockout (`_clearLockState`) is a separate, out-of-scope system. |

## New, real finding: error response shape changed

`local.js` returns `{ error: "<string>" }` on failure. This phase's `errorHandler.js` (Phase 1 infrastructure, now genuinely exercised) returns `{ error: { code, message, details? } }`. **This is a real API-shape difference**, not preserved byte-for-byte — flagged honestly rather than glossed over, since "preserve behavior exactly" is the phase's own standard. It has zero impact today (nothing is cut over; no client consumes this new API yet), but whichever future phase does the actual cutover must either update every client call site that reads `res.error` as a string, or add a compatibility-shaping layer. Tracked in `docs/database/MigrationNotes.md` and the final phase report's Risks section.

## Residual risk carried forward, unchanged by this phase

Everything in `docs/independent-audit/ReleaseApproval.md`'s residual-risk list (CORS default-permissive fallback, `nodemailer` CVEs, cloud-backup bridge's shared-credential model, accessibility gaps) is orthogonal to Phase 2's scope and unaffected by it — restated here only to avoid the false impression that this security review superseded that one. It didn't; it's a distinct, narrower review of exactly what Phase 2 built.
