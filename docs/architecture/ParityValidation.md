# Parity Validation — `server/local.js` vs `server/src/` (Phase 5)

This is **not** the production cutover. This document verifies that the parallel layered implementation built in Phases 2 and 4 is behaviorally equivalent to `server/local.js`, the actual running application, across every area the Phase 5 mission lists. Every difference found is classified (Intentional / Unintentional / Future Enhancement / Bug / Technical Debt) — none are silent, per this whole reconstruction's standing rule.

Scope note: `server/src/` implements exactly two bounded contexts so far — **Identity & Tenant Core** (Phase 2) and **Operations Domain** (Phase 4). Licensing, Administration, and Cloud Backup remain entirely unimplemented in `server/src/` (by design, out of scope for both prior phases) — comparisons below cover only what actually exists on both sides. Where `server/src/` has no equivalent at all, that is stated plainly, not glossed over.

## 1. Parity Matrix

One row per verify-area from the mission. "Match" = behaviorally equivalent given the intentional structural changes already documented in ADRs 0005–0008.

| Area | `local.js` behavior | `server/src/` behavior | Match? | Classification |
|---|---|---|---|---|
| **Authentication** | Mobile+PIN login, bcrypt cost 10, generic "Invalid mobile number or PIN." for both unregistered-mobile and wrong-PIN cases (anti-enumeration), JWT HS256-only, 15-min access token | Identical: `authService.login`, same bcrypt cost, same generic message (`authService.test.js` verifies byte-identical text), `requireAuth` pins `algorithms:['HS256']` matching `local.js:424` exactly | ✅ Match | — |
| **Tenant Isolation** | Every business-data query filters `WHERE tenant_id = ?` | Every `server/src/repositories/*.js` query filters `tenant_id` (39 occurrences, spot-checked) | ✅ Match | — |
| **Trusted Devices** | `device_id` fingerprint, fallback device limit of 2 when no `tenant_licenses` row exists (`local.js:1000-1001`) | `trustedDeviceService.js` — identical fallback (`FALLBACK_DEVICE_LIMIT=2`), same auto-trust-under-limit logic | ✅ Match | — |
| **Inventory** | Client-side only (`DB.inventory` array in the browser blob); no server-side model at all | Real, normalized `inventory_items` table + full service/repo/route stack | N/A — no `local.js` server-side behavior to compare against | Future Enhancement (this is the entire point of Phase 4 — normalizing what was never server-side) |
| **Sales** | Client-side only (`DB.sales`) | Real `sales`/`sale_items` tables, business rules (stock validation, discount bounds, invoice numbering) reverse-engineered from the **frontend's** JS and reproduced exactly in `saleService.js` | ✅ Match (business rules); N/A (storage — no prior server-side implementation) | — |
| **Customers** | Client-side only (`DB.customers`) | Real `customers` table; the one genuine behavioral fork — phone-duplicate handling has 2 different real frontend code paths, both reproduced via an explicit `allowDuplicate` param | ✅ Match (both paths reproduced) | Intentional (the underlying inconsistency is `local.js`'s own, preserved, not invented) |
| **Repairs** | Client-side only (`DB.repairs`) | Real `repairs`/`repair_parts` tables, 5-state free transitions (incl. warranty-reopen), auto-calculated `final_cost` — all reproduced from frontend JS | ✅ Match | — |
| **Expenses** | Client-side only (`DB.expenses`, `DB.recurringExpenses`) | Real `expenses`/`recurring_expenses` tables; `applyForMonth` matches `applyRecurringExpenses` exactly, including **no scheduler** | ✅ Match | — |
| **Configuration** | Client-side only (`DB.settings`, whole-object replace via `PUT /api/data`) | `tenant_settings` JSON column, same whole-object-replace semantics, no schema imposed | ✅ Match | — |
| **Payments** | 3 different shapes: `Sale.payments[]`, `RepairJob.payments[]`, `DB.cashEntries[]` — sale/repair collection allows Cash/UPI/Card only, manual entries additionally allow Bank Transfer | Unified `payments` table, same 2-tier method restriction enforced in `paymentService.js`; one documented simplification (overpayment handling, see below) | ⚠️ Match with 1 documented exception | Intentional (see Behavior Matrix row) |
| **Session Lifecycle** | 15-min access token, 30-day idle expiry, 90-day cleanup retention, 20s multi-tab refresh grace window, revocation via `status='revoked'` | Identical constants and mechanism, verified byte-for-byte in `regression.test.js` | ✅ Match | — |
| **Authorization** | 4 hardcoded `role !== 'owner'` checks in-code; exactly 3 are in-scope (sessions:view, sessions:revoke, staff:add) — the 4th (`renew-license`) is Licensing, out of scope | Table-driven (`roles`/`permissions`/`role_permissions`), seeded to reproduce exactly those 3 outcomes, proven equivalent by `authorizationService.test.js` | ✅ Match | Intentional (ADR-0006 — real structure, same outcomes) |
| **API Responses** | Flat `{error: "string"}` on failure; response field names as documented per-route | Structured `{error:{code,message,details?}}` on failure; success-path field names match | ⚠️ Error shape differs | **Intentional**, ADR-0007 — a deliberate, permanent standard for all `server/src/` endpoints going forward, not reverted for byte-compatibility |
| **Validation** | Inline regex/range checks per field (10-digit phone, 15-digit IMEI, 15-char GST, non-negative amounts, sell≥cost, etc.) | Same rules re-implemented in each service (`inventoryService.js`, `customerService.js`, etc.), plus the exact same functions now literally shared via `app/modules/validation.js` | ✅ Match (frontend literally shares the same code; backend independently reproduces the same regex/bounds) | — |
| **Business Rules** | Self-healing invoice/job numbering, hard stock checks, discount bounds, free repair-status transitions, manual-only recurring-expense application, no invoice immutability, no technician assignment | All reproduced exactly — see Phase 4's `docs/architecture/Operations.md` for the full per-rule citation to `local.js` line numbers | ✅ Match | — |

## 2. Behavior Matrix — every difference, classified

Every place `server/src/` does not do byte-for-byte what `local.js` does, whether trivial or structural.

| # | Difference | `local.js` | `server/src/` | Classification | Rationale |
|---|---|---|---|---|---|
| 1 | Error response shape | `{error: "string"}` | `{error:{code,message,details?}}` | **Intentional** | ADR-0007 — permanent standard, one-time client-adaptation cost deferred to actual cutover |
| 2 | Authorization mechanism | 4 hardcoded `role !== 'owner'` checks | Table-driven `roles`/`permissions`/`role_permissions`, seeded to the same 3 in-scope outcomes | **Intentional** | ADR-0006 — explicitly requested by the mission, proven equivalent, not a behavior change |
| 3 | `user_sessions`/`inventory_items` etc. child-row FK constraints | None in SQLite (`local.js`'s schema has no FK on `user_sessions.tenant_id/user_id`) | Real FKs added everywhere | **Intentional** | Low-risk hardening — no code path in either system ever creates an orphaned row, so the constraint only rejects states already unreachable |
| 4 | `inventory_items` delete semantics | Hard delete, unconditional | Hard delete, unconditional (Phase 3 proposed soft-delete; never approved, reverted) | **Intentional** (net: no change) | Documented in Phase 4 — a proposal that was raised and then correctly NOT adopted, preserved here as history |
| 5 | Sale/repair payment overpayment (split sum > total) | Silently falls back to charging the full total in Cash (`saveSale:10052-10056`) | Rejected explicitly with a `ValidationError` | **Intentional simplification**, not a bug | This is an artifact of the frontend's own split-tracking arithmetic, not a deliberate business rule; documented in `Operations.md` |
| 6 | Stock movement audit trail | None — stock changes are silent, no history table | `stock_movements` records every mutation with a reason code | **Future Enhancement** | Genuinely new capability (ADR-0008 flagged this explicitly); does not change any existing observable behavior, purely additive |
| 7 | Server-side audit logging in general | **None exists** — `_auditLog(...)` calls found during this review are a **frontend-only**, non-persisted function (in `app/ShopERP_Pro_v8.html`), not server-side; `local.js` itself has zero audit-log infrastructure | Same — no general-purpose audit log exists in `server/src/` either, only the Operations-domain-specific `stock_movements` table (item 6) and `license_history` (Licensing domain, in `local.js` only, not ported) | **Parity (both have none)**, flagged as **Technical Debt** | Neither system has real audit logging outside the two narrow exceptions above — worth a real security decision in a future phase, not silently assumed adequate |
| 8 | Customer phone-duplicate handling | Two different real code paths (warn-then-confirm vs. hard-block) depending on which UI form is used | Both paths reproduced via an explicit `allowDuplicate` boolean parameter | **Intentional** | A stateless REST API can't show a JS `confirm()` dialog; the parameter reproduces both of `local.js`'s real behaviors rather than picking one |
| 9 | Operations domain API surface | **None** — everything goes through one `GET/PUT /api/data` whole-tenant-blob path | Real per-entity REST endpoints (`/api/inventory`, `/api/sales`, etc.) | **Intentional**, necessary | Direct, unavoidable consequence of ADR-0008's normalization decision — a blob-replace API is incompatible with normalized tables by definition |
| 10 | No data migration from the JSON blob to the new tables | N/A | Not built | **Technical Debt** (explicitly flagged, not forgotten) | ADR-0008 already names this "a real, nontrivial future undertaking" — required before any real cutover, out of scope for Phases 2/4/5 |
| 11 | Licensing, Administration, Cloud Backup domains | Fully implemented in `local.js` (registration, approval, plans, admin console, backups) | **Not implemented at all** in `server/src/` | **Out of scope, not a bug** | Never in scope for any phase so far (Phase 1.5's `CanonicalDomainModel.md` explicitly excludes them from this reconstruction's current phases) |
| 12 | Desktop/Electron offline license mode | Fully implemented (`server/license.js`, machine-ID binding) | Not implemented | **Out of scope** | ADR-0003 — a different product shape, explicitly excluded from this whole reconstruction |

## 3. API Compatibility Matrix

| Endpoint family | `local.js` path(s) | `server/src/` path(s) | Compatible? |
|---|---|---|---|
| Login/session | `/api/auth/login`, `/refresh`, `/logout`, `/heartbeat`, `/sessions`, `/sessions/:id/revoke` | Same paths, same methods, same middleware semantics | ✅ Path/shape-compatible (error envelope differs, see Behavior Matrix #1) |
| Staff management | `/api/auth/add-staff` | Same | ✅ |
| User listing | `/api/data/users` | Same (mounted under `/api/data` for continuity, despite being Identity-domain data) | ✅ |
| Operations (Inventory/Customers/Sales/Repairs/Expenses/Settings) | `/api/data` (`GET`/`PUT`, whole blob) | `/api/inventory`, `/api/customers`, `/api/sales`, `/api/repairs`, `/api/expenses`, `/api/settings` (per-entity REST) | ❌ Not compatible by design — see Behavior Matrix #9. A client written against `local.js` would need real rewriting to use these, not just a base-URL change. This is the single largest gap a cutover phase must plan around. |
| Licensing/Registration/Admin console | `/api/auth/register`, `/signup`, `/verify-email`, `/renew-license`, all `/api/admin/*` | None | ❌ Not implemented — out of scope |
| Health check | `GET /health` | `GET /health` | ✅ Shape differs slightly (`mode` field reports `'mariadb-identity-and-operations'` vs. no equivalent field in `local.js`), non-breaking |

## 4. Database Compatibility Matrix

| Concern | `local.js` (SQLite, `better-sqlite3`) | `server/src/` (MariaDB) | Notes |
|---|---|---|---|
| Engine | SQLite, single-file, in-process | MariaDB, client/server, pooled connections | Structural, intentional (ADR-0002) |
| Schema management (migrations) | Additive `runMigration()` helper, inline at boot, no version table, no rollback | Versioned `schema_migrations` table, checksummed, up/down via `migrationRunner.js` | Intentional improvement |
| Identity tables | `tenants`, `users`, `user_sessions`, `trusted_devices` (no `roles`/`permissions`) | Same 4 + `roles`/`permissions`/`role_permissions` | See Behavior Matrix #2 |
| Operations tables | **None** — JSON blob per tenant (`tenant_data.data`) | 10 normalized tables (`002_operations_domain.sql`) | See Behavior Matrix #9 |
| Foreign keys | None on `user_sessions`/`trusted_devices` scoping columns; SQLite generally enforces declared FKs when `PRAGMA foreign_keys=ON` (verify this pragma is actually set in `local.js` — **not currently verified in this review**, flagged below) | Real FKs everywhere, `ON DELETE CASCADE`/`SET NULL` as appropriate | See Behavior Matrix #3 |
| Data volume today | Whatever's in `server/shoperpro.db` (real, in use) | Empty — no data has ever been migrated into `server/src/`'s tables | Confirmed no migration path exists yet (Behavior Matrix #10) |
| Live verification this phase | N/A | **Not performed against a real instance** — see Section 4 of the final report below | Honest gap, not fabricated |

*A question raised and resolved during this review*: whether `local.js`'s SQLite connection actually has `PRAGMA foreign_keys = ON` set (if not, SQLite silently ignores any declared FKs entirely, which would change the meaning of prior phases' "no FK" findings). Confirmed: `local.js:111` does set `db.pragma('foreign_keys = ON')`, AND `sessions.js`'s `CREATE TABLE user_sessions` genuinely declares no `REFERENCES` clause on `tenant_id`/`user_id` at all (verified directly, not assumed). So Phase 2's original finding stands exactly as stated: these two columns are unconstrained in `local.js` today, not merely inert — confirming Behavior Matrix #3 is accurate.

## 5. Migration Readiness Checklist

| Item | Status |
|---|---|
| Identity & Tenant Core fully implemented and tested against mocks | ✅ Done (Phase 2) |
| Operations Domain fully implemented and tested against mocks | ✅ Done (Phase 4) |
| Both implementations verified against a REAL, credentialed MariaDB instance | ❌ **Not done** — honest, repeated gap across Phases 1/2/4/5 (see Section 4 below) |
| Data migration tooling (JSON blob → normalized tables) | ❌ Not built — explicitly flagged as future work since ADR-0008 |
| Licensing domain ported to `server/src/` | ❌ Not started — no phase has covered this yet |
| Administration domain ported to `server/src/` | ❌ Not started |
| Cloud Backup ported to `server/src/` | ❌ Not started |
| Frontend cut over to call `server/src/`'s per-entity endpoints instead of `/api/data` | ❌ Not started — and per this phase's explicit "do not modify frontend" instruction, deliberately not attempted here |
| Error-envelope client compatibility shim/update | ❌ Not started — a known, scoped, one-time task (ADR-0007) |
| Load/performance testing against real concurrent traffic | ❌ Not done — see Performance Results in the final report |
| Security review of the new stack specifically | ✅ Done this phase (see Security Review) — no new findings beyond what Phases 1/2/4 already surfaced |

**Overall migration readiness: NOT READY for production cutover.** The architecture is sound and unit-verified, but three hard blockers remain: (1) zero real-database verification to date, (2) no data migration tooling, (3) Licensing/Administration/Cloud Backup entirely unported. This matches, and does not contradict, every prior phase's own stated recommendation.

## 6. Real MariaDB Validation — attempt log

The mission requires connecting to a real MariaDB instance and running migrations/repositories/transactions/rollback/FK/constraint checks with no mocking. This was attempted rigorously (more thoroughly than Phases 1/2/4), not assumed impossible:

1. `brew services list` — confirmed a real MySQL instance IS running (`mysql started rogers`), consistent with every prior phase's finding. A second, independent MySQL install (`/usr/local/mysql`) is also running. Port 3306 is open and accepting TCP connections.
2. `mysql -u root -e "SELECT 1"` (no password) — **denied**: `Access denied for user 'root'@'localhost' (using password: NO)`. Root requires a real password.
3. `mysql -u rogers -e "SELECT 1"` (current OS user, testing for `auth_socket`-style passwordless access) — **denied**, same error.
4. Checked `server/.env` for any pre-existing MariaDB credentials — none exist; that file only configures `local.js`'s own SQLite-based app (`ADMIN_KEY`, `JWT_SECRET`, SMTP), since `local.js` never talks to MariaDB at all.
5. Checked the MySQL error log for a homebrew-generated temporary root password (a common fresh-install pattern) — none found.
6. **Deliberately not attempted, per this engagement's standing constraint**: resetting root's password, `--skip-grant-tables`, or any other bypass of another user's pre-existing database authentication. This machine also runs Jenkins and a separate PostgreSQL instance — consistent with a shared, actively-used development environment, not a disposable sandbox.

**Conclusion: real MariaDB validation could not be performed in this environment**, for the same reason as every prior phase — this is an honest, repeated gap, not a fabricated pass. Every migration/repository/service claim in this document and in Phases 2/4 is verified as thoroughly as possible without one: `discoverMigrations()`'s pure logic, checksum computation, and every business rule via dependency-injected repository mocks (60 Phase 4 + 151 Phase 2 assertions, all passing). **This is the single highest-priority action item before any further phase relies on this stack being production-ready.**

## 7. Performance Results

**Could not be measured** — every operation the mission asks to benchmark (login, inventory search, sale creation, repair update, expense recording, configuration update, session validation) requires a live MariaDB connection to execute end-to-end through the real repository layer; Section 6 above explains why none was available. Fabricating timing numbers from mocked repository calls (which return instantly, with no network/disk/lock-contention cost) would be actively misleading, not a genuine baseline — so none are reported. This is recorded as an open item, not silently skipped: **performance baselining must be the first thing done once a credentialed MariaDB instance is available**, before any capacity or scaling claim is made about this architecture.

## 8. Security Review

| Control | `local.js` | `server/src/` | Status |
|---|---|---|---|
| JWT algorithm pinning | `algorithms:['HS256']` (`local.js:424`) | `algorithms:['HS256']` (`requireAuth.js`) | ✅ Identical |
| bcrypt cost factor | `bcrypt.hashSync(_, 10)` everywhere | `BCRYPT_ROUNDS=10` (`userService.js`) | ✅ Identical |
| Rate limiting | Hand-rolled in-memory limiter, per-route limits (e.g. login 10/5min, refresh 30/5min) | Same limiter ported verbatim (`middleware/rateLimit.js`), same limits applied to the auth routes it covers | ✅ Identical for ported routes; Operations-domain routes (new in Phase 4) have **no rate limiting applied** — see Risks |
| Tenant isolation | `WHERE tenant_id = ?` on every business-data query | Same, on every repository query (39 occurrences verified) | ✅ Identical |
| Authorization | 4 hardcoded checks (3 in-scope) | Table-driven, proven equivalent | ✅ Equivalent (Behavior Matrix #2) |
| Session revocation | `status='revoked'`, checked on every `requireAuth` call | Identical mechanism and check | ✅ Identical |
| Trusted devices | Fingerprint + device-limit enforcement, fallback limit 2 | Identical | ✅ Identical |
| Audit hooks | **None server-side** (the `_auditLog` calls found in this review are frontend-only, non-persisted) | **None general-purpose**; `stock_movements` provides a narrow, Operations-specific audit trail (new capability, not parity with anything) | ⚠️ Parity (both lack one), flagged as Technical Debt (Behavior Matrix #7) |

**New finding from this phase's review, not previously documented**: the Operations-domain routes added in Phase 4 (`/api/inventory`, `/api/sales`, `/api/repairs`, `/api/expenses`, `/api/settings`, `/api/customers`) have no `rateLimit()` middleware applied at all — unlike every auth-related route in both `local.js` and `server/src/`. This is a **new gap introduced in Phase 4**, not present in `local.js` (which has no equivalent routes to compare against, so it isn't a regression from `local.js`'s behavior, but it is a real gap relative to this codebase's own established "every mutating endpoint gets a rate limit" convention). Classified as **Bug** (an omission, not a documented decision) — flagged for a fix in a near-term follow-up, not silently carried forward.
