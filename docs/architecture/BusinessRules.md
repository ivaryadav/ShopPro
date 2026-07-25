# Business Rules

Every rule below is extracted from the actual implementation, with a file/function reference. Where the originating mission's example rules turned out not to match the code, that's called out explicitly under **Corrections** — these are not edits to the business, they're corrections to what this document claims the business does, so future phases don't build against a wrong assumption.

## Corrections to the originally-assumed rules

| Assumed rule | Actual finding |
|---|---|
| "Purchases increase stock." | **No Purchase entity exists.** Stock only increases via a manual "Adjust Stock" action (`doAdjustStock`, action `'add'`), with zero connection to any expense/cost record. There is no atomic purchase-transaction that both records cost and increments stock. |
| "Invoices are immutable after completion." | **False.** A Sale (the closest thing to an invoice) can be fully edited — items, discount, customer, date, payments — at any time via `updateSale()`, gated only by role (`owner`/`superadmin`/`manager`), never by a completion or age check. A vestigial `status` field is stamped `'Completed'` by legacy-data migration code but is never read by any conditional anywhere in the codebase — it enforces nothing. |
| "Audit logs are append-only." | **Mostly true, with one real exception.** Server-side `license_history` is genuinely append-only — no update/delete statement against it exists anywhere. Desktop `DB.auditLog` is append-only in normal operation (`unshift` + 500-cap truncation of the oldest entries) **but has a "Clear Log" button that performs a full, one-click destructive wipe** — so "append-only" is the default behavior, not an enforced invariant. |

## Confirmed rules (matched the original assumption)

- **Tenant owns all business data.** True for everything currently modeled server-side (User, Session, TrustedDevice, TenantLicense, LicenseHistory all FK to `tenant_id`). For the desktop/operational domain (Inventory, Sales, Repairs, etc.), "ownership" today just means "lives in the one JSON blob for that install" — there is no per-record tenant tag because there's only ever one tenant's data in a given desktop install or hosted `tenant_data` row.
- **Users never cross tenants.** Confirmed — every regular (non-admin) endpoint sources `tenant_id` exclusively from the verified JWT payload, never from client-supplied input (`docs/independent-audit/APIAudit.md` — no IDOR path found in a full independent review).
- **Licenses belong to tenants.** Confirmed — `tenant_licenses.tenant_id` is `NOT NULL UNIQUE`, a true 1-to-1.
- **Sessions belong to users.** Confirmed — though note this relationship is enforced only in application logic, not by a SQL foreign key (`user_sessions` declares no `FOREIGN KEY` constraint on `user_id`).
- **Repairs belong to customers.** Confirmed — `RepairJob.customerId` is a required field, validated at save time.
- **Sales reduce stock.** Confirmed, precisely: on sale creation, `saleItems.forEach(item => { inventory[item.productId].stock -= item.qty })`; on sale edit, original quantities are restored first, then the new quantities are deducted (a correct delta pattern, not a naive re-deduction). Stock sufficiency is hard-validated *before* a sale is allowed to save — this is enforced, not just a nice-to-have.
- **Desktop mode is offline-only.** Confirmed by architecture — no server call exists in the offline-desktop code path; license validation is entirely client-side crypto (`docs/adr/0003-desktop-offline-architecture.md`).
- **Cloud mode is multi-tenant.** Confirmed — every table in `server/local.js`'s schema is tenant-scoped.

## Additional rules found, not in the originating mission's example list

### Identity & Access
- A tenant can never end up with zero active owners: deactivating the *last* remaining active `'owner'` user for a tenant is explicitly blocked (`local.js:1357-1360`).
- Login failure is always the identical generic message regardless of whether the mobile number exists at all or exists but the PIN was wrong — a deliberate, enforced anti-enumeration rule (`docs/independent-audit/IndependentSecurityReview.md` §4), not merely a UX choice.
- A device is auto-trusted on first login *only* while under the tenant's plan device limit; over the limit, login itself is rejected (403) before any session is created — the device limit is enforced at the point of authentication, not after the fact.
- Desktop-side, the `'technician'` role is cosmetic only — every actual permission gate that includes `'staff'` also applies identically to `'technician'`; no code path distinguishes them.
- Desktop-side, `'superadmin'` cannot be legitimately assigned to a persisted user — any user record imported with that role is automatically downgraded to `'owner'` by the import-sanitization code, and the `_superAdmin` settings flag is stripped from any imported settings blob.

### Licensing
- License status transitions are time-based and automatic, not just event-based: `ACTIVE → READ_ONLY` the instant `expires_at` passes; `READ_ONLY → SUSPENDED` exactly 30 days later; `SUSPENDED → ARCHIVED` exactly 365 days after that (`local.js`'s sweep function, re-run on a configurable interval, default 15 minutes).
- Moving a tenant to `SUSPENDED` (whether by the sweep or by manual admin action) always also revokes every active session for that tenant in the same operation — a licensing state change has an immediate, forced-logout side effect.
- Approving a new self-service registration requires `email_verified_at` to already be set — an unverified registration cannot be approved, full stop.
- `READ_ONLY` status permits reads but blocks writes; `SUSPENDED`/`ARCHIVED`/`PENDING_APPROVAL` block both reads and writes — a graduated, not binary, lockout.
- The legacy `tenants.status` column and the authoritative `tenant_licenses.status` column are now kept in permanent sync by every write path that touches either (`docs/independent-audit/FinalBlockerResolution.md`) — this was not always true and was a Critical-severity gap until fixed.

### Inventory & Sales
- `sellPrice` can never be saved lower than `costPrice` — enforced at both create and edit time.
- IMEI, when present on an InventoryItem, must be exactly 15 digits and must be unique across all inventory items — both enforced. SKU, despite looking like a similar identifier, has **no** uniqueness enforcement at all.
- A sale cannot be saved if any line item's quantity exceeds that product's current stock — blocked outright, with every offending line named in the error, not just the first one found.
- Deleting a RepairJob or a product line within it restores the consumed parts' quantity back to inventory — the inverse of the sale-time deduction.
- Deleting an InventoryItem is the **only** hard-delete a normal (non-admin) user can trigger anywhere in the entire domain.

### Customers
- A duplicate customer phone number triggers a confirm-to-override warning, and then — inconsistently — a second check still hard-blocks the save if the user proceeds past that warning. This is documented as a real inconsistency in the current implementation, not a deliberate two-stage design.
- Customer "balance," "loyalty points," and "total purchase" fields exist in the data shape but are never written to by any live code path — there is no active loyalty or credit system today, regardless of what the field names imply.

### Finance
- A recurring expense is only ever converted into an actual expense entry when a human clicks "Apply This Month" — there is no automatic, scheduled, or boot-time generation. A month with no click gets no expense entry for that recurring item.
- Payment method options are inconsistent between contexts: Sale/Repair payment collection offers Cash/UPI/Card only; the separate manual Cashbook entry form additionally offers Bank Transfer.

### Deletion (cross-cutting)
- **Customer data is never deleted**, as a cross-cutting principle — confirmed true for every entity except: (a) `InventoryItem`, which a user can hard-delete directly, and (b) `CloudBackup` (server-side, legacy, admin-only, not customer business data), the only hard `DELETE FROM` in the entire server codebase. Tenants, Users, Sessions (until past their retention window), Licenses, License History, Sales, Repairs, Expenses, and Customers are never hard-deleted by any code path found.

### Audit & Accountability
- Not everything is audited equally: Sale *edits* are logged, Sale *creation* is not; Expense add/delete is not logged at all; RepairJob status changes, updates, and deletion are all logged (more thoroughly covered than Sales). This unevenness is a real, current characteristic of the system, not an oversight this document is fixing.
- Two entirely separate "activity" feeds exist side by side and are never reconciled: the persisted, security-oriented `DB.auditLog` (Settings tab) and the ephemeral, business-glance "Recent Activity" dashboard widget (which independently re-derives its feed from the last few Sales/Repairs on every render, never reading the audit log at all).
