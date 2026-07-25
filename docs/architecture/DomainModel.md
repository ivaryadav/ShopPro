# Domain Model — Full Entity Detail

Companion to `CanonicalDomainModel.md`. Every entity that is real in the current code gets the full template below. Every entity the originating mission expected but that doesn't exist gets a short honest note instead, so its absence is a documented fact, not a silent gap.

Template: Purpose · Business Responsibility · Owner · Lifecycle · Relationships · Required Fields · Optional Fields · Unique Constraints · Business Invariants · Deletion Rules · Security Rules · Audit Requirements · Future Extension Points.

---

# Bounded Context: Identity (Server)

## Tenant

- **Purpose**: The paying customer — one mobile-repair shop using ShopERP's hosted mode.
- **Business Responsibility**: Owns every User, every License, and (once a future phase models it server-side) every piece of operational business data for that shop.
- **Owner**: Itself — the root of the ownership tree. Nothing owns a Tenant except the platform operator (Super Admin).
- **Lifecycle**: See `LifecycleDiagrams.md`. Legacy `tenants.status` (`active`/`paused`/`terminated`) and the authoritative `tenant_licenses.status` (5-state) now kept in sync (`docs/independent-audit/FinalBlockerResolution.md`).
- **Relationships**: 1-to-many with User, 1-to-1 with TenantLicense, 1-to-1 with tenant_data (the JSON blob), 1-to-many with LicenseHistory, TrustedDevice (via User).
- **Required fields**: `shop_name`.
- **Optional fields**: `address`, `gst_number` (both default `''`), `license_key_hash`/`license_expiry`/`license_plan` (legacy key-based tenants only).
- **Unique constraints**: `license_key_hash` (partial unique index, legacy key-based registration only).
- **Business invariants**: A Tenant is never hard-deleted by any code path in this codebase (confirmed: the only `DELETE FROM` anywhere in `server/local.js` targets the unrelated `cloud_backups` table). `is_active` exists as a column but no code path in the current server ever sets it to anything other than its default — it is vestigial.
- **Deletion rules**: No deletion path exists. `ON DELETE CASCADE` is declared on every child table's `tenant_id` FK as a referential-integrity safety net, but is never actually triggered in practice.
- **Security rules**: All tenant-scoped, non-admin endpoints source `tenant_id` exclusively from the verified JWT payload (`req.user.tenantId`), never from client input (`docs/independent-audit/APIAudit.md` — no IDOR path found). Admin endpoints operate cross-tenant by design via `requireAdminKey`.
- **Audit requirements**: Status changes are logged to `license_history`. No general Tenant-attribute change log exists (e.g., editing `shop_name` is not audited).
- **Future extension points**: This is where a future phase's Operations domain (Inventory/Sales/etc., currently desktop-only) would attach once modeled server-side.

## User (Server)

- **Purpose**: An individual login within a Tenant — the shop owner or a staff member, for the hosted/SaaS mode.
- **Business Responsibility**: Authenticates, holds a Role, is the actor behind every tenant-scoped API action.
- **Owner**: Tenant (1 Tenant → many Users).
- **Lifecycle**: Created (via registration or admin add-staff) → Active → (optionally) deactivated (`is_active=0`, soft only) — no further states.
- **Relationships**: Many-to-1 Tenant; 1-to-many Session; 1-to-many TrustedDevice.
- **Required fields**: `tenant_id`, `username`, `password_hash`. `mobile` is required by every real registration/add-staff code path even though the column itself is nullable.
- **Optional fields**: `display_name`, `email`, `email_verify_token_hash`/`email_verify_expires`/`email_verified_at` (only populated for the new self-service signup flow, not the legacy key-based one).
- **Unique constraints**: `(tenant_id, username)` composite; `mobile` globally unique (partial index, `WHERE mobile IS NOT NULL`) — i.e. a mobile number can only ever belong to one user across the *entire* platform, not just within one tenant.
- **Business invariants**: Exactly two role values exist server-side: `'owner'` and `'staff'` — no `'manager'`/`'technician'` distinction server-side (unlike the desktop app — see below). Password is always bcrypt (`docs/independent-audit/IndependentSecurityReview.md` §3) — never SHA-256 for a real user credential.
- **Deletion rules**: No hard-delete path; `is_active=0` is the only "removal," and a business rule (`local.js:1357-1360`) specifically blocks deactivating the *last remaining active owner* of a tenant, to prevent a tenant from ending up with zero administrators.
- **Security rules**: PIN verified via `bcrypt.compareSync`; login failure messages are generic regardless of whether the mobile number exists (`docs/independent-audit/IndependentSecurityReview.md` §4) — a real, enforced anti-enumeration rule, not merely aspirational.
- **Audit requirements**: `last_login` timestamp updated on every successful login. No structured audit-log table server-side (see AuditLog note below) — admin actions on users (PIN reset, activate/deactivate) are only `console.log`'d, not queryable.
- **Future extension points**: A `'manager'`/`'technician'` role distinction, matching the desktop app, if the hosted mode ever needs it.

## Role (Server)

- **Purpose**: Coarse authorization tag on a User.
- **Business Responsibility**: Gates owner-only actions (view sessions, revoke sessions, add staff, view users) — every gate found is `if (req.user.role !== 'owner')`.
- **Owner**: User (a field on it, not a separate table).
- **Lifecycle**: Set at creation (`'owner'` for the tenant's first user, `'staff'` for anyone added afterward via `add-staff`), mutable only implicitly (no endpoint changes an existing user's role today).
- **Relationships**: Embedded field, not a foreign key.
- **Required/Optional/Unique**: N/A — a `TEXT` column, defaulting to `'staff'`.
- **Business invariants**: Only `'owner'` and `'staff'` are ever written server-side.
- **Deletion rules**: N/A.
- **Security rules**: This is the *entire* authorization model server-side — see Permission below.
- **Audit requirements**: None beyond what's logged for the action the role gated.
- **Future extension points**: N/A until a real Permission model is designed.

## Permission — does not exist

No `permissions` table, no permission-object model, anywhere server-side or client-side. Every authorization decision in this codebase is a hardcoded role-string check at the point of use (`if (req.user.role !== 'owner')` server-side; `_requireRole(['owner','superadmin','manager'])`-style array literals client-side). Documented here as a confirmed absence per the mission's own instruction to document entities honestly, not invent them.

## Session

- **Purpose**: One authenticated login instance for one User, on one device.
- **Business Responsibility**: Carries the JWT/refresh-token pair, tracks activity, is the unit of revocation.
- **Owner**: User (many-to-1); denormalized `tenant_id` for fast tenant-scoped queries.
- **Lifecycle**: `active` → (`revoked` on logout/admin action, or naturally superseded by refresh rotation) → hard-deleted only by the periodic cleanup job, and only once both expired *and* past a 90-day retention window (`CLEANUP_RETENTION_MS`).
- **Relationships**: Many-to-1 User; many-to-1 Tenant (denormalized).
- **Required fields**: `session_id`, `tenant_id`, `user_id`.
- **Optional fields**: `device_id`, `jwt_id`, `current_page`, `ip_address`, `browser`, `os`, refresh-token fields.
- **Unique constraints**: `session_id`.
- **Business invariants**: 15-minute access-token TTL, 30-day refresh-token TTL, a 20-second refresh-token reuse grace window (to tolerate two browser tabs racing a refresh, `sessions.js:18-26`) — not an unlimited or unbounded grace period.
- **Deletion rules**: This is the **one entity in the entire domain that IS eventually hard-deleted** — but only rows that are both already revoked/expired AND older than the 90-day retention window; a genuinely still-relevant session row is never deleted.
- **Security rules**: `requireAuth` re-validates session status server-side on every request (`sessions.checkSession`), not just JWT signature validity — a revoked session's still-cryptographically-valid JWT is still rejected.
- **Audit requirements**: `login_time`/`last_activity` timestamps only; no separate session-history log beyond the row itself (once deleted by cleanup, that history is gone — this is the one place data genuinely disappears, by explicit, bounded design, not by accident).
- **Future extension points**: None identified.

## TrustedDevice

- **Purpose**: Tracks which physical devices a User has logged in from, to enforce a per-plan device limit.
- **Business Responsibility**: Auto-trust under the plan's `device_limit`; hard-reject over it.
- **Owner**: User (many-to-1), denormalized to Tenant.
- **Lifecycle**: Created on first login from a new `device_id` → active → soft-removed (`is_active=0`) by admin action or a full tenant device reset — **never hard-deleted** (an explicit, confirmed audit-trail-preservation choice, `docs/independent-audit/IndependentSecurityReview.md` §17).
- **Relationships**: Many-to-1 User; many-to-1 Tenant.
- **Required fields**: `tenant_id`, `user_id`, `device_id`.
- **Unique constraints**: `(tenant_id, user_id, device_id)`.
- **Business invariants**: Device limit is read from `tenant_licenses.device_limit` at login time, not cached anywhere else.
- **Deletion rules**: Soft-only, as above.
- **Audit requirements**: `DEVICE_REMOVED`/`DEVICES_RESET`/`DEVICE_LIMIT_CHANGED` events recorded in `license_history`.

---

# Bounded Context: Licensing (Server)

## SubscriptionPlan

- **Purpose**: A tier definition (TRIAL/BASIC/PREMIUM) — not a specific tenant's subscription, the *template* for one.
- **Owner**: Global, platform-level (not tenant-scoped).
- **Relationships**: Referenced by TenantLicense (`plan_code`).
- **Required fields**: `code` (unique), `label`, `device_limit`.
- **Optional fields**: `trial_days` (only meaningful for TRIAL).
- **Business invariants**: Exactly 3 rows seeded at every boot, idempotently (`TRIAL`/2 devices/14 days, `BASIC`/2 devices, `PREMIUM`/5 devices) — this is effectively a fixed, small, code-defined enum today, not something an admin creates new rows for through any UI.
- **Deletion rules**: Never deleted; `is_active` flag exists for soft-retirement of a tier (unused today).

## TenantLicense

- **Purpose**: One Tenant's specific subscription instance — status, plan, dates, device limit, the actual license key.
- **Business Responsibility**: **The single authoritative source of truth for whether a tenant may use the product** (`docs/independent-audit/FinalBlockerResolution.md`).
- **Owner**: Tenant (1-to-1, enforced by a `UNIQUE` constraint on `tenant_id`).
- **Lifecycle**: `PENDING_APPROVAL → ACTIVE → READ_ONLY → SUSPENDED → ARCHIVED` — full detail in `LifecycleDiagrams.md`.
- **Relationships**: 1-to-1 Tenant; many-to-1 SubscriptionPlan (`plan_code`); 1-to-many LicenseHistory.
- **Required fields**: `tenant_id` (unique).
- **Optional fields**: `license_key`, `billing_cycle`, `requested_plan_code`, `requested_devices_bucket`, `expires_at` (null = never, i.e. lifetime), `read_only_since`, `suspended_since`.
- **Unique constraints**: `tenant_id`; `license_key` (partial, `WHERE license_key IS NOT NULL`).
- **Business invariants**: Real, precise, code-verified timing rules — `ACTIVE → READ_ONLY` the instant `expires_at` passes; `READ_ONLY → SUSPENDED` exactly 30 days after `read_only_since`; `SUSPENDED → ARCHIVED` exactly 365 days after `suspended_since` (`local.js:565-600`, the sweep function, re-run every `LICENSE_SWEEP_INTERVAL_MS`, default 15 minutes).
- **Deletion rules**: Never deleted — `ARCHIVED` is the terminal state, not a delete.
- **Security rules**: Every protected endpoint gates on `status`, directly or via `requireActive()` as a redundant second layer (post `FinalBlockerResolution.md`).
- **Audit requirements**: Every status transition writes a `license_history` row, actor-tagged `'system'` (sweep) or `'admin'` (manual action).
- **Future extension points**: A genuine multi-plan-tier catalog if `SubscriptionPlan` ever grows beyond 3 fixed rows.

## LicenseHistory

- **Purpose**: Append-only audit trail of every event affecting a Tenant's License.
- **Business Responsibility**: The only durable record of *why* a tenant's status is what it is.
- **Owner**: Tenant (many-to-1, via `tenant_id` — not via TenantLicense directly, though every real row is about a tenant's license).
- **Lifecycle**: Created once, never modified, never deleted — genuinely append-only (confirmed: no `UPDATE`/`DELETE` against this table anywhere in `local.js`).
- **Event types observed in code**: `REGISTERED`, `EMAIL_VERIFIED`, `APPROVED`, `REJECTED`, `PLAN_ASSIGNED`, `TRIAL_STARTED`, `KEY_GENERATED`, `KEY_REGENERATED`, `EXTENDED`, `STATUS_CHANGED`, `DEVICE_REMOVED`, `DEVICES_RESET`, `DEVICE_LIMIT_CHANGED`, `SESSIONS_KILLED`, `NOTE_ADDED`, `CALL_LOGGED`, `BACKFILLED`.
- **Required fields**: `tenant_id`, `event_type`.
- **Optional fields**: `from_status`, `to_status`, `detail`.
- **Business invariants**: `actor` is always `'system'` or `'admin'` — there is no third actor value (e.g. the tenant itself never writes its own history row).
- **Deletion rules**: Never deleted — this is the domain's actual audit-log entity server-side, distinct from (and more rigorous than) anything client-side.
- **Future extension points**: A tenant-facing "your account history" view could read this directly; nothing today exposes it outside the admin dashboard.

## Registration (process, not a table)

- **Purpose**: The state a new self-service-signup Tenant is in before an admin reviews it.
- **What it actually is**: `tenant_licenses.status = 'PENDING_APPROVAL'`, created by `POST /api/auth/signup`, plus a `REGISTERED` `license_history` event. There is no dedicated `registrations` table — "the registration" *is* the tenant/user/license rows in their initial state.
- **Business invariants**: Approval requires `email_verified_at` to be set first (enforced at the approve endpoint) — an unverified registration cannot be approved.
- **Lifecycle**: `PENDING_APPROVAL` → (`ACTIVE` on approve) or (`ARCHIVED` on reject) — a subset of TenantLicense's own lifecycle, not a separate one.

## EmailVerification (process, not a table)

- **What it actually is**: Three columns on `users` — `email_verify_token_hash` (SHA-256 of a random 32-byte token, plaintext token emailed once, never stored), `email_verify_expires` (24 hours from signup), `email_verified_at` (null until verified). No separate `email_verifications` table.
- **Business invariants**: Token is single-use in effect (verifying sets `email_verified_at`, and the verify endpoint checks that field, not just the token hash, so a second click on the same email link is a no-op, not a re-verification).

---

# Bounded Context: Administration (Server)

## AdminCredentials — real entity, not in the originating mission's list

- **Purpose**: The single shared Super Admin operator identity for the entire hosted platform (not per-tenant).
- **Lifecycle**: Single row (`id=1`, enforced by `CHECK (id = 1)`), seeded from the `ADMIN_KEY` env var or its documented default, `algo` flips from `'sha256'` to `'bcrypt'` automatically on first successful legacy-hash login (`docs/production-hardening/PasswordMigration.md`).
- **Security rules**: See `docs/independent-audit/IndependentSecurityReview.md` §1/§3 for the full residual-risk discussion of the default-hash fallback.

## CloudBackup — real entity, not in the originating mission's list, legacy

- **Purpose**: A legacy bridge letting the offline desktop product push/pull a full backup to/from the hosted server, keyed by a hash of the desktop's own license key.
- **Business Responsibility**: Backup storage only — not part of the SaaS tenant model at all (no `tenant_id`).
- **Security rules**: Self-documented in its own code comment as authorizing via the *shared* admin credential rather than a per-tenant token — a known, disclosed limitation (`docs/independent-audit/APIAudit.md`), not fixed by this phase.
- **Deletion rules**: The *only* hard-delete path in the entire server codebase (`DELETE FROM cloud_backups WHERE key_hash = ?`) — and it is not customer business data, it's a superseded backup blob.

---

# Bounded Context: Identity (Desktop) — independent of the server model above

## User (Desktop)

- **Purpose**: A login within one offline-desktop installation.
- **Business Responsibility**: Same as server User conceptually, but a completely separate implementation — different hashing (`SHA-256(machineId :: 'shoperpro::pin::v1' :: pin)` via `crypto.subtle`, not bcrypt), different storage (`DB.users[]` in the same JSON blob as every other entity, not a table), auto-migrates legacy plaintext PINs on first successful verify.
- **Required fields**: `name`, `pin` (may start plaintext, self-upgrades to hashed).
- **Optional fields**: `phone`/`mobile` (used for WhatsApp-based PIN reset — the two creation paths inconsistently use different key names for the same concept).
- **Business invariants**: `'owner'` is effectively a singleton — created once at first setup, no UI path lets a second `'owner'` be created (`doAddStaff()`'s allowed-roles list is `['manager','staff','technician']` only).
- **Security rules**: A brute-force lockout mechanism exists (`_clearLockState`); a session-tampering guard (`_sigOf`/`_requireRole`'s signature check) detects console-based role tampering like `currentUser.role='owner'`.

## Role (Desktop)

- **Values found**: `'owner'`, `'manager'`, `'staff'`, `'technician'`, `'superadmin'`.
- **Business invariant, confirmed**: `'technician'` has **no distinct permission gate anywhere** in the code — it is a cosmetic label only; a technician has exactly the same permissions as `'staff'`.
- **Gated actions** (all 12 `_requireRole()` call sites): adjust stock / delete product / edit invoice / update invoice / delete repair job → `['owner','superadmin','manager']`. Add staff / remove staff / save settings / renew license / export backup / import data / factory reset → `['owner','superadmin']` only (manager cannot do these).

## SuperAdmin (a settings flag, not a Role value on a real user)

- **What it actually is**: `DB.settings._superAdmin === true` — a device/build-level override, not a field on any `DB.users` row. When true, login is bypassed entirely and a **synthetic, non-persisted** `currentUser` object (`{id:0, name:'Super Admin', role:'superadmin', ...}`) is used.
- **Security rules**: Import/restore code explicitly strips `_superAdmin` from imported settings and downgrades any imported user carrying `role==='superadmin'` back to `'owner'` — the developers treat this as a privileged, dangerous string that must never persist through normal data flows.

---

# Bounded Context: Inventory (Desktop only — no server equivalent)

## InventoryItem

- **Purpose**: One stocked product/part/phone.
- **Owner**: Tenant (implicitly — the whole `DB` blob is one tenant's data).
- **Relationships**: Referenced by SaleItem (`productId`) and RepairJob's `partsUsed[]` (`productId`) — both by ID, with name/price snapshotted at time of use (denormalized copies, not live joins).
- **Required fields**: `name`, `sellPrice` (must be ≥ `costPrice`, an enforced business rule).
- **Optional fields**: `category` (free-text, fixed 5-option dropdown), `sku` (auto-generated `PRD-<id>` if blank, **no uniqueness check**), `imei` (optional, format-checked, deduplicated), `costPrice`/`stock`/`minStock` (default to 0/0/2 if blank), `unit`.
- **Unique constraints**: `imei`, if present (enforced). **`sku` is not actually enforced unique** despite looking like an identifier — a real gap.
- **Business invariants**: `sellPrice >= costPrice` enforced at save time.
- **Deletion rules**: Hard-deleted (`deleteProduct` filters it out of the array) — the only entity in the *entire* domain, desktop or server, confirmed to be genuinely hard-deleted on a normal user action, not just an admin/legacy path. Deleting a product restores any of its quantity currently reflected in open `partsUsed[]` line items on repair jobs.
- **Audit requirements**: Manual stock adjustments log a text line to `DB.auditLog` (`stock-adjust`) — but the user-entered reason is collected in the UI and then silently discarded, never actually included in the log entry (a real, confirmed bug/gap).
- **Future extension points**: SKU uniqueness enforcement; a real Category/Brand/Supplier model if the business ever needs one (none exists today).

## Category, Brand, Supplier — do not exist as entities

- **Category**: a free-text field on InventoryItem populated from a fixed 5-value dropdown (`New Phone`/`Used Phone`/`Accessory`/`Spare Part`/`Other`); the "filter by category" UI derives its option list from whatever distinct strings already exist in the data, not from a master table.
- **Brand**: appears only in unused demo/seed data; zero live code reads or writes it.
- **Supplier**: does not exist in any form except a free-text `vendor` string on Expense/RecurringExpense records, unconnected to InventoryItem at all.

---

# Bounded Context: Sales (Desktop only — no server equivalent)

## Sale

- **Purpose**: A completed (or edited-in-place) sales transaction.
- **Relationships**: Many-to-1 Customer (`customerId`, required); 1-to-many nested SaleItem (`items[]`).
- **Required fields**: `customerId` (via New-Sale-modal flow; the POS quick-checkout flow instead auto-uses/creates a Walk-in Customer), at least one line item, non-negative discount not exceeding subtotal.
- **Optional fields**: `note`, `date` (defaults today), `payments[]` (defaults to a single Cash entry for the full paid amount if left blank).
- **Unique constraints**: `invoiceNo` — format `INV-###`, generated by a self-healing algorithm that scans both a counter and existing invoice numbers, with a final uniqueness-guaranteeing loop (`local.js`-style robustness, but implemented independently client-side, `nextInvoiceNo()`).
- **Business invariants**: **Stock sufficiency is hard-validated before a sale commits** — the save is blocked (not just warned) if any line item would oversell available stock. **Completing a sale decrements matching InventoryItem stock**; editing a sale restores original quantities then re-deducts the new ones (a correct delta pattern, confirmed in code).
- **Deletion rules**: **There is no delete/void/cancel function for a Sale anywhere in the code.** Once created, a Sale can only be edited, never removed.
- **Security rules**: Edit is gated to `owner`/`superadmin`/`manager` via `_requireRole` — but **not gated by any completion/age/payment-status check**. See Business Invariants correction in `BusinessRules.md`.
- **Audit requirements**: Sale *edits* are logged (`sale-edit`); Sale *creation* is **not logged** to `DB.auditLog` at all.
- **Future extension points**: A real void/return/cancel workflow; a genuine `status` field (a vestigial one is stamped by data-migration code but is never read anywhere and should not be relied upon).

## SaleItem

- **Purpose**: One product line within a Sale.
- **Owner**: Sale (nested array, not a top-level table/entity).
- **Fields**: `productId` (FK to InventoryItem), `name`/`price` (denormalized snapshot at time of sale — editable per-line by the cashier, so it can legitimately diverge from the InventoryItem's current price), `qty`.
- **Business invariants**: A duplicate `productId` added twice to the same in-progress sale increments `qty` rather than creating a second line — confirmed in `addProdToSale()`.

## Purchase, PurchaseItem — do not exist

No `DB.purchases` array, no create/save function, no line-item concept, anywhere in the codebase. Restocking is two manual, disconnected actions: optionally logging an Expense tagged `category:'Inventory Purchase'` (free text, no product link), and separately using InventoryItem's own stock-adjustment feature to increment quantity. Nothing in code ties these two actions together — no `purchaseId`, no shared reference. **Any future Purchasing domain is new design work, not an extraction of existing behavior.**

## StockMovement — does not exist

`InventoryItem.stock` is mutated in place from exactly three call sites (manual adjustment, sale creation, sale edit) with no structured, queryable movement log — only the manual-adjustment path writes even an unstructured text line, and it discards the reason the user typed in.

---

# Bounded Context: Repairs (Desktop only — no server equivalent)

## RepairJob

- **Purpose**: A customer's device in for repair, tracked from intake to delivery.
- **Relationships**: Many-to-1 Customer (`customerId`, real FK + denormalized name copy); many-to-many InventoryItem via `partsUsed[]` (`{productId, name, qty, price}`, same denormalized-snapshot pattern as SaleItem). **No technician/assigned-user field exists** — `createdBy` only records the creating user's *name* (a string, not an ID reference), not who's actually doing the repair.
- **Required fields**: `customerId`, `device`, `issue`.
- **Optional fields**: `note`, `altWa` (alternate WhatsApp, must be exactly 10 digits if given), `warranty` (days, defaults 30), advance-payment fields.
- **Unique constraints**: `jobNo` (format `JOB-<n>`, sequential, uniqueness-checked against existing jobs).
- **Business invariants**: Real lifecycle is `Received → Diagnosing → Repairing → Ready → Delivered` — confirmed exhaustively; **no** `Assigned`/`In Progress`/`Waiting`/`Cancelled` status exists in live code (only in unused demo seed data). Transitions are not strictly sequential — any status chip can be clicked directly from the Job Card UI. A warranty-claim re-open (`saveWarrantyEdit()`) force-resets status back to `Repairing` and clears the delivered date — a real, distinct sixth transition path back into the cycle, not a new terminal state.
- **IMEI**: **Not a field on RepairJob** — only in unused demo seed data. IMEI tracking exists solely on InventoryItem (for phones-as-stock, e.g. reselling a used phone), unrelated to a customer's device being repaired.
- **Deletion rules**: `deleteJob()` hard-deletes and **restores any parts-used quantities back to inventory stock** — there is no "Cancelled" status; a job that shouldn't proceed is deleted outright instead.
- **Financial fields**: `estimatedCost` (quoted at intake), `finalCost` (auto-recalculated = parts total + labour charge), `labourCharge`, `paymentStatus` (`Unpaid`/`Partial`/`Paid`, derived from `paidAmount` vs. cost), optional `advanceAmount` (capped to not exceed the estimate).
- **Security rules**: Delete is gated `owner`/`superadmin`/`manager`.
- **Audit requirements**: Status changes, updates, and deletion are all logged (`repair-status`, `repair-update`, `repair-delete`) — more thoroughly audited than Sale.
- **Future extension points**: A real technician-assignment field; a genuine warranty-claim history distinct from just re-using the main status field.

## Customer

- **Purpose**: The person a Sale or RepairJob is for.
- **Relationships**: Referenced by Sale and RepairJob via `customerId`; the reverse (a customer's sales/repairs) is computed on demand by filtering those arrays, not stored on Customer itself.
- **Required fields**: `name`, `phone` (validated as a real phone format).
- **Optional fields**: `email` (format-checked if given), `address`, `type` (`Regular`/`VIP`/`Wholesale`/`Shopkeeper`, defaults `Regular`), `note`.
- **Unique constraints**: Phone is only *soft*-unique — a confirm-dialog warns on a duplicate phone but the user can choose to proceed, and a second, separate duplicate check then still hard-blocks it — an internally inconsistent enforcement, documented as found, not fixed.
- **Business invariants — corrected**: A `balance` field is normalized onto every Customer record but **no code anywhere increments or decrements it** — it is dead schema. `loyaltyPoints`/`totalPurchase` exist only in unused demo data. **There is no active loyalty or credit-limit system today**, despite fields that look like there should be. "Pending dues" shown in the customer profile is computed live from unpaid sales, not a stored balance.
- **Deletion rules**: No delete function found for Customer.

---

# Bounded Context: Finance (Desktop only — no server equivalent)

## Expense

- **Required fields**: `title`, `amount` (≥ 0.01).
- **Optional fields**: `category` (from `EXP_CATS_DEFAULT`: Rent/Salary/Utilities/Inventory Purchase/Marketing/Maintenance/Other, plus tenant-defined custom categories stored on `DB.settings.customExpCats`), `date` (defaults today), `note`.
- **Business invariants — corrected**: `paidTo`/`paymentMode` fields exist only in unused demo seed data; the real create form never collects them.

## RecurringExpense — real entity, not in the originating mission's list

- **Purpose**: A template for a recurring monthly cost (e.g. rent).
- **Relationships**: Generates ordinary Expense rows via a **100% manually-triggered** "Apply This Month" button — there is no scheduler, no cron, no boot-time check. If the owner never clicks it in a given month, that month's expense is simply never created.
- **Business invariants**: `lastApplied` (a `YYYY-MM` stamp) prevents double-application within the same month if clicked twice.

## Payment — value object, not a standalone entity

Exists in two unconnected forms: (1) an embedded `payments[]` array on Sale/RepairJob (`{method, amount, date}`, methods limited to Cash/UPI/Card in the actual collection UI, with a 4th method, Bank Transfer, available only in the separate manual Cashbook entry form — an inconsistency, documented as found); (2) `DB.cashEntries[]`, a fully separate manual cash-ledger array (`in`/`out`, amount, description, method, date/time) unrelated to any specific sale or repair. The Cashbook report reconciles both plus Expenses into one computed running balance at render time — no single persisted "Payment" or "Transaction" table exists.

## Invoice — computed view of Sale, not a stored document

No stored invoice document beyond the `invoiceNo` string already on Sale. `viewInvoice()`/`printInvoice()` both read live from the Sale record at view/print time. **Confirmed: no immutability enforcement exists** — `editSale()`/`updateSale()` allow a full edit (items, discount, customer, date, payments) at any time, gated only by role, never by completion status or age. A vestigial `status` field is stamped `'Completed'` by legacy-data normalization code but is never read by any conditional anywhere in the file — it does not gate anything.

---

# Bounded Context: Shared Services (Desktop only — no server equivalent)

## Configuration (`DB.settings`)

- **Purpose**: Tenant/shop-level settings — branding, licensing cache, backup schedule, tax settings.
- **Scope**: Entirely tenant-level; **no per-user preference object exists**. The one setting that feels "personal" (`theme`) is actually stored raw in browser `localStorage`, bypassing `DB.settings` entirely and therefore not even properly scoped to the logged-in user or the shop — it's one value per installed browser/Electron instance, shared across every PIN login on that device.
- **Business invariants — corrected**: `taxRate`, `showGST`, and `receiptFooter` are defaulted by initialization code but **never read anywhere else in the file** — dead, unwired settings with no UI exposure at all. Do not assume these fields do anything.

## AuditLog (`DB.auditLog`) — desktop only, no server-side equivalent

- **Purpose**: Security/accountability trail of sensitive actions.
- **Business invariants**: FIFO-capped at 500 entries (`unshift` + `slice(0,500)` — drops oldest once exceeded). 14 distinct logged action types (see `BusinessRules.md` for the full list) — notably, plain sale/repair *creation*, expense add/delete, and login/logout are **not** logged; only edits/deletes/admin actions are.
- **Deletion rules**: Has its own "Clear Log" button that performs a full, destructive wipe (`DB.auditLog=[]`) — no soft-delete, no confirmation beyond the button click itself.
- **Relationship to the Dashboard's "Recent Activity" widget**: **These are two entirely separate, non-reconciled concepts.** The Dashboard widget never reads `DB.auditLog` — it independently reconstructs a feed from the last 3 Sales and last 2 Repairs by array position (not by date-sort) on every render.

## Notification — does not exist as a persisted entity

Only `toast()` (ephemeral, 3-second auto-dismissing DOM element) is actually used. A second function, `showSmartNotification()`, exists but is **never called anywhere in the codebase** — dead code from an unfinished feature. One native OS-level desktop notification fires after a successful auto-backup, but nothing about it is persisted or modeled as a business entity.

## Report — does not exist as a stored entity

Cashbook and Dashboard views are both computed fresh at render time from other entities (Sales, Repairs, Expenses, CashEntries) — there is no `DB.reports` array and no saved/scheduled report concept.

## Quotation — does not exist

No `DB.quotations`, no quotation-creation function, no quotation-to-sale conversion flow anywhere in the codebase, despite project commit-history mentioning it as a feature area. The closest analog is a plain `estimatedCost` number field on RepairJob, which is not a document of its own.
