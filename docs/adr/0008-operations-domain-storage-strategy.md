# ADR-0008: Operations Domain Storage Strategy

## Status
Accepted (architecture only — no implementation performed under this ADR; see "Consequences")

## Context

The Operations domain (Inventory, Sales, Repairs, Customers, Expenses, and related entities) exists only client-side today, in `app/ShopERP_Pro_v8.html`'s `DB` object; hosted mode persists it as one opaque JSON blob per tenant (`tenant_data.data`), which the server never inspects. `docs/architecture/OperationsDomainAnalysis.md` analyzed every entity (current implementation, business rules, relationships, expected growth, reporting requirements, query complexity, performance considerations, offline compatibility, migration difficulty); `docs/architecture/StorageStrategyComparison.md` evaluated the 3 storage options the mission specified against that evidence. This ADR records the resulting decision.

## Decision

**Option C — Hybrid.** Normalize the transactional, growing, relationally-queried entities into real MariaDB tables; keep Configuration as a JSON column. Specifically:

**Normalized**: `inventory_items`, `customers`, `sales`, `sale_items`, `repairs`, `repair_parts`, `expenses`, `recurring_expenses`, `stock_movements` (new), `payments` (new, unifying).

**Kept as JSON**: `tenant_settings` (a per-tenant row with a JSON column) — Configuration's own analysis found it small, static, single-object-per-tenant, and never relationally queried; normalizing it column-by-column would be over-engineering, not rigor.

**Not created**: An `invoices` table — no current behavior justifies one (`OperationsDomainAnalysis.md`); `Sale.invoice_no` remains sufficient.

**Out of scope**: `Reports` (computed, not stored) and `CloudBackup` (Administration domain).

## Alternatives considered

Full detail in `docs/architecture/StorageStrategyComparison.md`. Summary: **Option A (fully normalized)** was rejected specifically because it would also force Configuration into an ill-fitting rigid shape — the evidence doesn't support normalizing everything uniformly. **Option B (keep the JSON blob)** was rejected specifically because `PUT /api/data` requires transmitting the entire tenant dataset on every write with no partial-update path (`server/local.js:1656-1670`), and the highest-volume entities (Sale, Repair) make that cost grow without bound — evidenced per-entity, not asserted generically.

## Consequences

- **This ADR is a design decision, not an implementation.** Per the Phase 3 mission ("implementation is secondary... do not implement business logic yet"), no migration files, repositories, or services for the Operations domain were created under this phase. Proposed schema designs are documented in `docs/database/OperationsSchemaDesign.md` as design artifacts, explicitly not added to `server/src/database/migrations/` (which would make them real, executable, migration-runner-discoverable schema changes) — that step requires its own future-phase approval.
- **Migration from the JSON blob to normalized tables is a real, nontrivial future undertaking** — per-tenant data must be parsed out of the existing blob and inserted row-by-row, with "customer data is never deleted" as a hard constraint throughout (`docs/architecture/CanonicalDomainModel.md`'s standing principle). `SaleItem`/`RepairJob.partsUsed` nested arrays need splitting into child tables while preserving their denormalized price/name snapshots exactly, not re-deriving them from current `InventoryItem` state.
- **`Payment`'s unification is the single most design-sensitive piece** — `Sale.payments[]`, `RepairJob.payments[]`, and `DB.cashEntries[]` don't share an identical shape today (cash entries have no `sale_id`/`repair_id`); a future phase must design the unifying schema carefully, not just concatenate three arrays.
- **Two storage patterns now coexist by design** (normalized tables + a JSON settings column) — an acknowledged, deliberate tradeoff, not an oversight; `docs/architecture/StorageStrategyComparison.md` states this cost explicitly rather than presenting Option C as free.
- This decision governs whichever future phase actually builds the Operations domain against MariaDB (the phase `server/src/routes/tenants/README.md`, written in Phase 1, flagged as needing exactly this decision before it could proceed) — that phase now has an answer to build against.
