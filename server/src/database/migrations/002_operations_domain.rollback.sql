-- Rollback for 002_operations_domain. Drop order respects FK dependencies
-- (children before parents) — mirrors 001's rollback convention.

DROP TABLE IF EXISTS tenant_settings;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS recurring_expenses;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS repair_parts;
DROP TABLE IF EXISTS repairs;
DROP TABLE IF EXISTS sale_items;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS inventory_items;
