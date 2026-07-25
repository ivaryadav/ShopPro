# routes/tenants/

Tenant-scoped business data (inventory, sales, purchases, reports, settings — currently `local.js`'s single `tenant_data` JSON blob per tenant) and tenant-status administration. Populated starting Phase 3 (Tenant Business Data) — that phase's own ADR will record whether the existing JSON-blob model is kept or normalized into relational tables now that a real relational database is available.

Also owns the fix for the Critical finding in `docs/independent-audit/APIAudit.md` / `FinalBlockerResolution.md` (tenant termination consistency) — the new implementation must not reintroduce two unsynchronized status representations; this is the layer where "one source of truth" for tenant activity status is enforced going forward.
