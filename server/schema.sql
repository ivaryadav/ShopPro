-- ═══════════════════════════════════════════════════════
--  ShopERP Pro — PostgreSQL Multi-Tenant Schema
--  Run once on your IntraServer PostgreSQL instance:
--    psql -U shoperpro_user -d shoperpro -f schema.sql
-- ═══════════════════════════════════════════════════════

-- Each shop/business that signs up is a "tenant"
CREATE TABLE IF NOT EXISTS tenants (
  id            SERIAL PRIMARY KEY,
  shop_name     VARCHAR(255) NOT NULL,
  subdomain     VARCHAR(100) UNIQUE,          -- e.g. "ravi-mobiles" → ravi-mobiles.yourdomain.com
  plan          VARCHAR(50)  DEFAULT 'free',  -- free / pro / enterprise
  is_active     BOOLEAN      DEFAULT TRUE,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- Users belong to a tenant (owner + staff)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username      VARCHAR(100) NOT NULL,
  email         VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(50)  DEFAULT 'staff',  -- owner / staff / viewer
  is_active     BOOLEAN      DEFAULT TRUE,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(tenant_id, username)
);

-- Stores the entire DB JSON blob per tenant (Phase 1 — minimal frontend change)
-- In Phase 2 this gets replaced by normalized tables below
CREATE TABLE IF NOT EXISTS tenant_data (
  tenant_id     INT          PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  data          JSONB        NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_by    INT          REFERENCES users(id)
);

-- Audit log — every save action is recorded
CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       INT          REFERENCES users(id),
  action        VARCHAR(100) NOT NULL,  -- 'data_save', 'login', 'register', etc.
  ip_address    INET,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Phase 2: Normalized tables (future migration) ─────────────────────────────
-- These replace tenant_data.data->>'repairs', etc. once you are ready.

CREATE TABLE IF NOT EXISTS repairs (
  id                SERIAL PRIMARY KEY,
  tenant_id         INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_no            VARCHAR(50)  NOT NULL,
  customer_name     VARCHAR(255),
  device            VARCHAR(255),
  issue             TEXT,
  status            VARCHAR(50)  DEFAULT 'Received',
  estimated_cost    NUMERIC(10,2) DEFAULT 0,
  final_cost        NUMERIC(10,2) DEFAULT 0,
  parts_used        JSONB        DEFAULT '[]',
  labour_charge     NUMERIC(10,2) DEFAULT 0,
  advance_amount    NUMERIC(10,2) DEFAULT 0,
  paid_amount       NUMERIC(10,2) DEFAULT 0,
  payment_status    VARCHAR(50)  DEFAULT 'Unpaid',
  payments          JSONB        DEFAULT '[]',
  received_date     DATE,
  delivered_date    DATE,
  estimated_delivery DATE,
  note              TEXT,
  warranty_days     INT          DEFAULT 30,
  created_by        VARCHAR(100),
  created_at        TIMESTAMPTZ  DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(tenant_id, job_no)
);

CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_no      VARCHAR(50)  NOT NULL,
  customer_name   VARCHAR(255),
  customer_id     INT,
  sale_date       DATE,
  items           JSONB        DEFAULT '[]',
  subtotal        NUMERIC(10,2) DEFAULT 0,
  discount        NUMERIC(10,2) DEFAULT 0,
  total           NUMERIC(10,2) DEFAULT 0,
  paid            NUMERIC(10,2) DEFAULT 0,
  payment_method  VARCHAR(100),
  payments        JSONB        DEFAULT '[]',
  note            TEXT,
  created_by      VARCHAR(100),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(tenant_id, invoice_no)
);

CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  phone         VARCHAR(20),
  email         VARCHAR(255),
  address       TEXT,
  type          VARCHAR(50)  DEFAULT 'Regular',
  note          TEXT,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  sku           VARCHAR(100),
  category      VARCHAR(100),
  brand         VARCHAR(100),
  stock         INT          DEFAULT 0,
  min_stock     INT          DEFAULT 5,
  buy_price     NUMERIC(10,2) DEFAULT 0,
  sell_price    NUMERIC(10,2) DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category      VARCHAR(100),
  description   TEXT,
  amount        NUMERIC(10,2) DEFAULT 0,
  expense_date  DATE,
  note          TEXT,
  created_by    VARCHAR(100),
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- Indexes for fast tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_repairs_tenant    ON repairs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant      ON sales(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant  ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_tenant  ON inventory(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant   ON expenses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant      ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant      ON users(tenant_id);
