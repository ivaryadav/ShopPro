# Entity Relationship Diagram — Identity & Tenant Core (MariaDB, Phase 2)

Scope: exactly the 6 tables `migrations/001_identity_tenant_core.sql` creates. See `docs/architecture/CanonicalDomainModel.md` and `docs/architecture/EntityRelationship.md` (Phase 1.5) for the full cross-product domain model this is a real, implemented subset of.

```mermaid
erDiagram
    TENANTS ||--o{ USERS : "employs"
    TENANTS ||--o{ USER_SESSIONS : "scopes (denormalized)"
    TENANTS ||--o{ TRUSTED_DEVICES : "scopes (denormalized)"
    USERS ||--o{ USER_SESSIONS : "logs in as"
    USERS ||--o{ TRUSTED_DEVICES : "trusts"
    USERS }o--|| ROLES : "has"
    ROLES ||--o{ ROLE_PERMISSIONS : "grants"
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : "granted via"

    TENANTS {
        bigint id PK
        varchar shop_name
        enum status "active, paused, terminated"
        varchar suspend_reason
        boolean is_active
        timestamp created_at
    }
    ROLES {
        int id PK
        varchar code UK "owner, staff (only)"
        varchar label
    }
    PERMISSIONS {
        int id PK
        varchar code UK "sessions:view, sessions:revoke, staff:add"
        varchar label
    }
    ROLE_PERMISSIONS {
        int role_id PK_FK
        int permission_id PK_FK
    }
    USERS {
        bigint id PK
        bigint tenant_id FK
        varchar username
        varchar display_name
        varchar mobile UK "globally unique, not just per-tenant"
        varchar email
        varchar password_hash "bcrypt, cost 10"
        int role_id FK
        boolean is_active
        timestamp last_login
        timestamp created_at
    }
    USER_SESSIONS {
        bigint id PK
        varchar session_id UK
        bigint tenant_id FK "NEW: real FK, local.js has none"
        bigint user_id FK "NEW: real FK, local.js has none"
        varchar jwt_id
        varchar device_id
        enum status "active, revoked, expired"
        varchar refresh_token_hash
        varchar prev_refresh_token_hash
        timestamp refresh_rotated_at
        timestamp last_activity
    }
    TRUSTED_DEVICES {
        bigint id PK
        bigint tenant_id FK
        bigint user_id FK
        varchar device_id
        boolean is_active "soft-remove only, never hard-deleted"
    }
```

## Deliberate deviations from `local.js`'s actual SQLite schema

1. **`users.role_id` (FK) replaces `users.role` (free TEXT)** — normalizes the existing 2-value enum (`owner`/`staff`) into a real reference table. No new role value is introduced; this cannot change who can log in as what.
2. **`user_sessions.tenant_id`/`user_id` gain real foreign keys.** `local.js`'s SQLite table declares none (confirmed in `docs/architecture/EntityRelationship.md`, Phase 1.5 — "enforced only in application logic"). A session row is never created for a nonexistent tenant/user in current logic, so this constraint only ever rejects states that were already unreachable — a hardening, not a behavior change.
3. **`roles`/`permissions`/`role_permissions` are new tables with no `local.js` equivalent at all** — see `docs/adr/0006-table-driven-authorization.md`.

## Deliberately excluded (out of scope, not an oversight)

`tenant_licenses`, `license_history`, `subscription_plans`, `admin_credentials`, `cloud_backups` — Licensing and Administration domains, explicitly out of scope for Phase 2 (`docs/database/MigrationNotes.md`). `tenants.license_key_hash`/`license_expiry`/`license_plan` — present on `local.js`'s `tenants` table today, but Licensing-domain data that happens to live there historically, not carried into this schema.

---

# Entity Relationship Diagram — Operations Domain (MariaDB, Phase 4)

Scope: the 10 tables `migrations/002_operations_domain.sql` creates, implementing `docs/database/OperationsSchemaDesign.md` (Phase 3, design) against real MariaDB per ADR-0008 (Hybrid Storage Strategy). Full narrative: `docs/architecture/Operations.md`.

```mermaid
erDiagram
    TENANTS ||--o{ INVENTORY_ITEMS : "stocks"
    TENANTS ||--o{ CUSTOMERS : "serves"
    TENANTS ||--o{ SALES : "records"
    TENANTS ||--o{ REPAIRS : "records"
    TENANTS ||--o{ EXPENSES : "records"
    TENANTS ||--o{ RECURRING_EXPENSES : "records"
    TENANTS ||--o{ STOCK_MOVEMENTS : "audits"
    TENANTS ||--o{ PAYMENTS : "records"
    TENANTS ||--|| TENANT_SETTINGS : "configures"
    CUSTOMERS ||--o{ SALES : "buys"
    CUSTOMERS ||--o{ REPAIRS : "brings in"
    SALES ||--o{ SALE_ITEMS : "line items"
    REPAIRS ||--o{ REPAIR_PARTS : "consumes"
    INVENTORY_ITEMS |o--o{ SALE_ITEMS : "sold as (nullable — ON DELETE SET NULL)"
    INVENTORY_ITEMS |o--o{ REPAIR_PARTS : "used as (nullable — ON DELETE SET NULL)"
    INVENTORY_ITEMS |o--o{ STOCK_MOVEMENTS : "moves (nullable — ON DELETE SET NULL)"
    SALES ||--o{ PAYMENTS : "collects (source_type='sale')"
    REPAIRS ||--o{ PAYMENTS : "collects (source_type='repair')"

    INVENTORY_ITEMS {
        bigint id PK
        bigint tenant_id FK
        varchar name
        varchar category "free text, no Category entity"
        varchar sku "NOT unique — local.js never enforced this"
        varchar imei UK "tenant-scoped unique"
        decimal cost_price
        decimal sell_price
        int stock
        int min_stock
        varchar unit
    }
    CUSTOMERS {
        bigint id PK
        bigint tenant_id FK
        varchar name
        varchar phone "NOT unique — real, preserved inconsistency"
        varchar email
        enum type "Regular, VIP, Wholesale, Shopkeeper"
    }
    SALES {
        bigint id PK
        bigint tenant_id FK
        varchar invoice_no UK "self-healing INV-NNN"
        bigint customer_id FK
        decimal subtotal
        decimal discount
        decimal total
        date sale_date
        bigint created_by FK "nullable, ON DELETE SET NULL"
    }
    SALE_ITEMS {
        bigint id PK
        bigint sale_id FK
        bigint product_id FK "nullable — survives product deletion"
        varchar product_name "denormalized snapshot"
        decimal price "denormalized snapshot, editable per line"
        int qty
    }
    REPAIRS {
        bigint id PK
        bigint tenant_id FK
        varchar job_no UK "self-healing JOB-NNN"
        bigint customer_id FK
        enum status "Received, Diagnosing, Repairing, Ready, Delivered — free transitions"
        decimal estimated_cost
        decimal final_cost "always parts + labour"
        decimal labour_charge
        int warranty_days
        bigint created_by FK "nullable, ON DELETE SET NULL"
    }
    REPAIR_PARTS {
        bigint id PK
        bigint repair_id FK
        bigint product_id FK "nullable — survives product deletion"
        varchar product_name "denormalized snapshot"
        decimal price
        int qty
    }
    EXPENSES {
        bigint id PK
        bigint tenant_id FK
        varchar title
        varchar category
        decimal amount
        date expense_date
    }
    RECURRING_EXPENSES {
        bigint id PK
        bigint tenant_id FK
        varchar title
        decimal amount
        boolean is_active
        varchar last_applied "'YYYY-MM', manual-trigger only, no scheduler"
    }
    STOCK_MOVEMENTS {
        bigint id PK
        bigint tenant_id FK
        bigint product_id FK "nullable"
        int delta "positive=in, negative=out"
        enum reason "sale, sale_edit_restore, repair_parts, repair_delete_restore, manual_adjust, product_delete_restore"
        varchar reference_type
        bigint reference_id
    }
    PAYMENTS {
        bigint id PK
        bigint tenant_id FK
        enum source_type "sale, repair, manual"
        bigint source_id "nullable for manual"
        enum direction "in, out"
        enum method "Cash, UPI, Card, Bank Transfer — union of both contexts, restriction enforced in service layer"
        decimal amount
        date payment_date
    }
    TENANT_SETTINGS {
        bigint tenant_id PK_FK
        json settings_json "Configuration — kept as JSON, ADR-0008"
    }
```

## Deliberate deviations from the Phase 3 design doc (`OperationsSchemaDesign.md`)

1. **No `inventory_items.is_deleted`** — the design doc proposed soft-delete but explicitly flagged it as "not decided unilaterally." Never approved, so this migration reproduces `local.js`'s actual hard-delete behavior instead. To make that compatible with real FK constraints, `sale_items.product_id`/`repair_parts.product_id`/`stock_movements.product_id` are nullable with `ON DELETE SET NULL` (not `RESTRICT`, which would forbid a delete `local.js` allows, and not `CASCADE`, which would destroy sales/repair history).
2. **`created_by` columns are nullable `ON DELETE SET NULL` FKs to `users(id)`** — `local.js` only ever stored a free-text name; a real FK is new structure, not a behavior change, so it must tolerate the referenced user later being removed.

## Deliberately excluded (out of scope, not an oversight)

An `invoices` table (no current behavior justifies one, per `OperationsDomainAnalysis.md`), `repairs.technician_id`, a `purchases`/`purchase_items` pair, and a scheduler-driven `recurring_expenses` — all explicitly forbidden by the Phase 4 mission.

---

# Entity Relationship Diagram — Licensing Domain (MariaDB, RC1 Sprint 1)

Scope: the 3 tables `migrations/003_licensing_domain.sql` creates. Full narrative: `docs/architecture/Licensing.md`.

```mermaid
erDiagram
    TENANTS ||--|| TENANT_LICENSES : "has exactly one"
    TENANTS ||--o{ LICENSE_HISTORY : "audits"
    SUBSCRIPTION_PLANS ||--o{ TENANT_LICENSES : "assigned via plan_code"

    SUBSCRIPTION_PLANS {
        int id PK
        varchar code UK "TRIAL, BASIC, PREMIUM"
        varchar label
        int device_limit
        int trial_days "14 for TRIAL, NULL otherwise"
        boolean is_active
        int sort_order
    }
    TENANT_LICENSES {
        bigint id PK
        bigint tenant_id FK UK "one row per tenant"
        enum status "PENDING_APPROVAL, ACTIVE, READ_ONLY, SUSPENDED, ARCHIVED"
        varchar plan_code FK
        varchar requested_plan_code
        varchar billing_cycle "trial, monthly, halfyearly, yearly, lifetime"
        int device_limit
        varchar license_key UK "nullable, SHOP-XXXX-XXXX-XXXX"
        json requested_modules "capture-only, never enforced"
        timestamp starts_at
        timestamp expires_at "NULL = never (lifetime)"
        timestamp read_only_since "drives 30-day READ_ONLY->SUSPENDED timer"
        timestamp suspended_since "drives 365-day SUSPENDED->ARCHIVED timer"
        timestamp last_verified_at "offline-grace anchor"
        int offline_grace_days
    }
    LICENSE_HISTORY {
        bigint id PK
        bigint tenant_id FK
        varchar event_type "free text, matches local.js exactly"
        varchar from_status
        varchar to_status
        varchar detail
        varchar actor "system or admin"
    }
```

## Deliberate deviations from `local.js`'s actual SQLite schema

1. **TEXT timestamp columns become proper `TIMESTAMP`/`DATE` types** — matches this project's established MariaDB convention (migrations 001/002), a structural type change only.
2. **`tenants.license_key_hash`/`license_expiry`/`license_plan` (legacy, pre-`tenant_licenses` columns) are NOT added to `server/src/`'s `tenants` table** — that table is owned by migrations/001 (Phase 2), out of scope for this sprint to modify. See `docs/architecture/Licensing.md`'s "Documented deviations" #1 for the full consequence (a narrower `GET /api/license/status` response).

## Deliberately excluded (out of scope, not an oversight)

`trusted_devices` (already exists, migrations/001, Authentication domain — untouched by this sprint), `admin_credentials` (Administration domain), any Operations/Cloud-Backup table.
