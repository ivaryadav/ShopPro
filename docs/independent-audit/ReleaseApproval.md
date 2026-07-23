# Release Approval — Independent Board Verdict on ShopERP Pro v1.0.0

> **Update (post-remediation): all items below marked "RESOLVED" have been fixed and independently re-verified.** See `FinalBlockerResolution.md` for the fix details, root cause, migration impact, backward compatibility, and regression coverage. The original findings are left intact below, unedited, as the historical record of what this board actually found — only the status markers and the Final Decision section reflect the post-fix state.

## Mandate

This board was asked to try to reject this release — to think like a penetration tester, an external auditor, and a CTO who has to answer for a customer-data breach, not like the team that built the product. Every finding below traces to a specific file, line, command, or live reproduction performed during this review (`RepositoryReview.md`, `IndependentSecurityReview.md`, `CodeAudit.md`, `DatabaseAudit.md`, `APIAudit.md`, `UIAudit.md`, `DevOpsAudit.md`, `VerificationAudit.md`). Nothing here was accepted on the strength of a prior report's own conclusion.

## What we tried, specifically, to break

- Attempted to find a live authorization bypass by constructing tenants through every registration path and cross-testing them against every gate — **found one** (API-1, below), reproduced it live against a running server, and confirmed no existing test catches it.
- Attempted to find a hardcoded credential or bypass beyond the one already publicly known to have been removed — **found a related one** (the `ADMIN_KEY` default-hash fallback), not identical to the removed backdoor but in the same family of risk.
- Attempted to find secrets in git history, not just the current diff — none found.
- Attempted to independently reproduce the test suite's pass count from a clone this board created itself, not the developer's clone — confirmed genuine.
- Attempted to find accessibility, transaction-safety, and DevOps-hygiene gaps that two prior, dedicated review engagements did not surface — found several (below).

## Critical issues

**Status: RESOLVED.** `tenant_licenses.status` is now the single authoritative source every protected endpoint gates on; the legacy admin action keeps it in sync on every call; every tenant gets a license row at creation time (no more fail-open window); and all four tenant-data-adjacent endpoints now share the identical middleware chain. Verified via a new 28-assertion regression test (`legacy-tenant-status-consistency.test.js`) that reproduces this exact attack chain, confirmed to fail against the pre-fix code and pass against the fix. Full detail: `FinalBlockerResolution.md`.

1. **(API-1) Legacy tenant termination/pause does not fully lock out the tenant.** `POST /api/admin/tenant/status` — the live, currently-used "Pause/Terminate Account" admin action — updates only `tenants.status`, never `tenant_licenses.status`. `GET /api/data/users` and `POST /api/auth/add-staff` check only the latter (and fail open when no `tenant_licenses` row exists, which is the case for every tenant registered through the still-live legacy `/api/auth/register` endpoint). **Live-reproduced**: a terminated tenant can still add new staff logins and list its users after being "permanently blocked" per the admin UI's own confirmation text. Full detail: `APIAudit.md`, Finding API-1.

This is the one finding this board considers disqualifying on its own. It is not a hypothetical — it was executed against a running instance and observed to succeed. It sits on a real administrative control (account termination), which is exactly the kind of control a paying-customer product must not have a hole in, especially since termination is the mechanism an operator would reach for in a non-payment or abuse scenario — precisely the moment the customer has the least remaining goodwill and the most motivation to keep using the account regardless.

## High issues

2. **Hardcoded default admin-credential fallback with an unauthenticated fingerprinting vector.** `ADMIN_KEY` silently defaults to a fixed, publicly-committed SHA-256 hash when unset (not fatal, unlike `JWT_SECRET`), and `GET /health` exposes `adminKeyIsDefault` to any unauthenticated caller — turning "is this deployment still on the factory default" into one free HTTP request. `IndependentSecurityReview.md` §1. **Status: PARTIALLY RESOLVED.** The unauthenticated-disclosure half is fixed — `/health` no longer returns this field, and the boot-time console log no longer prints even a truncated slice of the actual hash. The underlying fallback value itself (an operator who never sets `ADMIN_KEY` still gets a known default) is unchanged — flipping that to fail-fast like `JWT_SECRET` was judged a bigger behavioral change than "low risk" covers, since it could lock out existing deployments that have never set the variable, and was not part of what this fix round addressed. Remains residual risk, tracked below.
3. **No accessibility support anywhere in the application.** Zero ARIA attributes, 2 of 24 images have alt text, zero `tabindex` management, across a 2.4 MB production app — never examined by either of the two prior, dedicated UI-review engagements. `UIAudit.md`, Finding UI-1. **Status: NOT FIXED, by design.** Explicitly out of scope for this round — see `FinalBlockerResolution.md`'s closing section for why a partial fix here would be worse than none. Remains residual risk.

## Medium issues

4. **No database transaction wrapping** around any multi-statement write (signup, registration, and others each perform 3-5 sequential un-atomic inserts) — a crash mid-sequence can produce an orphaned tenant with no license row, compounding the same fail-open condition behind API-1 through an entirely separate path. `DatabaseAudit.md`. **Status: RESOLVED** for the two handlers that actually create tenants (`/api/auth/register`, `/api/auth/signup`) — both now wrapped in `db.transaction()`. Other multi-statement admin handlers elsewhere in the file were intentionally left as-is (out of this fix's scope; none of them create a tenant, so none can reproduce the specific fail-open condition this round was scoped to close).
5. **No graceful shutdown handling** (no `SIGTERM`/`SIGINT` handler) — mitigated by WAL-mode SQLite's crash tolerance, but a real availability gap on every restart/redeploy. `DevOpsAudit.md`, DO-3. **Status: RESOLVED.** `SIGTERM`/`SIGINT` handlers added, with a 10-second forced-exit fallback.
6. **No automated backup schedule** — a verify-only script exists; nothing actually triggers a backup on any interval. Previously disclosed by the developer, independently reconfirmed still true, and worth restating given this product's own "customer data must never be deleted" principle. `DevOpsAudit.md`. **Status: NOT FIXED** — an operational/infrastructure task outside this code-level fix round's scope. Remains residual risk; still recommended as a same-week operational follow-up.
7. **CORS defaults to allow-all-origins with `credentials: true`** when `ALLOWED_ORIGINS` is unset — low practical exploitability today only because the app uses Bearer tokens, never cookies; would become a real exploitation path the moment any future feature introduces a cookie. `IndependentSecurityReview.md` §9. **Status: NOT FIXED** — not named in Blocker 1/2/3's scope. Remains residual risk.
8. **Cloud-backup bridge (`/api/cloud/backup`, `/restore`, `DELETE`) has no per-tenant ownership check** — any caller holding the shared admin credential can read/destroy any tenant's backup by key hash, not just their own; self-disclosed in the code's own comment as a known limitation of this legacy bridge. No rate limiting on these three routes either, unlike every other admin mutation route. `APIAudit.md`. **Status: NOT FIXED** — not named in Blocker 1/2/3's scope. Remains residual risk.

## Low issues

9. HSTS not set and not documented as a required proxy-level addition (`DevOpsAudit.md`, DO-1).
10. No caching/ETag strategy on the main 2.4 MB static asset (`DevOpsAudit.md`, DO-2).
11. No IaC/container/process-supervisor config committed — deployment is entirely runbook-driven (`DevOpsAudit.md`, DO-4).
12. Partial admin-hash (16 of 64 hex chars) printed to stdout logs at every boot (`IndependentSecurityReview.md` §22).
13. Three divergent version identifiers (HTML meta, `package.json`, git tag) with no mapping between them (`RepositoryReview.md`).
14. `express-rate-limit` declared as a dependency but unused by the actual production entry point — cosmetic (`IndependentSecurityReview.md` §12).
15. Signup's duplicate-mobile message still confirms account existence — a disclosed, standard UX tradeoff, not a defect, but should not be described as "enumeration removed" without this caveat (`IndependentSecurityReview.md` §4).
16. `.git` repository size (361 MB) driven by a large, frequently-rewritten single HTML file — a growing clone-time/disk cost, not a functional defect (`RepositoryReview.md`).
17. Thin empty-state coverage across list views, not exhaustively verified (`UIAudit.md`, UI-2); no documented browser-compatibility test matrix (`UIAudit.md`, UI-3).

## What genuinely held up under adversarial scrutiny

To be equally honest in the other direction: bcrypt migration for both user PINs and admin passwords is real and complete, with no SHA-256 remaining for any actual credential; user-enumeration on login is genuinely fixed; the originally-reported Super Admin Key backdoor is genuinely, completely gone; JWT validation correctly pins its algorithm; tenant data isolation on every regular (non-admin) endpoint is sourced exclusively from the verified JWT and has no IDOR path; the optimistic-concurrency logic on the main data-save endpoint is well-built and correctly tested under simulated races; security headers, CSP, Permissions-Policy, and compression are all genuinely present and independently confirmed live; and the 408-assertion test suite is real, not inflated, and passes from a clean clone this board made itself. This is a fundamentally well-built, carefully-documented system with one serious hole in it, not a fundamentally unsound one.

## Scores (out of 10)

Scores below are updated post-remediation; the original (pre-fix) score is shown struck through for comparison where it changed.

| Dimension | Score | Rationale |
|---|---|---|
| Architecture | ~~7~~ **8** | The two-status-system coexistence that caused the Critical finding is now structurally synchronized rather than merely patched at the symptom — a real architectural improvement, not just a bug fix. Not a 9-10 because the two systems still both exist rather than being fully unified (an intentional, disclosed, non-redesign choice). |
| Security | ~~6~~ **8** | The live, reproducible authorization bypass that capped this score is fixed and independently re-verified. Held below 9-10 by the still-open, previously-identified, lower-severity items (CORS default, cloud-backup bridge, ADMIN_KEY fallback's underlying value) that were correctly judged non-blocking but remain real. |
| Performance | 7 | Unchanged by this fix round. |
| Maintainability | 6 | Unchanged by this fix round. |
| Scalability | 5 | Unchanged by this fix round. |
| Documentation | 8 | Unchanged; this document and `FinalBlockerResolution.md` continue that standard. |
| Testing | ~~7~~ **8** | The specific blind spot this board identified — no test exercising the legacy/new-system boundary — is now closed with a dedicated, verified-to-fail-before-fix-and-pass-after test. |
| DevOps | ~~6~~ **7** | Graceful shutdown added. Automated backups and HSTS guidance remain open, unchanged. |
| **Overall Production Readiness** | ~~6~~ **8 / 10** | The sole release-blocking defect is fixed, independently re-verified, and covered by permanent regression tests. Remaining residual risk is real, disclosed, and — per this board's own standing judgment — does not block this specific release. |

## Residual risk (accepted, disclosed, not blocking this release)

- The `nodemailer` HIGH-severity CVEs and CSP's `unsafe-inline`/`unsafe-eval` (both pre-existing, both already honestly disclosed in `ProductionReleaseApproval.md`, independently reconfirmed still present and still unresolved).
- No automated backup schedule — an operational task, not a code fix, but real exposure until done.
- `ADMIN_KEY`'s default-hash fallback value itself (the unauthenticated-disclosure vector via `/health` and the boot log is fixed; the fallback existing at all is not).
- CORS's default-allow-all-origins-with-credentials posture when `ALLOWED_ORIGINS` is unset.
- The cloud-backup bridge's shared-credential-only (no per-tenant) authorization.
- Zero accessibility support (Finding UI-1) — explicitly, deliberately not attempted in this fix round; see `FinalBlockerResolution.md` for why a partial fix would be worse than none.
- Single-process architecture ceiling on rate limiting and admin sessions.
- The offline-desktop product's inherent client-embedded-credential trust model (`_LOCAL_ADMIN_PWD_HASH`) — an accepted, out-of-scope property of a different product shape, not something this release changes.

## Technical debt

- Two parallel tenant-status systems now stay synchronized by this fix, but still both exist — a future engagement should consider whether full unification (one system, one column, no sync logic to maintain) is worth the larger migration effort. Not urgent: the sync is now structural (every write path updates both), not a manually-maintained convention that could silently rot again.
- Two parallel backend entry points (`local.js` vs. the largely-out-of-sync `index.js`) — flagged repeatedly across this project's history, never consolidated.
- `GET /api/admin/tenants` — dead, unreferenced route, still present.
- No log rotation; no APM/metrics beyond plain-text logs.

## Final decision

# GO

This board's original verdict was **GO WITH CONDITIONS**, refusing to approve deployment to paying customers while a live, reproducible authorization bypass on the account-termination control remained open. That defect (Finding API-1) is now **fixed and independently re-verified**: `tenant_licenses.status` is the single authoritative source of truth every protected endpoint gates on, the legacy admin action can no longer let it drift out of sync, every tenant gets a license row at the moment of creation rather than depending on a future restart, and all four tenant-data-adjacent endpoints share one consistent middleware chain. A dedicated 28-assertion regression test reproduces the exact attack chain this board found, was confirmed to fail against the pre-fix code, and now passes — see `FinalBlockerResolution.md` for the complete root-cause analysis, file-by-file changes, migration impact, backward-compatibility analysis, and regression coverage.

Of this board's original four GO conditions:
1. **Finding API-1 (Critical) — RESOLVED**, verified live and via regression test.
2. **Regression coverage for the legacy/new-system boundary — RESOLVED**, and further extended: an existing test that had literally encoded the bug as intended behavior was found and corrected during this fix, not just a new test added alongside an unexamined old one.
3. **`ADMIN_KEY` default-fallback exposure via `/health` — RESOLVED** for the unauthenticated-disclosure vector specifically (the field is removed from the public response; the operator-facing boot log no longer prints even a truncated hash slice). The underlying fallback value's existence is unchanged and remains disclosed residual risk, consistent with this board's original scoping of that condition.
4. **Automated backup schedule — NOT addressed**, correctly: this is an infrastructure/operational task, not a code-level fix, and was never something a source-code remediation pass could resolve. It remains a same-week operational action item, independent of this release's code readiness, exactly as this board originally framed it.

Verification was independently re-run, not assumed: full lint pass, all 436 assertions (408 pre-existing + 28 new) across 21 test files passing with zero failures, from a genuinely isolated fresh copy with clean `node_modules` — not merely the developer's own working tree.

Accessibility (Finding UI-1), the CORS default posture, the cloud-backup bridge's shared-credential authorization, and the underlying `ADMIN_KEY` fallback value remain open, disclosed, and — as this board judged from the outset — not release-blocking for a v1.0.0 aimed at this product's stated market. They belong in near-term follow-up work, tracked in `FinalBlockerResolution.md` and the Residual Risk section above, not as a gate on this tag.

**This board recommends: proceed to tag and release `v1.0.0`.**
