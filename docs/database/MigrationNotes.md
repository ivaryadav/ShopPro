# Migration Notes — Identity & Tenant Core (Phase 2) + Operations Domain (Phase 4)

Consolidated reference for every place this phase's implementation deliberately deviates from, defers, or extends `server/local.js`'s actual behavior. Per the mission's own instruction ("if code and documentation disagree: document it, do not silently change behavior"), nothing below is silent.

## Database

- **`001_identity_tenant_core.sql`** replaces Phase 1's placeholder `001_initial`/`002_example` migrations entirely (never applied to any real database — safe to replace, not edit-after-apply).
- **`tenants`** carries only `status`/`suspend_reason` from `local.js`'s table — not `license_key_hash`/`license_expiry`/`license_plan` (Licensing-domain columns living on that table historically, out of scope here).
- **`users.role_id`** (FK to a new `roles` table) replaces `users.role` (free TEXT) — normalizes the existing 2-value enum, doesn't add a new role.
- **`roles`/`permissions`/`role_permissions`** are new tables with no `local.js` equivalent — see `docs/adr/0006-table-driven-authorization.md`. Seeded to reproduce exactly 3 real gates found in `local.js` (`sessions:view`, `sessions:revoke`, `staff:add`); `GET /api/data/users` deliberately has no seeded permission, since `local.js` has no gate on it either.
- **`user_sessions` gains real FK constraints** on `tenant_id`/`user_id` — `local.js`'s SQLite version has none (confirmed, `docs/architecture/EntityRelationship.md`). Low-risk hardening: no code path creates a session for a nonexistent tenant/user today.
- **Excluded entirely**: `tenant_licenses`, `license_history`, `subscription_plans` (Licensing), `admin_credentials` (Administration), `cloud_backups` (Administration, legacy) — all out of scope per the mission's explicit instruction.

## Endpoints not migrated, and why

| Endpoint | Reason |
|---|---|
| `POST /api/auth/register` | Creates a `tenant_licenses` row as part of registration — Licensing-entangled. |
| `POST /api/auth/signup` | Same — creates a `PENDING_APPROVAL` `tenant_licenses` row. |
| `POST /api/auth/renew-license` | Pure Licensing. |
| `POST /api/admin/reset-user-pin` | Gated by `requireAdminKey` (`AdminCredentials`), Administration domain. Business logic exists and is tested (`services/userService.js#resetPin`); no public route yet. |
| `POST /api/admin/toggle-user` | Same — `services/userService.js#setActive` is implemented/tested, no public route. |

## Business-rule deviations (all verified equivalent, not silently different)

1. **Device limit fallback** — `local.js:1000-1001` reads `tenant_licenses.device_limit`, falling back to a fixed `2` when no license row exists. Since `tenant_licenses` is out of scope, Phase 2 always takes that fallback branch — it's `local.js`'s own existing code path, not a new default (`services/trustedDeviceService.js`).
2. **`requireActive` has no license-expiry check** — `local.js`'s version also checks `license_expiry`/`license_plan` for legacy key-based tenants; Phase 2's `tenantService.assertActive()` only checks `status` (paused/terminated), since the expiry columns are Licensing-domain.
3. **Error response shape changed** — `local.js` returns `{error: "string"}`; Phase 2's `errorHandler` returns `{error: {code, message, details?}}`. A real API-shape difference, not preserved byte-for-byte (`docs/security/Security.md`). No impact today (nothing is cut over); relevant for whichever future phase does the actual cutover.
4. **`resetPin`/`setActive` have no public route** — see table above.

## What was extended beyond a literal 1:1 port (low-risk, justified)

- Session cleanup job now runs on the same 30-minute interval as `local.js`'s `_runSessionCleanup()` (`app.js`).
- `user_sessions` FK hardening (above).
- `role_id` normalization (above).

## Rollback

`migrations/001_identity_tenant_core.rollback.sql` drops all 6 tables in FK-safe order. Since this schema has never been applied to any real production database (no cutover has happened), rollback risk is theoretical at this stage — this note exists for when a future phase actually deploys against a real MariaDB instance for the first time.

## Known gap: no live MariaDB verification in this environment

Every `*.test.js` file's database-dependent assertions report an honest skip in this session (a MySQL server is running locally but this session has no credentials to it, and did not attempt to bypass another user's pre-existing authentication). All non-DB-dependent logic is fully tested via repository mocking. **Re-run `npm run test:src` against a real, credentialed MariaDB instance before relying on this stack in production.**

---

# Phase 4 additions — Operations Domain

Full narrative: `docs/architecture/Operations.md`. This section covers only what's specific to `002_operations_domain.sql` beyond what that document already states.

## Database

- **`002_operations_domain.sql`** adds 10 tables: `inventory_items`, `customers`, `sales`, `sale_items`, `repairs`, `repair_parts`, `expenses`, `recurring_expenses`, `stock_movements` (new), `payments` (new, unifying), `tenant_settings`. Implements `docs/database/OperationsSchemaDesign.md` (Phase 3 design) with two documented deviations (see `docs/architecture/Operations.md`'s "Documented deviations" section) — no `is_deleted` column, and nullable `created_by`/`product_id` FKs with `ON DELETE SET NULL`.
- **No data migration from the JSON blob.** This phase builds the layered MariaDB implementation in `server/src/`, exactly like Phase 2 — it does NOT parse `tenant_data.data`'s existing JSON blob and insert rows. `local.js`'s live data remains completely untouched and unread by this migration. A future cutover phase would need a separate, one-time blob-to-relational data migration (already flagged as "a real, nontrivial future undertaking" in ADR-0008).

## Endpoints — all new (see `docs/architecture/API.md`'s "Operations domain endpoints" table)

`local.js` never had per-entity Operations endpoints to preserve compatibility with — the entire surface in `docs/architecture/API.md`'s Phase 4 table is new REST surface, a direct, necessary consequence of ADR-0008's normalization decision.

## Business-rule deviations (all documented, not silent)

See `docs/architecture/Operations.md`'s "Documented deviations" section for the full list (soft-delete reversal, payment-overpayment simplification, customer phone-duplicate reproduction via `allowDuplicate`).

## What was extended beyond a literal 1:1 port (low-risk, justified)

- `stock_movements` — genuinely new capability (audit trail), not an extraction; no current data to migrate.
- Atomic SQL stock increment/decrement (`GREATEST(0, stock ± ?)`) instead of JS read-then-write, for the sale/repair hot paths — a real hardening against concurrent writes `local.js`'s single in-process array never had to consider, while preserving the exact same clamp-at-zero semantics. `adjustStock` (manual, low-frequency) still reads-then-writes so its audit-log delta matches `local.js`'s own prev→new message exactly.

## Known gap: no live MariaDB verification in this environment (same as Phase 2)

`server/src/tests/operationsCore.integration.test.js` reports an honest skip in this session, for the same reason as Phase 2's `identityCore.integration.test.js`. All business logic is fully tested via repository mocking in `inventoryService.test.js`, `customerService.test.js`, `saleService.test.js`, `repairService.test.js`, `expenseService.test.js`, and `paymentService.test.js`. **Re-run `npm run test:src` against a real, credentialed MariaDB instance before relying on this stack in production.**
