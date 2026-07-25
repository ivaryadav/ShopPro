# routes/users/

Staff/owner user management within a tenant (add staff, list users, PIN reset, role toggling) and trusted-device management. Populated starting Phase 2 (Auth & Tenant Core) alongside `routes/auth/`, since these are tightly coupled in the current implementation (`server/local.js`'s `/api/auth/add-staff`, `/api/data/users`, and the `trusted_devices` table).
