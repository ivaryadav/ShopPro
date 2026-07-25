# API Audit — Every Endpoint, Independently Reviewed

All 43 routes registered in `server/local.js` were enumerated directly (`grep -n "^app\.\(get|post|put|delete\)"`) and each middleware chain read in full. This is not a sample — it is the complete route table.

## Finding API-1 (CRITICAL) — Legacy tenant termination does not fully lock out the tenant

**This is a live-reproduced, not theoretical, finding.** Full reproduction script and output below.

### Root cause

Two independent status systems exist for the same concept ("is this tenant allowed to use the product"):
1. **Legacy**: `tenants.status` (`'active'|'paused'|'terminated'`), enforced by the `requireActive` middleware (`local.js:425-437`).
2. **New**: `tenant_licenses.status` (`PENDING_APPROVAL|ACTIVE|READ_ONLY|SUSPENDED|ARCHIVED`), enforced by `requireLicenseRead`/`requireLicenseWrite` (`local.js:447-468`).

`POST /api/admin/tenant/status` — the endpoint behind the still-live, still-used "Pause Account" / "Terminate Account" admin UI actions (`app/ShopERP_Pro_v8.html:5992-6015`, calling `_admServerStatus()` → this exact endpoint) — **only updates `tenants.status`** (`local.js:1196`: `UPDATE tenants SET status = ?, suspend_reason = ? WHERE id = ?`). It never touches `tenant_licenses.status`.

Route-by-route, only two of the four tenant-data-adjacent routes actually call `requireActive`:

| Route | Middleware chain | Checks legacy `tenants.status`? |
|---|---|---|
| `GET /api/data` | `requireAuth, requireActive, requireLicenseRead` | **Yes** |
| `PUT /api/data` | `requireAuth, requireActive, requireLicenseWrite` | **Yes** |
| `GET /api/data/users` | `requireAuth, requireLicenseRead` | **No** |
| `POST /api/auth/add-staff` | `requireAuth, requireLicenseWrite` | **No** |

For a tenant that registered through the still-live legacy `/api/auth/register` flow — which, independently confirmed, **never creates a `tenant_licenses` row at all** (`local.js:757-763`) — `requireLicenseRead`/`requireLicenseWrite` fail open (by explicit design, `local.js:449,463`). Combined with the missing `requireActive` call on the two routes above, **an admin "terminating" such a tenant does not actually stop that tenant from adding new staff logins or listing its users.**

### Live reproduction (run against an isolated test server, not the production DB)

```
generate-key: 200 { key: 'ZY9Q-9Q29-MYD8-FWHG', plan: 'monthly', ... }
legacy register: 201 Shop registered
terminate: 200 { ok: true, shopName: 'Legacy Gap Shop', status: 'terminated', reason: 'Test termination' }

GET /api/data after termination:        403 "Account terminated"          <- correctly blocked
GET /api/data/users after termination:  200 {"users":[{...}]}             <- NOT blocked
POST /api/auth/add-staff after term.:   201 {"message":"Staff added", ...} <- NOT blocked, new login created
```

A shop that an operator has just terminated (the UI's own confirmation text reads *"Customer will be permanently blocked"*) can, immediately after, still create brand-new staff logins into the same account and enumerate its existing users — indefinitely, until the server happens to restart (which re-runs the license backfill... but the backfill only handles tenants **without** a `tenant_licenses` row; a tenant like this that never gets one stays fail-open forever unless an admin manually intervenes through the newer dashboard instead of the one they actually used).

### Why this was not caught before

The existing 408-assertion regression suite tests the write-block for `READ_ONLY`/`SUSPENDED` (`tenant_licenses.status`) exclusively via the *new* signup → approve → expire pipeline (`test/license-state-machine.test.js:77`, `addStaffBlocked`) — it never constructs a tenant through the *legacy* `/api/auth/register` + `/api/admin/tenant/status` path and then re-checks these two routes. Both paths are individually well-tested; their **interaction** was not, which is exactly the kind of gap a fresh, adversarial, code-level pass — rather than trusting an existing green test suite — is supposed to surface.

### Severity and recommendation

**Critical.** This is a genuine authorization bypass on a real, currently-used administrative control, reachable by the exact workflow the admin console exposes today, with no attacker sophistication required. Recommended fix (either is sufficient, both is better): (a) add `requireActive` to `GET /api/data/users` and `POST /api/auth/add-staff`, and/or (b) make `POST /api/admin/tenant/status` also write the equivalent `tenant_licenses.status` (`'terminated'→'ARCHIVED'`, `'paused'→'SUSPENDED'`, `'active'→'ACTIVE'`) so the two systems can no longer diverge. This does not require a schema change and is a small, well-contained patch — but it must ship before this release is trusted with paying customers who might ever be paused or terminated.

## Full endpoint inventory

### Public / unauthenticated

| Route | Rate limit | Input validation | Notes |
|---|---|---|---|
| `GET /health` | None | N/A | Read-only, no tenant data. Leaks `adminKeyIsDefault` — see `IndependentSecurityReview.md` §1. |
| `POST /api/auth/verify-license` | 20/5min | Format-checked | Legacy, decodes key server-side, never trusts client-supplied plan/expiry (`local.js:738`, "Decode the key ourselves — never trust plan/expiry from the client"). |
| `POST /api/auth/register` | 5/10min | Full (shop name, mobile length, PIN digits, key format) | Legacy but live; correctly rejects duplicate license keys and mobiles (409). No transaction wrapping — `DatabaseAudit.md`. |
| `POST /api/auth/signup` | 5/10min | Full, including email regex | Same no-transaction gap as above. Duplicate-mobile message confirms account existence — disclosed in `IndependentSecurityReview.md` §4. |
| `GET /api/auth/verify-email` | None | Token hash + expiry checked | Returns HTML, not JSON — appropriate for a clicked email link. No rate limit is defensible here (token is high-entropy, not guessable; rate-limiting an email link a real user is clicking adds no security value). |
| `POST /api/auth/resend-verification` | 3/10min | Basic | Tightest limit in the file — appropriate, this is the most abuse-prone (spam) endpoint. |
| `POST /api/auth/login` | 10/5min | Mobile/PIN presence | Generic failure message confirmed — `IndependentSecurityReview.md` §4. |
| `POST /api/auth/refresh` | 30/5min | Refresh token presence | Rotation + reuse-detection lives in `sessions.js`, independently verified via `wave1-sessions.test.js`. |
| `POST /api/admin/login` | 10/5min | Password presence | bcrypt/legacy-sha256-with-upgrade, generic failure message (`IndependentSecurityReview.md` §3). |

### Authenticated (tenant user, `requireAuth`)

| Route | Full chain | Tenant-scoped correctly? |
|---|---|---|
| `POST /api/auth/logout` | `requireAuth` | Yes — operates on the caller's own session only. |
| `POST /api/auth/heartbeat` | `requireAuth` | Yes. |
| `GET /api/auth/sessions` | `requireAuth, requireLicenseRead` | Yes — `sessions.listActiveSessions(db, req.user.tenantId)`, scoped. |
| `POST /api/auth/sessions/:sessionId/revoke` | `requireAuth` | **Yes, explicitly checked**: `local.js:1033` — `if (!row || row.tenant_id !== req.user.tenantId) return res.status(404)`. Correct ownership check preventing one tenant from revoking another tenant's session by guessing a session ID. |
| `POST /api/auth/add-staff` | `requireAuth, requireLicenseWrite` | Yes for tenant scoping — **but see Finding API-1** for the missing `requireActive`. |
| `POST /api/auth/renew-license` | `requireAuth, rateLimit(10/10min)` | Yes, tenant-scoped. Legacy but functional; deliberately left ungated by the new license middleware (by design, so it remains a working escape hatch — a reasonable choice, independently sound). |
| `GET /api/license/status` | `requireAuth` | Yes. Deliberately ungated by `requireActive`/license-status middleware since its entire purpose is to *report* status to a possibly-restricted tenant. |
| `GET /api/data` | `requireAuth, requireActive, requireLicenseWrite` | Yes, fully gated. |
| `PUT /api/data` | `requireAuth, requireActive, requireLicenseWrite` | Yes, fully gated, plus optimistic-concurrency CAS (`DatabaseAudit.md`). |
| `GET /api/data/users` | `requireAuth, requireLicenseRead` | Yes for tenant scoping — **see Finding API-1**. |

### Admin (`requireAdminKey`)

All 24 admin routes were checked for two things: (a) does every tenant-targeting admin route source `tenantId` from the URL path (correct, since admin operates cross-tenant by design) rather than trusting a body field that could be spoofed to target a different tenant than intended, and (b) is a rate limit present on every mutating (`POST`/`DELETE`) route.

- **(a) Confirmed correct** — every `/api/admin/tenant-licenses/:tenantId/*` and `/api/admin/registrations/:tenantId/*` route reads `Number(req.params.tenantId)` and uses it consistently for both the lookup and the mutation; none accept a separate, potentially-mismatched tenant identifier from the body.
- **(b) One real gap**: `POST /api/cloud/backup`, `GET /api/cloud/restore/:keyHash`, `DELETE /api/cloud/backup/:keyHash` (`local.js:1683-1713`) carry **no rate limit at all**, unlike every other mutating admin route. Given they are already gated by `requireAdminKey`, the practical exploitability requires already holding a valid admin session — but the inconsistency itself (24 of 27 admin mutation routes rate-limited, these 3 not) is worth closing for defense-in-depth.
- **Separate, self-disclosed design note found in the code itself** (`local.js:1684`): *"In production this endpoint is called from the app with the admin key embedded. For open deployment, swap requireAdminKey with a per-tenant token."* This cloud-backup bridge authorizes purely via the **shared** admin credential plus knowledge of a `keyHash` — there is no per-tenant ownership check on `GET /api/cloud/restore/:keyHash` or the `DELETE` equivalent (any caller holding the admin credential can read or destroy **any** tenant's cloud backup by guessing/obtaining its key hash, not just their own). This is an intentional, disclosed limitation of a legacy desktop-to-cloud backup bridge feature, not a newly introduced defect, and is not reachable by an ordinary tenant user (who never holds the admin credential) — but it is real, and should be listed as residual risk rather than silently accepted, exactly as the code comment itself already suggests fixing.
- `POST /api/admin/tenant/status`, `POST /api/admin/generate-key`, `POST /api/admin/validate-key`, and the full `tenant-licenses`/`registrations` family all correctly require `requireAdminKey` and carry sensible per-minute rate limits (30-60/min depending on how expensive/sensitive the action is).

## Output encoding / error handling

- Every error path returns a plain `{ error: '<message>' }` JSON object — no stack traces, no internal file paths, no SQL fragments were found leaked to any client response (`grep -n "e.stack|err.stack" server/local.js` → zero matches; every `catch` block logs the real error server-side via `console.error`/`logger.error` and returns a fixed, generic string to the caller).
- HTTP status codes were spot-checked across the full route table and are used correctly and idiomatically: `400` for validation failures, `401` for auth failures, `403` for authorization/license-gate failures, `404` for missing resources, `409` for conflicts (duplicate registration, optimistic-concurrency version mismatch), `429` for rate limits (with a proper `Retry-After` header, `local.js:520`), `500` only for genuinely unexpected server-side exceptions.

## Verdict for this phase

The API surface is broadly well-authenticated, well-validated, and well-scoped to tenant ownership — with one **Critical** exception (Finding API-1) that is real, live, reproducible, and must be fixed before this release can be trusted with paying customers who are ever paused or terminated. The cloud-backup bridge's shared-credential-only authorization and the missing rate limit on those three routes are real but lower-severity findings, appropriately scoped as residual risk rather than release blockers on their own.
