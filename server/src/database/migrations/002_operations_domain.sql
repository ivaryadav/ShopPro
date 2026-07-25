-- 002_operations_domain — Phase 4 (Operations Domain Implementation).
--
-- Implements docs/database/OperationsSchemaDesign.md (Phase 3, design-only)
-- against real MariaDB, per the Hybrid Storage Strategy decided in
-- docs/adr/0008-operations-domain-storage-strategy.md. Normalizes:
-- InventoryItem, Customer, Sale, SaleItem, Repair, RepairPart, Expense,
-- RecurringExpense, StockMovement (new), Payment (new). Configuration
-- stays JSON (tenant_settings), per that same ADR and this phase's mission.
--
-- Two deliberate deviations from the Phase 3 design doc, both made to
-- satisfy this phase's overriding "preserve existing behavior" instruction
-- (the design doc's is_deleted proposal was explicitly flagged there as
-- "not decided unilaterally" — never approved, so not implemented here):
--
-- 1. inventory_items has NO is_deleted column. local.js hard-deletes a
--    product unconditionally (local.js's deleteProduct: DB.inventory =
--    DB.inventory.filter(...), no restriction even if the product was
--    already sold/used in a repair). This migration reproduces that: a
--    real DELETE is supported. To make that compatible with real FK
--    constraints (which local.js's blob storage never had), sale_items /
--    repair_parts / stock_movements' product_id FKs are ON DELETE SET NULL
--    rather than CASCADE (which would destroy sales/repair history) or
--    RESTRICT (which would forbid a delete local.js allows today).
-- 2. sales.created_by / repairs.created_by / stock_movements.created_by /
--    payments (no such column needed there) are nullable FK ON DELETE SET
--    NULL to users(id) — local.js only ever stored a free-text name
--    (currentUser.name) — a real FK is new structure, not a behavior
--    change, so it must tolerate the referenced user later being removed
--    without destroying the historical sale/repair/movement row.
--
-- Every table includes tenant_id BIGINT NOT NULL REFERENCES tenants(id)
-- ON DELETE CASCADE, per CanonicalDomainModel.md's "tenant owns all
-- business data" rule (same convention migrations/001 already uses).

-- ── inventory_items ───────────────────────────────────────────────────────
-- Matches app/ShopERP_Pro_v8.html's DB.inventory item shape exactly
-- (saveProduct/updateProduct, ~line 9057/9105). SKU deliberately NOT
-- unique and phone-equivalent duplicate checks don't apply here — IMEI is
-- the only uniqueness local.js enforces (saveProduct:9069), scoped per
-- tenant since IMEIs are compared only against DB.inventory (one tenant's
-- data) today, never globally.
CREATE TABLE IF NOT EXISTS inventory_items (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT NOT NULL,
  name         VARCHAR(255) NOT NULL,
  category     VARCHAR(100),
  sku          VARCHAR(100),
  imei         VARCHAR(15),
  cost_price   DECIMAL(12,2) NOT NULL DEFAULT 0,
  sell_price   DECIMAL(12,2) NOT NULL,
  stock        INT NOT NULL DEFAULT 0,
  min_stock    INT NOT NULL DEFAULT 2,
  unit         VARCHAR(50) NOT NULL DEFAULT 'pcs',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inventory_imei (tenant_id, imei),
  INDEX idx_inventory_sku (tenant_id, sku),
  INDEX idx_inventory_name (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ── customers ─────────────────────────────────────────────────────────────
-- No balance/loyalty_points/total_purchase (confirmed dead fields,
-- DomainModel.md). Phone NOT unique — local.js's own duplicate check is
-- warn-then-allow in saveCustomer (~line 11772) but hard-block in
-- saveCustomerAndReturnToSale/quickAddCustomerForSale (~line 10166) — a
-- real, pre-existing inconsistency this schema does not resolve
-- (MigrationNotes.md documents how the service layer reproduces both
-- paths via an explicit allowDuplicate parameter).
CREATE TABLE IF NOT EXISTS customers (
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

-- ── sales / sale_items ────────────────────────────────────────────────────
-- No status column (BusinessRules.md: no real status field is ever read).
-- Payments are NOT embedded — see the unified `payments` table below.
CREATE TABLE IF NOT EXISTS sales (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT NOT NULL,
  invoice_no   VARCHAR(50) NOT NULL,
  customer_id  BIGINT NOT NULL,
  subtotal     DECIMAL(12,2) NOT NULL,
  discount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  total        DECIMAL(12,2) NOT NULL,
  sale_date    DATE NOT NULL,
  note         TEXT,
  created_by   BIGINT,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sales_invoice (tenant_id, invoice_no),
  INDEX idx_sales_customer (tenant_id, customer_id),
  INDEX idx_sales_date (tenant_id, sale_date),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sale_items (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  sale_id      BIGINT NOT NULL,
  product_id   BIGINT,
  product_name VARCHAR(255) NOT NULL,
  price        DECIMAL(12,2) NOT NULL,
  qty          INT NOT NULL,
  INDEX idx_sale_items_sale (sale_id),
  INDEX idx_sale_items_product (product_id),
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES inventory_items(id) ON DELETE SET NULL
);

-- ── repairs / repair_parts ────────────────────────────────────────────────
-- Status enum matches the real 5 states exactly (Phase 1.5's extraction).
-- Warranty-reopen (setJobStatus, ~line 11123) is a free transition to any
-- value, including back to 'Repairing' from a later state — no stricter
-- state machine than local.js's own is enforced here. No technician_id
-- (explicitly out of scope for this phase per the mission).
CREATE TABLE IF NOT EXISTS repairs (
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
  created_by          BIGINT,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_repairs_jobno (tenant_id, job_no),
  INDEX idx_repairs_customer (tenant_id, customer_id),
  INDEX idx_repairs_status (tenant_id, status),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS repair_parts (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  repair_id    BIGINT NOT NULL,
  product_id   BIGINT,
  product_name VARCHAR(255) NOT NULL,
  price        DECIMAL(12,2) NOT NULL,
  qty          INT NOT NULL,
  FOREIGN KEY (repair_id) REFERENCES repairs(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES inventory_items(id) ON DELETE SET NULL
);

-- ── expenses / recurring_expenses ─────────────────────────────────────────
-- No paidTo/payment_mode (confirmed dead demo-only fields). No scheduler —
-- last_applied is only ever written by an explicit "Apply This Month"
-- action (applyRecurringExpenses, ~line 12291), matching local.js exactly
-- — this phase does not add automatic generation (explicitly out of scope).
CREATE TABLE IF NOT EXISTS expenses (
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

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  title         VARCHAR(255) NOT NULL,
  category      VARCHAR(100) NOT NULL DEFAULT 'Other',
  amount        DECIMAL(12,2) NOT NULL,
  note          TEXT,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_applied  VARCHAR(7),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ── stock_movements (new) ─────────────────────────────────────────────────
-- Genuinely new capability — no current data to migrate (no existing
-- table tracks this). Write paths mirror the 4 places local.js mutates
-- InventoryItem.stock today: sale create/edit (saveSale:10074,
-- updateSale:9974-9982), repair parts consume/restore (addJobPart:11297,
-- removeJobPart:11304, deleteJob:10419-10422), manual adjustment
-- (doAdjustStock:9142-9153), and product delete (no current stock
-- movement — deleteProduct just removes the row, but a movement is still
-- logged here for audit completeness since the row disappearing
-- shouldn't erase the fact stock changed).
CREATE TABLE IF NOT EXISTS stock_movements (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT NOT NULL,
  product_id     BIGINT,
  delta          INT NOT NULL,
  reason         ENUM('sale','sale_edit_restore','repair_parts','repair_delete_restore','manual_adjust','product_delete_restore') NOT NULL,
  reference_type VARCHAR(20),
  reference_id   BIGINT,
  note           VARCHAR(500),
  created_by     BIGINT,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_movements_product (tenant_id, product_id, created_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES inventory_items(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ── payments (new, unifying) ──────────────────────────────────────────────
-- Unifies Sale.payments[] (source_type='sale'), RepairJob.payments[]
-- (source_type='repair'), and DB.cashEntries[] (source_type='manual',
-- source_id NULL). method is the UNION of what local.js allows in each
-- context (buildPaymentUI:7714 offers exactly Cash/UPI/Card for
-- sale/repair collection, while addCashEntry:16747 additionally offers
-- Bank Transfer for manual entries only) — the schema stores all 4 as valid
-- values. docs/database/MigrationNotes.md records that the per-context
-- restriction (no Bank Transfer for sale/repair) is preserved as an
-- application-layer rule in the service layer, not a DB constraint,
-- exactly as flagged unresolved in OperationsSchemaDesign.md.
CREATE TABLE IF NOT EXISTS payments (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT NOT NULL,
  source_type    ENUM('sale','repair','manual') NOT NULL,
  source_id      BIGINT,
  direction      ENUM('in','out') NOT NULL DEFAULT 'in',
  method         ENUM('Cash','UPI','Card','Bank Transfer') NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  description    VARCHAR(500),
  payment_date   DATE NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payments_source (source_type, source_id),
  INDEX idx_payments_date (tenant_id, payment_date),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ── tenant_settings — Configuration, kept as JSON per ADR-0008 ───────────
-- One row per tenant, matching DB.settings' existing 1-object-per-tenant
-- shape exactly. Holds the same fields local.js's DB.settings does,
-- unexamined — cleaning up any dead settings fields is a separate,
-- future decision, not smuggled into this storage migration.
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id     BIGINT PRIMARY KEY,
  settings_json JSON NOT NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
