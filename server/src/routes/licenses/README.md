# routes/licenses/

Registration, email verification, admin approval, subscription plans, renewal, and the license status-transition lifecycle (`PENDING_APPROVAL → ACTIVE → READ_ONLY → SUSPENDED → ARCHIVED`). Populated starting Phase 4 (SaaS Licensing & Subscriptions) — ported from `server/local.js`'s `tenant_licenses`/`license_history`/`subscription_plans` logic, the single most heavily audited subsystem in this project (see `docs/independent-audit/`); the ported version must pass an equivalent regression suite before this phase can be considered complete, per ADR-0001.
