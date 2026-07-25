# Entity Relationships & Diagrams

Companion to `DomainModel.md`. Every diagram below reflects the actual current implementation (verified against code), not an idealized future design.

## Relationship table — every real relationship in the domain

| From | To | Cardinality | Ownership | Cascade | Reference integrity | Business meaning |
|---|---|---|---|---|---|---|
| Tenant | User | 1-to-many | Tenant owns User | `ON DELETE CASCADE` (never triggered — Tenant never deleted) | FK enforced (`foreign_keys=ON`) | A shop's staff and owner accounts |
| Tenant | TenantLicense | 1-to-1 | Tenant owns License | `ON DELETE CASCADE` | FK + `UNIQUE(tenant_id)` | A shop's subscription |
| Tenant | tenant_data | 1-to-1 | Tenant owns its data blob | `ON DELETE CASCADE` | FK, `tenant_id` is the PK | A shop's opaque business-data JSON (today) |
| Tenant | LicenseHistory | 1-to-many | Tenant owns its history | `ON DELETE CASCADE` | FK | Audit trail of licensing events |
| TenantLicense | SubscriptionPlan | many-to-1 | Plan is shared/global, not owned by any tenant | N/A (no cascade — plans aren't deleted) | FK (`plan_code REFERENCES subscription_plans(code)`) | Which tier a tenant is on |
| User | Session | 1-to-many | User owns Session | No FK-level cascade declared (`user_sessions` has no `FOREIGN KEY` constraint at all — enforced only in application logic) | **Not DB-enforced** | A user's active logins |
| User | TrustedDevice | 1-to-many | User owns TrustedDevice | `ON DELETE CASCADE` | FK | Devices a user has logged in from |
| Tenant | TrustedDevice | 1-to-many (denormalized) | — | `ON DELETE CASCADE` | FK | Fast tenant-scoped device queries without a User join |
| InventoryItem | SaleItem | 1-to-many (referenced by ID, not owned) | InventoryItem is independent; SaleItem references it | No cascade — Sale/SaleItem survive even if the InventoryItem is later deleted, since `productId`/`name`/`price` are snapshotted, not joined live | **Not DB-enforced** (no real database yet — this is a JS array relationship) | What was sold, at what price, at time of sale |
| InventoryItem | RepairJob (`partsUsed[]`) | many-to-many (via nested array, referenced by ID) | InventoryItem independent | Deleting a RepairJob restores parts-used quantity to InventoryItem.stock (application-level "cascade", not DB-level) | Not DB-enforced | Parts consumed by a repair |
| Customer | Sale | 1-to-many (referenced, not owned) | Customer independent | None — Sale keeps `customerName` even if Customer is later edited/deleted | Not DB-enforced | Who bought |
| Customer | RepairJob | 1-to-many (referenced) | Customer independent | Same as above | Not DB-enforced | Whose device |
| Sale | SaleItem | 1-to-many, **nested/embedded** | Sale fully owns its items (not a separate table/array at all) | Deleting a Sale would delete its items with it (though no delete function for Sale exists at all) | N/A — it's a JS object property, not a relational join | Line items of one transaction |
| RepairJob | Payment (value object) | 1-to-many, embedded `payments[]` | RepairJob owns its payment records | Embedded — no independent lifecycle | N/A | Partial/split payment collection |
| Sale | Payment (value object) | 1-to-many, embedded `payments[]` | Sale owns its payment records | Embedded | N/A | Partial/split payment collection |
| RecurringExpense | Expense | 1-to-many (generates, doesn't own) | Independent — generated Expense rows have no back-reference to the RecurringExpense that created them | None — no FK of any kind, not even an in-memory ID reference | **Not tracked at all** | "This month's rent" auto-entry |
| (nothing) | Purchase | — | — | — | — | **Does not exist — no relationship to document** |
| (nothing) | StockMovement | — | — | — | — | **Does not exist — InventoryItem.stock is mutated with no linked movement record** |

**The starkest pattern in this table**: every relationship in the **server** domain (top 6 rows) is a real, enforced SQL foreign key with `ON DELETE CASCADE` semantics. Every relationship in the **desktop/operations** domain (remaining rows) is an in-memory JavaScript array/object reference with zero database-level enforcement — because there is no database there at all yet. This is the single most important input for whichever future phase designs the Operations domain's MariaDB schema: it must decide, for the first time, what SQL-level referential integrity these relationships should actually have (e.g., should deleting an InventoryItem that has historical SaleItem references be blocked, restricted, or allowed with snapshot preservation, as today?).

## Entity Relationship Diagram — Server (Identity & Licensing)

```mermaid
erDiagram
    TENANT ||--o{ USER : "employs"
    TENANT ||--|| TENANT_LICENSE : "subscribes via"
    TENANT ||--|| TENANT_DATA : "owns (opaque JSON today)"
    TENANT ||--o{ LICENSE_HISTORY : "has events"
    TENANT_LICENSE }o--|| SUBSCRIPTION_PLAN : "is tier of"
    USER ||--o{ SESSION : "logs in as"
    USER ||--o{ TRUSTED_DEVICE : "trusts"
    TENANT ||--o{ TRUSTED_DEVICE : "scopes (denormalized)"

    TENANT {
        int id PK
        string shop_name
        string status "legacy"
        string license_key_hash
    }
    USER {
        int id PK
        int tenant_id FK
        string username
        string password_hash "bcrypt"
        string role "owner or staff only"
        string email_verify_token_hash
    }
    TENANT_LICENSE {
        int id PK
        int tenant_id FK "UNIQUE"
        string status "authoritative source of truth"
        string plan_code FK
        string license_key
        string expires_at
    }
    SUBSCRIPTION_PLAN {
        string code PK
        int device_limit
        int trial_days
    }
    LICENSE_HISTORY {
        int id PK
        int tenant_id FK
        string event_type
        string actor "system or admin only"
    }
    SESSION {
        int id PK
        string session_id UK
        int tenant_id FK
        int user_id "no DB FK constraint"
    }
    TRUSTED_DEVICE {
        int id PK
        int tenant_id FK
        int user_id FK
        string device_id
    }
```

## Entity Relationship Diagram — Desktop (Operations, no real database)

```mermaid
erDiagram
    CUSTOMER ||--o{ SALE : "buys (referenced by ID)"
    CUSTOMER ||--o{ REPAIR_JOB : "owns device in (referenced by ID)"
    SALE ||--|{ SALE_ITEM : "contains (nested, not a table)"
    SALE_ITEM }o--|| INVENTORY_ITEM : "snapshots price/name from"
    REPAIR_JOB }o--o{ INVENTORY_ITEM : "consumes parts from (nested partsUsed[])"
    RECURRING_EXPENSE ..> EXPENSE : "generates (no stored link)"

    CUSTOMER {
        int id PK
        string name
        string phone "soft-unique"
        string balance "dead field, never mutated"
    }
    SALE {
        int id PK
        string invoiceNo UK
        int customerId "no DB FK - JS reference only"
        array items "nested SaleItem[]"
        string status "does not exist - vestigial only"
    }
    SALE_ITEM {
        int productId "no DB FK - JS reference only"
        string name "denormalized snapshot"
        float price "denormalized snapshot, editable"
        int qty
    }
    REPAIR_JOB {
        int id PK
        string jobNo UK
        int customerId "no DB FK"
        string status "Received..Delivered, 5 states"
        array partsUsed "nested, references InventoryItem"
    }
    INVENTORY_ITEM {
        int id PK
        string sku "NOT actually unique"
        string imei "unique if present"
        int stock
    }
    EXPENSE {
        int id PK
        string category
        float amount
    }
    RECURRING_EXPENSE {
        int id PK
        string lastApplied "YYYY-MM stamp"
    }
```

Note: `PURCHASE`, `PURCHASE_ITEM`, `STOCK_MOVEMENT`, `CATEGORY`, `BRAND`, `SUPPLIER`, `QUOTATION`, `NOTIFICATION`, `REPORT` are intentionally absent from this diagram — they do not exist as entities (`DomainModel.md`).

## Bounded Context Diagram

```mermaid
flowchart TB
    subgraph Server["Web-Hosted Server (server/local.js, SQLite today -> MariaDB per ADR-0002)"]
        Identity["Identity Context<br/>Tenant, User, Role, Session, TrustedDevice"]
        Licensing["Licensing Context<br/>SubscriptionPlan, TenantLicense, LicenseHistory,<br/>Registration, EmailVerification"]
        Admin["Administration Context<br/>AdminCredentials, CloudBackup (legacy)"]
    end

    subgraph Desktop["Offline Desktop / Same-UI-in-Web (app/ShopERP_Pro_v8.html)"]
        DesktopIdentity["Desktop Identity Context<br/>User, Role, SuperAdmin flag<br/>(INDEPENDENT of Server Identity)"]
        Inventory["Inventory Context<br/>InventoryItem"]
        Sales["Sales Context<br/>Sale, SaleItem"]
        Repairs["Repairs Context<br/>RepairJob, Customer"]
        Finance["Finance Context<br/>Expense, RecurringExpense,<br/>Payment (value object), CashEntry, Invoice (view)"]
        Shared["Shared Services Context<br/>AuditLog, Configuration"]
        Purchasing["Purchasing Context<br/>DOES NOT EXIST"]
    end

    Identity -->|"issues JWT, gates via requireAuth"| Server
    Licensing -->|"gates every protected endpoint"| Server
    Sales -->|"decrements stock"| Inventory
    Repairs -->|"consumes parts, decrements stock"| Inventory
    Sales -.->|"references, no ownership"| ReposCustomer["Customer"]
    Repairs -.->|"references, no ownership"| ReposCustomer
    Finance -.->|"Cashbook reads Sales+Repairs+Expenses+CashEntries live"| Sales
    Finance -.-> Repairs
    Shared -.->|"never actually reconciled with"| Sales
    Shared -.->|"Dashboard Recent Activity, separate feed"| Repairs

    style Purchasing stroke-dasharray: 5 5,fill:#faa
    style DesktopIdentity stroke-dasharray: 3 3
```

**Note the dashed boundary**: `DesktopIdentity` is drawn separate from `Server/Identity` deliberately — they do not share a database, a session model, or even the same password-hashing algorithm. A "User" logged into the desktop app and a "User" row in the server's `users` table are not currently reconcilable as the same record for a hosted tenant using both — this is real, current technical debt (`CanonicalDomainModel.md`'s Technical Debt section), not a diagramming simplification.

## Domain-Specific Diagrams

### Authentication Domain (Server)

```mermaid
flowchart LR
    Login["POST /api/auth/login"] --> CheckUser{User exists<br/>+ bcrypt match?}
    CheckUser -->|"No (either reason)"| Generic["Generic 401:<br/>'Invalid mobile number or PIN'<br/>(anti-enumeration)"]
    CheckUser -->|Yes| DeviceCheck{deviceId sent<br/>+ known?}
    DeviceCheck -->|"known"| IssueSession["Issue Session<br/>(JWT 15min + refresh 30day)"]
    DeviceCheck -->|"new, under limit"| AutoTrust["Auto-trust TrustedDevice"] --> IssueSession
    DeviceCheck -->|"new, at limit"| Reject403["403 DEVICE_LIMIT_REACHED"]
    IssueSession --> RequireAuth["Every subsequent request:<br/>requireAuth verifies JWT<br/>+ checkSession() against DB"]
```

### Licensing Domain (Server)

See `LifecycleDiagrams.md` for the full state machine — this is the domain's most complex and most heavily documented lifecycle already (`docs/independent-audit/`, `docs/architecture-review/LicenseArchitecture.md`).

### Inventory Domain (Desktop)

```mermaid
flowchart LR
    AddProduct["saveProduct()"] --> Inv[("DB.inventory[]")]
    AdjustStock["doAdjustStock()<br/>(add/remove/set)"] --> Inv
    Inv -.->|"unstructured text only,<br/>reason discarded"| AuditLog[("DB.auditLog")]
    SaleCreate["saveSale() / posCharge()"] -->|"decrements stock,<br/>no audit entry at all"| Inv
    SaleEdit["updateSale()"] -->|"restore-then-rededuct"| Inv
    RepairPartsAdd["addJobPartFromSearch()"] -->|"decrements stock"| Inv
    RepairDelete["deleteJob()"] -->|"restores stock"| Inv
    NoPurchase["No Purchase flow exists"] -.->|"manual only,<br/>disconnected from Expense"| Inv
```

### Sales Domain (Desktop)

```mermaid
flowchart LR
    NewSale["New Sale modal /<br/>POS quick-checkout"] --> Validate{"Customer selected?<br/>>=1 item?<br/>Stock sufficient?<br/>Discount valid?"}
    Validate -->|fail| Block["Blocked - toast error,<br/>no partial save"]
    Validate -->|pass| Create["Create Sale +<br/>nested SaleItem[]<br/>+ decrement Inventory"]
    Create --> Edit["updateSale() - ALWAYS editable,<br/>no immutability, no status gate"]
    Edit -.->|"NO delete/void/return/cancel function exists"| Dead["dead end"]
```

### Repair Domain (Desktop)

Full lifecycle: `LifecycleDiagrams.md`. Relationship note: RepairJob has no technician-assignment field despite `technician` existing as a Role value — an assignment concept that's half-implemented (the role exists, the field to use it doesn't).

### Purchase Domain

```mermaid
flowchart LR
    NoEntity["No Purchase / PurchaseItem entity exists"]
    ManualExpense["Manually log an Expense<br/>category='Inventory Purchase'<br/>(free text, no product link)"]
    ManualStock["Separately, manually use<br/>Inventory 'Adjust Stock'<br/>action='add'"]
    ManualExpense -.->|"NO link between these two actions"| ManualStock
```

### Tenant Ownership Diagram

```mermaid
flowchart TB
    Tenant --> User1["User (owner)"]
    Tenant --> User2["User (staff)"]
    Tenant --> TenantLicense
    Tenant --> TenantData["tenant_data (opaque JSON)"]
    User1 --> Session1["Session"]
    User1 --> Device1["TrustedDevice"]
    TenantData -.->|"Phase 3+ decision: normalize?"| Inventory2["Inventory / Sales / Repairs / etc.<br/>(currently: not modeled server-side at all)"]
```

### Module Dependency Diagram (current code, not the target architecture)

```mermaid
flowchart TB
    LocalJS["server/local.js<br/>(monolithic, real, deployed)"] --> SessionsJS["server/sessions.js"]
    LocalJS --> LicenseJS["server/license.js<br/>(offline-desktop crypto engine only)"]
    LocalJS --> MailerJS["server/mailer.js"]
    LocalJS --> LoggerJS["server/logger.js"]
    IndexJS["server/index.js<br/>(vestigial, Postgres, thin)"] --> DbJS["server/db.js"]
    IndexJS --> RoutesAuth["server/routes/auth.js"]
    IndexJS --> RoutesData["server/routes/data.js"]
    AppHtml["app/ShopERP_Pro_v8.html<br/>(entire frontend + offline business logic,<br/>16,883 lines, single file)"] -.->|"HTTP, hosted mode only"| LocalJS
    AppHtml -.->|"localStorage, offline mode only"| LocalStorage[("browser/Electron localStorage")]
    MainJS["main.js (Electron)"] --> AppHtml

    style IndexJS stroke-dasharray: 5 5
    style DbJS stroke-dasharray: 5 5
    style RoutesAuth stroke-dasharray: 5 5
    style RoutesData stroke-dasharray: 5 5
```

Dashed nodes are the vestigial Postgres skeleton — not part of the real, deployed dependency graph, kept only per `docs/adr/0002-mariadb-canonical-database.md` pending Phase 9's decommission.
