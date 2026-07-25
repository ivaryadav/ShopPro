# Operations Domain Schema Design (Phase 3)

**Design only — not implemented.** Per the Phase 3 mission ("implementation is secondary... do not implement business logic yet"), none of the DDL below has been added to `server/src/database/migrations/` or executed anywhere. This document is the design artifact a future, explicitly-approved implementation phase builds from. It records the decision made in `docs/adr/0008-operations-domain-storage-strategy.md` at the level of actual columns, so that phase isn't starting from a blank page.

All tables include `tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` (per `docs/architecture/CanonicalDomainModel.md`'s "Tenant owns all business data" rule) — omitted from each table below for brevity except where it changes the design.

## InventoryItem → `inventory_items`

```sql
CREATE TABLE inventory_items (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT NOT NULL,
  name         VARCHAR(255) NOT NULL,
  category     VARCHAR(100),           -- still free text; no Category entity was justified (DomainModel.md)
  sku          VARCHAR(100),
  imei         VARCHAR(15),
  cost_price   DECIMAL(12,2) NOT NULL DEFAULT 0,
  sell_price   DECIMAL(12,2) NOT NULL,
  stock        INT NOT NULL DEFAULT 0,
  min_stock    INT NOT NULL DEFAULT 2,
  unit         VARCHAR(50),
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,  -- see note below
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inventory_imei (tenant_id, imei),
  INDEX idx_inventory_sku (tenant_id, sku),
  INDEX idx_inventory_name (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
```
**Design note (a real decision, flagged for approval, not silently made)**: `local.js`'s current behavior hard-deletes an `InventoryItem` — the *only* entity in the whole domain a normal user can hard-delete. This design adds `is_deleted` (soft-delete) instead, because a future `sale_items`/`stock_movements` row can reference a deleted product (Phase 1.5 confirmed sales keep working with a denormalized snapshot even after the product is gone) — a hard `DELETE` would either cascade-orphan those historical rows or require `ON DELETE SET NULL`, losing the FK's value for reporting. **This is a deliberate proposed change from current behavior**, not an oversight — flagged explicitly per the mission's own "if code and documentation disagree, document it" instruction, for the approving reviewer to accept or reject.
**SKU is still not marked UNIQUE** — `local.js` never enforced this either (`DomainModel.md`); adding uniqueness now would be inventing a constraint, not extracting one. Flagged as a candidate for a future, separate decision if the business wants it.

## Customer → `customers`

```sql
CREATE TABLE customers (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT NOT NULL,
  name        VARCHAR(255) NOT NULL,
  phone       VARCHAR(20) NOT NULL,
  email       VARCHAR(255),
  address     VARCHAR(500),
  type        ENUM('Regular','VIP','Wholesale','Shopkeeper') NOT NULL DEFAULT 'Regular',
  note        TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customers_phone (tenant_id, phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
```
**`balance`/`loyalty_points`/`total_purchase` are deliberately NOT included** — `DomainModel.md` confirmed these are dead fields in the current implementation (normalized onto every record but never written). Carrying forward unused columns would be preserving dead schema, not extracting real behavior. If the business wants a real loyalty/credit system, that's new feature work requiring its own design and approval — not assumed here.
Phone is **not** marked unique — `local.js`'s own duplicate-check is inconsistent (warn-then-block, `DomainModel.md`) and doesn't amount to a real DB-level constraint today; a future phase should resolve that inconsistency as its own decision, not have this schema silently pick a side.

## Sale → `sales`, SaleItem → `sale_items`

```sql
CREATE TABLE sales (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT NOT NULL,
  invoice_no   VARCHAR(50) NOT NULL,
  customer_id  BIGINT NOT NULL,
  subtotal     DECIMAL(12,2) NOT NULL,
  discount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  total        DECIMAL(12,2) NOT NULL,
  sale_date    DATE NOT NULL,
  note         TEXT,
  created_by   BIGINT,                 -- FK to users.id -- local.js only stores a name string; a future
                                        -- migration must decide whether to resolve historical names to
                                        -- user IDs or accept some rows with no resolvable user.
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sales_invoice (tenant_id, invoice_no),
  INDEX idx_sales_customer (tenant_id, customer_id),
  INDEX idx_sales_date (tenant_id, sale_date),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE sale_items (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  sale_id      BIGINT NOT NULL,
  product_id   BIGINT NOT NULL,
  product_name VARCHAR(255) NOT NULL,   -- denormalized snapshot, preserved exactly (DomainModel.md — price is editable per line, can diverge from current InventoryItem)
  price        DECIMAL(12,2) NOT NULL,  -- denormalized snapshot, NOT a live join to inventory_items.sell_price
  qty          INT NOT NULL,
  INDEX idx_sale_items_sale (sale_id),
  INDEX idx_sale_items_product (product_id),
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES inventory_items(id)
);
```
**No `status` column** — `DomainModel.md`/`BusinessRules.md` both confirmed no real status field exists in current behavior (a vestigial one is stamped but never read); adding one now would invent a lifecycle the business has never actually used. **Payments are NOT embedded here** — see the unified `payments` table below.

## Repair → `repairs`, RepairJob.partsUsed → `repair_parts`

```sql
CREATE TABLE repairs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id           BIGINT NOT NULL,
  job_no              VARCHAR(50) NOT NULL,
  customer_id         BIGINT NOT NULL,
  device              VARCHAR(255) NOT NULL,
  issue               TEXT NOT NULL,
  status              ENUM('Received','Diagnosing','Repairing','Ready','Delivered') NOT NULL DEFAULT 'Received',
  estimated_cost      DECIMAL(12,2) NOT NULL DEFAULT 0,
  final_cost          DECIMAL(12,2) NOT NULL DEFAULT 0,
  labour_charge       DECIMAL(12,2) NOT NULL DEFAULT 0,
  received_date       DATE NOT NULL,
  estimated_delivery  DATE,
  delivered_date      DATE,
  warranty_days       INT NOT NULL DEFAULT 30,
  alt_whatsapp        VARCHAR(20),
  note                TEXT,
  created_by          BIGINT,          -- same caveat as sales.created_by
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_repairs_jobno (tenant_id, job_no),
  INDEX idx_repairs_customer (tenant_id, customer_id),
  INDEX idx_repairs_status (tenant_id, status),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE repair_parts (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  repair_id    BIGINT NOT NULL,
  product_id   BIGINT NOT NULL,
  product_name VARCHAR(255) NOT NULL,   -- denormalized snapshot, same rationale as sale_items
  price        DECIMAL(12,2) NOT NULL,
  qty          INT NOT NULL,
  FOREIGN KEY (repair_id) REFERENCES repairs(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES inventory_items(id)
);
```
**No `technician_id` column** — `DomainModel.md` confirmed no such field exists today (`created_by` only records who *created* the job, not who's repairing it), despite a `technician` role existing. Adding one now would be a real feature addition, not an extraction — deliberately not designed here; a future phase should treat "assign a repair to a technician" as its own, separately-approved feature.
**`status` enum matches the real 5 states exactly** (`Received/Diagnosing/Repairing/Ready/Delivered`) — not the 7 originally assumed by earlier phases before Phase 1.5's extraction corrected that. The warranty-reopen transition (back to `Repairing` from any later state) is a valid `UPDATE`, not a constraint violation — this design does not add a stricter state machine than the code actually enforces.

## Expense → `expenses`, RecurringExpense → `recurring_expenses`

```sql
CREATE TABLE expenses (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT NOT NULL,
  title       VARCHAR(255) NOT NULL,
  category    VARCHAR(100) NOT NULL DEFAULT 'Other',
  amount      DECIMAL(12,2) NOT NULL,
  expense_date DATE NOT NULL,
  note        TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_expenses_date (tenant_id, expense_date),
  INDEX idx_expenses_category (tenant_id, category),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE recurring_expenses (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  title         VARCHAR(255) NOT NULL,
  category      VARCHAR(100) NOT NULL DEFAULT 'Other',
  amount        DECIMAL(12,2) NOT NULL,
  note          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_applied  VARCHAR(7),            -- 'YYYY-MM', matches local.js's exact string format, not a DATE
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
```
**No `paidTo`/`payment_mode` columns** — confirmed dead demo-only fields (`DomainModel.md`), not part of real behavior. **`recurring_expenses` still has no scheduler** — this design only stores the same data `local.js` does; whether to finally add real automatic generation (closing the "someone has to remember to click the button" gap) is a business-rule decision for a future phase, not assumed here.

## StockMovement → `stock_movements` (new — no current data to migrate)

```sql
CREATE TABLE stock_movements (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT NOT NULL,
  product_id   BIGINT NOT NULL,
  delta        INT NOT NULL,           -- positive = stock increased, negative = decreased
  reason       ENUM('sale','sale_edit_restore','repair_parts','repair_delete_restore','manual_adjust','product_delete_restore') NOT NULL,
  reference_type VARCHAR(20),          -- 'sale' | 'repair' | NULL (manual)
  reference_id BIGINT,                 -- sales.id or repairs.id when applicable
  note         VARCHAR(500),           -- the user's own reason text for manual adjustments — local.js
                                        -- collects this today and then DISCARDS it (DomainModel.md); this
                                        -- design finally captures it, a genuine improvement, not just a port
  created_by   BIGINT,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_movements_product (tenant_id, product_id, created_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES inventory_items(id)
);
```
This is genuinely new capability, not an extraction (there is no existing StockMovement data to migrate — `OperationsDomainAnalysis.md`). Its write paths mirror the 4 call sites `DomainModel.md` already identified as the places `InventoryItem.stock` is mutated today (sale creation/edit, repair parts consumption/deletion, manual adjustment, product deletion) — a future implementation phase adds one `INSERT` into this table alongside each existing stock mutation, not a redesign of when/why stock changes.

## Payment → `payments` (new, unifying 3 current representations)

```sql
CREATE TABLE payments (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT NOT NULL,
  source_type    ENUM('sale','repair','manual') NOT NULL,
  source_id      BIGINT,               -- sales.id or repairs.id; NULL for a manual cash-book entry
  direction      ENUM('in','out') NOT NULL DEFAULT 'in',  -- 'out' matches DB.cashEntries' own in/out concept; sale/repair payments are always 'in'
  method         ENUM('Cash','UPI','Card','Bank Transfer') NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  description    VARCHAR(500),         -- only meaningful for manual entries (DB.cashEntries.description)
  payment_date   DATE NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payments_source (source_type, source_id),
  INDEX idx_payments_date (tenant_id, payment_date),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
```
**This is the single most design-sensitive table in this whole document**, exactly as `docs/adr/0008-operations-domain-storage-strategy.md` flags. `Sale.payments[]` and `RepairJob.payments[]` become rows with `source_type`/`source_id` set; `DB.cashEntries[]` becomes rows with `source_type='manual'` and `source_id=NULL`. The `method` enum takes the *union* of what `local.js` allows in each context today (Cash/UPI/Card for sale/repair collection, +Bank Transfer for manual entries only) — a future phase must decide whether to keep that inconsistency (some methods only valid in some contexts) enforced at the application layer, or finally make all 4 methods available everywhere (a real, if small, behavior change requiring its own sign-off, not silently decided by this schema).

## Invoice — not designed

Per `docs/architecture/OperationsDomainAnalysis.md`'s explicit conclusion: no current behavior justifies a separate `invoices` table. `sales.invoice_no` is the only invoice-related column in this design.

## Configuration → kept as JSON, not normalized

```sql
CREATE TABLE tenant_settings (
  tenant_id     BIGINT PRIMARY KEY,
  settings_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
```
One row per tenant, matching `tenant_data`'s existing 1-to-1 shape — the JSON column holds exactly what `DB.settings` holds today, dead fields and all (a future phase can clean those up as its own, separate decision, not smuggled into a storage migration). MariaDB's native `JSON` type provides basic validation (rejects malformed JSON) without forcing a rigid schema — the right middle ground per `docs/adr/0008-operations-domain-storage-strategy.md`'s reasoning.
