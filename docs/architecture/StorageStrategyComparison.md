# Storage Options Comparison — Operations Domain (Phase 3)

Evaluates the 3 options the mission specified against the evidence in `docs/architecture/OperationsDomainAnalysis.md`. Feeds directly into `docs/adr/0008-operations-domain-storage-strategy.md`.

## Option A — Fully Normalized Relational Model

Every entity (Inventory, Sale, SaleItem, Customer, Repair, Expense, RecurringExpense, StockMovement, Payment, **and** Configuration) becomes its own table.

- **Strengths**: Consistent model, real indexes everywhere, no special-casing.
- **Weaknesses**: Forces Configuration — a small, static, never-queried-relationally, per-tenant settings object — into a rigid column-per-setting shape it doesn't need. Every new setting field becomes a migration. `docs/architecture/OperationsDomainAnalysis.md`'s Configuration section found this is real over-engineering, not a neutral extra-safety choice.
- **Verdict**: Rejected as a blanket policy — right for most entities, wrong for Configuration specifically.

## Option B — Tenant JSON Blob (status quo)

Keep everything as it is today — one `tenant_data.data` JSON document per tenant, no schema inside it.

- **Strengths**: Zero migration effort/risk. Matches the desktop product's own model exactly, if that's ever a goal. Trivially flexible for anything (no schema to change).
- **Weaknesses, evidenced**: `docs/architecture/OperationsDomainAnalysis.md`'s Sales/Repairs/StockMovement/Payment sections all identify the same structural problem — every write to *any* entity requires reading, holding in memory, and re-transmitting the tenant's *entire* operational history, and that cost grows without bound as Sales/Repairs accumulate (confirmed: `PUT /api/data` takes no partial-update path, `server/local.js:1656-1670`). No indexed lookups (SKU/IMEI/invoice-number/phone search all require loading everything). No real relational integrity (a `productId` reference from a SaleItem to a since-deleted InventoryItem is just a dangling number, not enforced or even detectable without an app-level scan). Reporting (revenue summaries, per-customer spend, top-selling products) requires loading the whole blob into Node/browser memory and iterating in JavaScript, every time, for every request.
- **Verdict**: Rejected as the ongoing strategy for the growing, transactional entities (Sale, SaleItem, Repair, StockMovement, Payment) — the evidence is specific and repeated across every high-volume entity's analysis, not a generic "JSON is bad" assumption. Remains the right choice for Configuration specifically (see Option C).

## Option C — Hybrid Model

Normalize the entities that have real relational needs (growth, indexed lookups, cross-entity reporting, referential integrity); keep the entities that don't as JSON.

| Entity | Recommendation | Why (see `OperationsDomainAnalysis.md` for full reasoning) |
|---|---|---|
| Inventory | Normalize | Indexed SKU/IMEI lookup; real FK target for SaleItem/StockMovement. |
| Sale | Normalize | Highest write-amplification offender; needs date-range/invoice-number indexing. |
| SaleItem | Normalize (child table) | Needed for "top-selling product" reporting; scales with Sale. |
| Customer | Normalize | Cheap win — turns an O(all sales) per-profile computation into an indexed `SUM`. |
| Repair | Normalize | Same profile as Sale. |
| Expense | Normalize | Low volume, but normalizing is nearly free once the migration tooling exists for the entities above, and keeps reporting uniform. |
| RecurringExpense | Normalize | Tiny, static — trivial either way; normalized for consistency with Expense. |
| StockMovement | Normalize (new) | The textbook append-only-ledger case; a JSON array here would inherit Sale's exact problem from day one, at a higher row rate. |
| Payment | Normalize (new, unifying) | Lets three currently-disconnected representations (Sale.payments, Repair.payments, cashEntries) become one real, queryable ledger — directly fixes a documented reporting pain point (the Cashbook view's awkward three-way merge). |
| Invoice | **Do not create** | No current behavior justifies it (Phase 1.5/this phase both confirm) — `Sale.invoice_no` remains sufficient. |
| Configuration | **Keep as JSON** (a `settings_json` column on a per-tenant row, or reuse a `tenant_settings` table with one JSON column) | Small, static, single-object-per-tenant, never relationally queried — normalizing it would be the over-engineering Option A commits. |
| Reports | N/A | Not stored; queries against the above. |
| Cloud Backup | N/A | Administration domain, out of scope (`OperationsDomainAnalysis.md`). |

- **Weaknesses**: Two storage patterns to maintain instead of one — a real, acknowledged cost, not free. Requires judgment calls on future entities (which side of the line do they fall on) rather than a single mechanical rule.
- **Verdict**: **Recommended.** Every entity's recommendation traces to a specific, evidenced reason in `OperationsDomainAnalysis.md`, not a default. This is not "hybrid because it sounds safe" — it's "normalize where the evidence says growth/indexing/relational-integrity matter, keep JSON where the evidence says it doesn't."

## Decision

See `docs/adr/0008-operations-domain-storage-strategy.md` for the formal ADR recording this as Option C, with the per-entity table above as its authoritative scope.
