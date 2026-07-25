-- Rollback for 001_identity_tenant_core. Drop order respects FK dependencies.
DROP TABLE IF EXISTS trusted_devices;
DROP TABLE IF EXISTS user_sessions;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS tenants;
