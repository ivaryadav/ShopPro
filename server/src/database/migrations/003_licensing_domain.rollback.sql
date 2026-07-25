-- Rollback for 003_licensing_domain. Drop order respects FK dependencies.
DROP TABLE IF EXISTS license_history;
DROP TABLE IF EXISTS tenant_licenses;
DROP TABLE IF EXISTS subscription_plans;
