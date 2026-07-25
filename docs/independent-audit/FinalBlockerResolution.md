# Final Blocker Resolution — Tenant Termination Consistency

Resolves the sole release-blocking finding from the Independent Release Approval Board's review (`ReleaseApproval.md`, Finding API-1 / "Blocker 1"), plus the four named low-risk High/Medium items from that same review that the board explicitly flagged as fixable without a redesign. This is a targeted fix, not a new audit — no other area of the system was touched.

## Root cause

Two independent, unsynchronized status systems existed for the same concept — "is this tenant allowed to use the product":

1. **Legacy**: `tenants.status` (`'active'|'paused'|'terminated'`), checked by `requireActive()`.
2. **New**: `tenant_licenses.status` (`PENDING_APPROVAL|ACTIVE|READ_ONLY|SUSPENDED|ARCHIVED`), checked by `requireLicenseRead()`/`requireLicenseWrite()`, which explicitly **fail open** when no `tenant_licenses` row exists for a tenant.

Two things compounded to produce the vulnerability:

- `POST /api/admin/tenant/status` — the endpoint behind the live "Pause/Terminate Account" admin UI action — updated only `tenants.status`, never `tenant_licenses.status`. The two columns could silently diverge the moment an operator used this action.
- `POST /api/auth/register` (the legacy signup endpoint) never created a `tenant_licenses` row at all, so every tenant who registered through it relied entirely on the fail-open branch — meaning `requireLicenseRead`/`requireLicenseWrite` never actually gated them on anything.
- Two of the four tenant-data-adjacent routes (`GET /api/data/users`, `POST /api/auth/add-staff`) were gated **only** by the license middleware, not `requireActive()` — so for a tenant in the state described above, terminating them via the legacy action did nothing to those two routes at all.

## Decision: which system is authoritative

**`tenant_licenses.status` is now the single authoritative source of truth** that every protected endpoint gates on, directly or via `requireActive()` as a second, redundant layer. This was chosen over retiring the legacy system outright because:
- `tenants.status` still has real, independent readers that must keep working unmodified (`requireActive()`'s license-expiry check for legacy key-based tenants, `GET /api/admin/tenants`, `GET /api/admin/web-users`) — ripping it out would be a redesign, which was explicitly out of scope.
- `tenant_licenses` is the richer, 5-state model the entire admin dashboard and subscription lifecycle (trial/renewal/read-only/suspension/archival) is already built around, and is the system every *new* code path already treats as authoritative.

Rather than choosing one system and deleting the other, the fix makes them **structurally unable to drift apart again**: every write to the legacy column now also writes the authoritative one, every tenant gets a `tenant_licenses` row at the moment it's created (never relying on a future restart's backfill), and every protected endpoint uses the identical, complete middleware chain.

## Files modified

### `server/local.js`

1. **`POST /api/admin/tenant/status`** (the legacy pause/terminate/restore action) — now calls a new helper, `syncLegacyStatusToLicense()`, immediately after writing `tenants.status`. The helper maps `'paused'→'SUSPENDED'`, `'terminated'→'ARCHIVED'`, `'active'→'ACTIVE'`, mirrors the exact field-setting conventions the newer dashboard's own suspend/reactivate/reject actions already use (`suspended_since` stamped on suspend, cleared on reactivate, sessions killed via the existing `sessions.revokeAllTenantSessions()` on suspend/terminate), and records a `STATUS_CHANGED` `license_history` row so the sync is itself auditable. A missing `tenant_licenses` row is handled by returning early rather than throwing — a defensive fallback for an edge case the rest of this fix makes structurally impossible going forward, not a silent failure mode being relied upon.

2. **`POST /api/auth/register`** (legacy key-based signup) — now creates a `tenant_licenses` row (status `ACTIVE`, `plan_code` `BASIC`, `device_limit` 5, `billing_cycle`/`expires_at` derived from the actual decoded license key) as part of the same request, instead of leaving the tenant to rely on the next server restart's boot-time backfill sweep. This closes the fail-open window at its root — no tenant created through this endpoint is ever without an authoritative license row, even for a moment.

3. **`GET /api/data/users`** and **`POST /api/auth/add-staff`** — both now include `requireActive` in their middleware chain, matching `GET /api/data` and `PUT /api/data`. All four tenant-data-adjacent endpoints now use the identical `requireAuth, requireActive, requireLicenseRead|Write` chain — the direct fix for the endpoints where the exploit was reproduced.

4. **`GET /api/auth/sessions`** — also given the same `requireActive` addition, for full consistency (listing one's own sessions is comparable in sensitivity to listing users).

5. **Transactions** (Blocker 3, "Missing DB transaction wrapping"): the multi-statement insert sequences in both `POST /api/auth/register` and `POST /api/auth/signup` are now wrapped in `db.transaction(() => {...})()`. This was scoped specifically to these two handlers — the ones that create tenants, i.e. the ones whose partial failure could reproduce exactly the "tenant with no license row" condition this fix otherwise eliminates — rather than every multi-statement handler in the file, which would have been a broader change than the board's "fix only if low risk" instruction called for.

6. **`GET /health`** (Blocker 3, "Unauthenticated /health leakage"): no longer returns `startup.adminKeyIsDefault` to unauthenticated callers. This field let anyone, with zero credentials, learn for free whether a deployment's admin credential is still on the well-known public default hash — real reconnaissance value handed to an attacker by a public endpoint. The same information is still available to the operator privately, via the boot-time console log.

7. **Boot banner** (Blocker 3, part of "Hardcoded default admin hash fallback"): no longer prints the first 16 hex characters of the active admin-key hash to stdout. Replaced with a plain yes/no ("Custom key configured: yes" / "NO — using the default key, set ADMIN_KEY") — an operator gets the same actionable signal with no secret material, even truncated, sitting in logs that a log aggregator may retain more permissively than the secret store itself.

8. **Graceful shutdown** (Blocker 3): added `SIGTERM`/`SIGINT` handlers that stop accepting new connections, let in-flight requests finish, close the SQLite handle, and exit — with a 10-second forced-exit fallback if something never drains. Previously absent entirely; a restart or redeploy killed the process immediately with no chance to drain.

9. Updated the stale header comment above the licensing schema block, which had claimed the legacy `tenants.*` columns are "frozen — never written by any code below" — no longer true now that the legacy admin action writes both columns by design; the comment now explains the sync relationship instead.

### `server/test/legacy-tenant-status-consistency.test.js` (new, 28 assertions)

Reproduces the full attack chain end to end: legacy signup → confirms a `tenant_licenses` row exists immediately → normal use while active (login, read/write `/api/data`, list users, list sessions) → admin terminates via the legacy action → confirms the sync (`tenant_licenses.status` now `ARCHIVED`, recorded in `license_history`) → confirms the pre-termination session is now dead (401) → confirms a **brand-new post-termination login still succeeds** (by design — status is enforced per-endpoint, not at login, matching how `PENDING_APPROVAL`/`SUSPENDED`/`ARCHIVED` tenants already behaved before this fix) → confirms every previously-vulnerable endpoint now rejects that fresh token (`GET /api/data`, `PUT /api/data`, `GET /api/data/users`, `POST /api/auth/add-staff`, `GET /api/auth/sessions`, all `403`) → confirms no rogue staff account was actually created in the database → confirms `renew-license` remains intentionally reachable (the documented escape hatch is unaffected) → then exercises the pause/restore direction (`SUSPENDED` synced correctly with `suspended_since` stamped, restore syncs back to `ACTIVE` with `suspended_since` cleared, and the tenant can use the product normally again afterward).

**Verified to fail before the fix and pass after it**: this exact test file was run against a `git stash`-restored copy of the pre-fix `server/local.js`. It failed at the very first assertion that checks the root cause (no `tenant_licenses` row exists after legacy registration) and then crashed attempting the termination-sync check (there was no row to sync), which is itself a direct, concrete manifestation of the bug. After un-stashing the fix, all 28 assertions pass.

### `server/test/license-backfill-regression.test.js` (1 assertion updated, count unchanged at 26)

This existing test had an assertion that literally encoded the bug as an intended, tested property: *"tenant_licenses.status is untouched by the legacy admin action — the two status systems are independent for legacy tenants."* Restoring a legacy-paused tenant via `/api/admin/tenant/status` used to leave `tenant_licenses.status` stuck at `SUSPENDED` forever, and the test asserted that was correct. Updated to assert the corrected contract: restoring via the legacy action now also syncs `tenant_licenses.status` back to `ACTIVE`.

### `server/package.json`

Added `test:legacy-tenant-status-consistency` script and wired it into the aggregate `test` script (now 21 files, up from 20).

## Migration impact

**None required.** No schema change — every column and table this fix touches (`tenant_licenses`, `license_history`) already existed from the original licensing rollout. This is purely an application-logic change: two endpoints now perform additional writes they didn't before, and two routes gained an additional middleware check. Existing databases need no migration, backfill, or manual intervention — the very next call to `/api/admin/tenant/status` or `/api/auth/register` after this deploy will simply start doing the right thing.

## Backward compatibility

- Every existing reader of `tenants.status` (`requireActive()`, `GET /api/admin/tenants`, `GET /api/admin/web-users`, the legacy `/api/auth/verify-license`) is completely unchanged — that column is still written first, in the same format, by the same endpoint.
- `POST /api/admin/tenant/status`'s request/response contract is unchanged — same body shape, same response shape. The only externally-observable difference is that a tenant's `tenant_licenses.status` (visible via the admin dashboard and `GET /api/license/status`) now correctly reflects a pause/terminate/restore performed through this action, where before it silently didn't.
- `POST /api/auth/register`'s request/response contract is unchanged — same inputs, same response fields. It simply also creates a license row now, invisibly to the caller.
- No previously-working request now fails that used to succeed legitimately — every new `403`/`401` introduced by this fix only fires for a tenant an admin has actually terminated or paused, which is exactly the intended effect.
- The one intentional, pre-existing behavioral asymmetry — `POST /api/auth/login` always succeeds regardless of tenant status, with enforcement happening per-endpoint afterward — is preserved unchanged. This matches how the newer system already treated `PENDING_APPROVAL`/`SUSPENDED`/`ARCHIVED` tenants even before this fix, so changing it here would have been a scope-expanding behavioral change, not a fix to the reported bug.
- `POST /api/auth/renew-license` remains deliberately ungated by any of this — it is the documented escape hatch that must stay reachable even for a blocked tenant.

## Regression coverage

- **436 total assertions across 21 test files, 0 failures** — re-run three times over: the working tree, a fully isolated fresh copy with clean `node_modules` (rsync-based, since these changes are not yet committed), and the existing suite of 408 pre-existing assertions confirmed to still pass unmodified alongside the 28 new ones.
- `npm run lint` passes — every server file and every inline `<script>` block in `app/ShopERP_Pro_v8.html` still parses.
- The new test is the first in this repository to construct a tenant through the legacy path and then exercise it against the newer license-gate middleware in combination — closing the exact blind spot the Independent Release Approval Board identified as the reason 408 pre-existing, genuinely-passing assertions still missed this bug.

## What was explicitly left unfixed (per the board's own "only if low risk" instruction)

- **Accessibility gaps** (Finding UI-1) — zero ARIA usage, minimal `alt` text coverage across a 2.4 MB single-file application. Retrofitting this is inherently a broad change across many UI components, not a mechanical patch — attempting a partial fix here would give false confidence without genuinely resolving the gap. Left for a dedicated follow-up, as the board itself judged it non-blocking for this release.
- **CORS default-permissive fallback**, **cloud-backup bridge's shared-credential-only authorization**, **nodemailer CVEs**, **no automated backup schedule**, and the remaining Low-severity items from `ReleaseApproval.md` — none of these were named as part of Blocker 1, 2, or 3's explicit scope, and none block this release per the board's own verdict. Unchanged by this fix, still tracked as residual risk in `ReleaseApproval.md`.
