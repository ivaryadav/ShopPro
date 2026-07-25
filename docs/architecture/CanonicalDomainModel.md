# Canonical Domain Model — ShopERP Pro

**This document is the single source of truth for ShopERP's business domain, from this point forward.** Per `docs/adr/0001-enterprise-reconstruction.md`'s governing principle:

```
Business Rules → Domain Model → Database → Services → Repositories → Controllers → Routes
```

Every future phase of the v2.0 reconstruction designs its database schema, services, and API contracts *from* this model — not the other way around. If a future phase discovers this model is wrong or incomplete, this document is corrected first, and the implementation follows the correction, not the reverse.

## How this was produced

Extracted directly from the live implementation — `server/local.js` (read directly, current schema), `app/ShopERP_Pro_v8.html` (researched via three independent, targeted code-reading passes covering inventory/sales/purchases, repairs/customers/roles, and expenses/invoices/settings/audit-log respectively), and the project's existing architecture docs (`docs/architecture-review/`, `docs/independent-audit/`) as secondary cross-reference. **No behavior was redesigned and no rule was invented** — every entity, field, relationship, and rule below is backed by a specific function name and line reference in the actual code, verified during this phase. Where the code does something different from what a reasonable ERP might be expected to do (e.g., no Purchase entity exists at all), that reality is documented as-is, not idealized.

Companion documents:
- **`DomainModel.md`** — full per-entity detail (purpose, lifecycle, fields, invariants, deletion rules, security, audit, extension points).
- **`EntityRelationship.md`** — relationship table, ER diagram, bounded-context diagrams, module dependency diagram.
- **`BusinessRules.md`** — every business rule extracted from the code, with corrections to any rule the original mission assumed that the code doesn't actually enforce.
- **`LifecycleDiagrams.md`** — state-machine diagrams for every entity that has a real lifecycle.

## Two products, one domain vocabulary

ShopERP Pro is **one business domain expressed through two deployment shapes** (`docs/adr/0003-desktop-offline-architecture.md`):

- **Offline Desktop** — `app/ShopERP_Pro_v8.html` running under Electron, one shop, one machine, data in `localStorage`, no server. This is where almost the entire operational domain lives today (Inventory, Sales, Repairs, Customers, Expenses, Settings, Audit Log) — there is currently **no server-side equivalent** of any of these; they exist only client-side.
- **Web-Hosted (SaaS)** — `server/local.js`, multi-tenant, MariaDB-bound from Phase 2 onward (`docs/adr/0002-mariadb-canonical-database.md`). This is where the entire Identity & Licensing domain lives today (Tenant, User-as-account, Session, TrustedDevice, SubscriptionPlan, TenantLicense, LicenseHistory) — the operational domain (Inventory/Sales/etc.) does **not** yet exist server-side at all; a hosted tenant's business data is currently stored as one opaque JSON blob (`tenant_data.data`) that the server never looks inside.

This split is itself the most important fact in this whole document: **the "Identity & Licensing" bounded context and the "Operations" bounded context are implemented on entirely different sides of the client/server boundary today**, and they do not yet share a canonical entity model — this document is what makes that possible for the first time.

## Bounded contexts

| Context | Owns | Currently implemented in |
|---|---|---|
| **Identity** | Tenant, User (account), Role, Session, TrustedDevice | `server/local.js` (SQLite today, MariaDB from Phase 2) |
| **Licensing** | SubscriptionPlan, TenantLicense, LicenseHistory, Registration, EmailVerification | `server/local.js` |
| **Tenant Management** | Tenant-as-business (shop profile, address, GST), Configuration/Settings | Split: Tenant identity in `server/local.js`; shop-profile *settings* only in `app/ShopERP_Pro_v8.html`'s `DB.settings` (server has no equivalent settings store) |
| **Inventory** | InventoryItem | `app/ShopERP_Pro_v8.html` only |
| **Sales** | Sale, SaleItem | `app/ShopERP_Pro_v8.html` only |
| **Repairs** | RepairJob, Customer | `app/ShopERP_Pro_v8.html` only |
| **Purchasing** | *(does not exist — see Technical Debt)* | — |
| **Finance** | Expense, RecurringExpense, Payment (value object), CashEntry, Invoice (computed view) | `app/ShopERP_Pro_v8.html` only |
| **Reporting** | Computed views only (Cashbook, Dashboard "Recent Activity") — no stored Report entity | `app/ShopERP_Pro_v8.html` only |
| **Administration** | AdminCredentials, CloudBackup (legacy), User/Role/Permission (desktop-local) | Split across both |
| **Shared Services** | AuditLog (`DB.auditLog`) | `app/ShopERP_Pro_v8.html` only — no server-side equivalent |

Full interaction diagrams: `EntityRelationship.md`.

## Entity inventory

Every entity the originating mission asked about, and its actual status in the live code:

| Entity | Real, distinct entity? | Where | Notes |
|---|---|---|---|
| Tenant | **Yes** | Server | `tenants` table |
| User | **Yes** — two independent implementations | Server + Desktop | Server: `users` table (bcrypt). Desktop: `DB.users[]` (client-side SHA-256, different hashing scheme entirely) |
| Role | **Yes**, as a string field only | Server + Desktop | No separate Role table on either side — see Permission below |
| Permission | **No** | — | Hardcoded role-string arrays scattered through code (`_requireRole([...])` client-side; `if (req.user.role !== 'owner')` server-side) — no permission-object model anywhere |
| Session | **Yes** | Server | `user_sessions` table |
| TrustedDevice | **Yes** | Server | `trusted_devices` table |
| SubscriptionPlan | **Yes** | Server | `subscription_plans` table |
| TenantLicense | **Yes** | Server | `tenant_licenses` table — the authoritative status source (`docs/independent-audit/FinalBlockerResolution.md`) |
| LicenseHistory | **Yes** | Server | `license_history` table |
| Registration | **Process, not a table** | Server | = a `tenant_licenses` row with `status='PENDING_APPROVAL'` + a `license_history` `'REGISTERED'` event; no dedicated `registrations` table |
| EmailVerification | **Process, not a table** | Server | = `users.email_verify_token_hash`/`email_verify_expires`/`email_verified_at` columns; no dedicated table |
| AuditLog | **Yes, desktop only; no server equivalent** | Desktop | `DB.auditLog[]`, 500-entry FIFO cap, 14 distinct logged actions |
| InventoryItem | **Yes** | Desktop only | `DB.inventory[]` |
| Category | **No** — free-text field | Desktop | Fixed 5-value dropdown on InventoryItem; no master list |
| Brand | **No** — orphaned | Desktop | Only in unused demo seed data; no live create/edit path reads or writes it |
| Supplier | **No** | — | Doesn't exist in any form except a free-text `vendor` string on Expense/RecurringExpense |
| Customer | **Yes** | Desktop only | `DB.customers[]` |
| Purchase | **No — does not exist at all** | — | No `DB.purchases`, no add/save function. Restocking is two disconnected manual steps (an Expense entry + a separate stock adjustment) with no link between them |
| PurchaseItem | **No** | — | Doesn't exist since Purchase doesn't exist |
| Sale | **Yes** | Desktop only | `DB.sales[]` — has no `status` field despite a vestigial, unread one stamped by normalization code |
| SaleItem | **Yes, nested** | Desktop only | `sale.items[]`, not a top-level entity |
| RepairJob | **Yes** | Desktop only | `DB.repairs[]` — real lifecycle is `Received → Diagnosing → Repairing → Ready → Delivered`, not the 7-state list the originating mission assumed |
| Expense | **Yes** | Desktop only | `DB.expenses[]` |
| Payment | **No — value object, not an entity** | Desktop only | Embedded `payments[]` array on Sale/RepairJob, plus a separate, unrelated `DB.cashEntries[]` manual ledger |
| Invoice | **No — computed view of Sale** | Desktop only | No stored invoice document beyond the `invoiceNo` string on Sale; generated on demand for viewing/printing. **Not immutable** — a sale can be edited at any time regardless of age or payment status |
| StockMovement | **No** | — | `InventoryItem.stock` is mutated in place; only manual adjustments get an unstructured text line in `DB.auditLog` (and even that discards the user's entered reason) |
| Notification | **No — ephemeral only** | Desktop only | Transient `toast()` UI only, plus one dead, never-called `showSmartNotification()` stub |
| Configuration | **Yes** | Desktop only | `DB.settings` — tenant-level only, no per-user preferences; several fields confirmed dead (`theme`, `taxRate`, `showGST`, `receiptFooter`) |
| Report | **No — computed, not stored** | Desktop only | Cashbook and Dashboard views are assembled live from other entities at render time |
| Activity | **Yes, but two unrelated concepts share the name** | Desktop only | `DB.auditLog` (persisted, security-oriented) vs. Dashboard "Recent Activity" (ephemeral, last-N-array-items, never reads the audit log) |
| Quotation | **No — does not exist** | — | No `DB.quotations`, no quotation-to-sale conversion flow |
| AdminCredentials | **Yes (not in the original list — real, found)** | Server | `admin_credentials` table — the single shared Super Admin operator identity |
| CloudBackup | **Yes (not in the original list — real, found, legacy)** | Server | `cloud_backups` table — a legacy offline-desktop-to-cloud backup bridge, self-documented in its own code as needing a per-tenant token model |
| RecurringExpense | **Yes (not in the original list — real, found)** | Desktop only | `DB.recurringExpenses[]` — distinct from Expense, generation is 100% manually triggered, no scheduler |

**14 of the 31 entities the originating mission expected either don't exist as distinct concepts (Category, Brand, Supplier, Purchase, PurchaseItem, StockMovement, Notification, Quotation, Permission, Report, Invoice-as-document, Payment-as-entity) or exist only as a process embedded in other entities' fields (Registration, EmailVerification).** This is reported honestly per the mission's own instruction ("never invent rules — extract them from the existing implementation") rather than papered over.

## Canonical vocabulary

One name per concept, from this document forward:

| Use this term | Not this | Why |
|---|---|---|
| **Tenant** | Shop, Store, Business, Client-as-account | Matches the actual table/column names (`tenants`, `tenant_id`) used pervasively server-side and in every existing ADR/audit doc. "Shop" remains the correct *customer-facing UI label* (e.g. "Shop Name" in Settings) — both are correct, at different layers: Tenant is the domain/architecture term, Shop is its presentation-layer name. |
| **Customer** | Client | The code itself only ever uses `Customer`/`customers` — there is no competing "Client" terminology anywhere in the codebase to reconcile. |
| **License** (the tenant's specific subscription instance) / **Subscription Plan** (the tier definition) | Subscription (for the instance) | Matches `tenant_licenses` (instance) vs. `subscription_plans` (tier) table names exactly — "License" and "Plan" are two different, related things, not synonyms. |
| **User** | Staff, Employee | `users`/`DB.users` is the actual table/array name on both sides. "Staff" is one specific **Role value** a User can hold (alongside `owner`, `manager`, `technician`), not a separate entity — see `DomainModel.md`'s User entry. |
| **RepairJob** | Repair, Job, Ticket | The code's own function/variable names (`saveJob`, `jobNo`, `DB.repairs`) mix "Job" and "Repair" — this document standardizes on **RepairJob** as the entity name, matching the mission's own naming, while noting the code says "Job" (`jobNo`, not `repairNo`). |

## Technical debt this extraction surfaced (documented only — not fixed in this phase)

1. **Purchasing has no domain model at all.** Restocking inventory and recording its cost are two manually-linked, unconnected actions today. Any future Purchasing bounded context is new design work, not a port of existing behavior — flag this explicitly to whoever designs Phase 3+'s inventory/purchasing schema.
2. **Two independent User/Role implementations that don't share a session, a password scheme, or even the same role vocabulary details** (desktop: `owner/manager/staff/technician/superadmin`, uneven permission granularity; server: `owner/staff` only, plus a wholly separate shared Super Admin operator identity). Unifying these is a real design decision for a future phase, not assumed by this document.
3. **No StockMovement audit trail** — inventory quantity changes from sales are entirely untracked beyond the sale record itself; manual adjustments get a text log that discards the user's own stated reason.
4. **Sales/Invoices have no immutability or void/cancel/return lifecycle** despite the mission's assumption that "Invoices are immutable after completion" — corrected in `BusinessRules.md`.
5. **Duplicate/dead fields from stale demo seed data** (`brand`, `barcode` on InventoryItem; `paidTo`/`paymentMode` on Expense; `balance`/`loyaltyPoints`/`totalPurchase` on Customer) that the real create/edit code never touches — a future migration must not accidentally treat these as real, populated fields.
6. **Two unrelated "Activity" concepts sharing conceptual space** (persisted `AuditLog` vs. ephemeral Dashboard feed) with no reconciliation.
7. **`RecurringExpense` generation requires a manual button click every month** — there is no scheduler; a shop owner who forgets simply never gets that month's recurring expense recorded.
8. **No server-side equivalent of the entire Operations domain** (Inventory/Sales/Repairs/Customers/Expenses/Settings/AuditLog) — a hosted tenant's business data is one opaque JSON blob server-side today. This is the single largest gap between "what exists" and "what a MariaDB-backed, layered Phase 3 needs to model" (`docs/adr/0002-mariadb-canonical-database.md`, and the open ADR question flagged in `server/src/routes/tenants/README.md`).

## What this document does not do

It does not decide whether the JSON-blob tenant-data model should be normalized into relational tables (that's an explicit, separate decision for whichever future phase builds the Tenant/Operations domain against MariaDB — see `server/src/routes/tenants/README.md`'s note). It does not fix any of the technical debt above. It does not change a single line of `server/local.js`, `server/index.js`, or `app/ShopERP_Pro_v8.html` — verified: zero diff against both files as of this phase's completion.
