# Operations Domain Analysis (Phase 3)

Every operational entity currently lives only in `app/ShopERP_Pro_v8.html`'s client-side `DB` object — hosted mode stores it as one opaque JSON blob (`tenant_data.data`), server-side code never looks inside it. This document analyzes each entity along 9 dimensions to ground the storage-strategy decision in `docs/adr/0008-operations-domain-storage-strategy.md` in evidence, not intuition. Current-implementation facts are drawn from `docs/architecture/DomainModel.md` (Phase 1.5); this document adds the new analytical dimensions Phase 3 specifically requires (Expected Growth, Reporting Requirements, Query Complexity, Performance Considerations, Offline Compatibility, Migration Difficulty).

## The one mechanism every entity below is subject to today

`GET /api/data` returns the tenant's **entire** JSON blob in one response; `PUT /api/data` requires the caller to send the **entire** object back, every time, for any change at all (`server/local.js:1656-1670`, re-confirmed directly in this phase, not assumed). There is no partial-update/patch endpoint. This is the single fact that dominates every entity's Performance Considerations below — the question is never "does this entity individually need normalizing," it's "does this entity's growth make the whole-blob-rewrite cost of *every other* entity's writes worse."

---

## Inventory (`InventoryItem`)

- **Current Implementation**: `DB.inventory[]`, ~10 fields, hard-deletable (the only entity confirmed hard-deleted by a normal user action anywhere in the domain).
- **Business Rules**: `sellPrice >= costPrice` enforced; IMEI unique + format-checked; SKU **not** enforced unique (a real gap).
- **Relationships**: Referenced by `SaleItem`/`RepairJob.partsUsed[]` via `productId` (denormalized name/price snapshot at time of use, not a live join).
- **Expected Growth**: Bounded but real — a mobile-repair shop's catalog (phones, accessories, spare parts) plausibly reaches low thousands of SKUs over a shop's lifetime. Not unbounded like a transaction log, but large enough that "load everything to find one SKU" stops being free.
- **Reporting Requirements**: Stock valuation, low-stock alerts, top-selling items (a join against Sales) — the last one is a real aggregation query, not a simple filter.
- **Query Complexity**: Point lookups by SKU/IMEI/name (search-as-you-type in the POS UI) — these want an index; a JSON blob offers none.
- **Performance Considerations**: Every stock adjustment (a single-field change) currently requires reading and rewriting the *entire* tenant blob, including every other entity's data. This gets worse in direct proportion to how large the *other* entities (especially Sales) grow, not just Inventory itself.
- **Offline Compatibility**: Not a live constraint today — hosted mode has no offline-queue mechanism at all (confirmed: no client-side write-queue code exists); this dimension only matters if a future phase adds one, and normalized tables with the existing `tenant_data.version` optimistic-concurrency pattern extend naturally to per-row versioning, which is *more* offline-sync-friendly than one monolithic blob version number, not less.
- **Migration Difficulty**: Low-moderate — flat structure, one row per item, straightforward `INSERT` per existing array element.

## Sales (`Sale`) — the highest-volume entity in this domain

- **Current Implementation**: `DB.sales[]`, no `status` field (a vestigial one is stamped but never read), no delete/void/cancel function found anywhere.
- **Business Rules**: Stock-sufficiency hard-validated before save; completing a sale decrements Inventory; editing restores-then-rededucts (a correct delta pattern); invoice numbers self-heal against both a counter and existing values.
- **Relationships**: Many-to-1 Customer (denormalized name copy); 1-to-many nested `SaleItem`.
- **Expected Growth**: **Unbounded and continuous** — every single transaction a shop makes generates one. A shop open for a few years easily accumulates tens of thousands of rows. This is the entity that makes "keep everything in one JSON blob" untenable at scale, independent of any other consideration.
- **Reporting Requirements**: Daily/monthly revenue, payment-method breakdowns, top customers by spend — all standard `GROUP BY`/`SUM` queries in SQL; each one requires loading and JS-iterating the *entire* sales history (plus everything else in the blob) today.
- **Query Complexity**: Date-range filtering, customer-specific history, invoice-number lookup — every one of these wants an index today provides none of.
- **Performance Considerations**: **The single strongest evidence for normalization in this entire analysis.** As `DB.sales[]` grows, *every* write to *any* entity in the tenant's data (adding one expense, adjusting one product's stock) pays the cost of re-serializing and re-transmitting the ever-growing sales history along with it, because they all share one JSON document and one whole-blob `PUT`.
- **Offline Compatibility**: Same as Inventory — not a live constraint, and normalization doesn't make this worse.
- **Migration Difficulty**: **Moderate-high** — the nested `items[]` array needs splitting into a child table (`SaleItem`), and the `payments[]` array needs a decision (embed as JSON still, or normalize into a `Payment` table — see below).

## SaleItem

- **Current Implementation**: Nested inside `Sale.items[]`, not a top-level array — `{productId, name, price, qty}`, price/name denormalized (editable per-line, can legitimately diverge from the current `InventoryItem`).
- **Relationships**: Many-to-1 Sale (true parent-child, always created/deleted with its parent); many-to-1 InventoryItem (referenced, not owned).
- **Expected Growth**: Scales with Sales — every sale has 1+ line items, so this table would be larger than Sales itself.
- **Reporting Requirements**: "Top-selling products" needs this table specifically (Sale alone can't answer it — you need the line items).
- **Query Complexity**: Needs to be joined against both Sale (for date/customer context) and InventoryItem (for current vs. sale-time price comparison) — a genuine relational access pattern.
- **Performance Considerations**: Same write-amplification argument as Sale, compounded (more rows per transaction).
- **Migration Difficulty**: Moderate — one child row per array element per sale; must preserve the denormalized name/price snapshot exactly (not re-derive it from current InventoryItem state, which could differ).

## Customers (`Customer`)

- **Current Implementation**: `DB.customers[]`; `balance`/`loyaltyPoints`/`totalPurchase` fields exist but are never written by any live code path (dead schema, confirmed Phase 1.5).
- **Business Rules**: Phone soft-uniqueness (a real, confirmed inconsistency — warn-then-block); "pending dues" computed live from unpaid sales, not stored.
- **Relationships**: Referenced by Sale and RepairJob (not owning them).
- **Expected Growth**: Bounded, moderate — hundreds per shop is a reasonable ceiling for most of this product's target market.
- **Reporting Requirements**: Per-customer spend/dues aggregation — currently a full JS-side filter over *all* sales for every profile view; trivial with an indexed `customer_id` foreign key and `SUM`.
- **Query Complexity**: Phone-number lookup (soft-unique check), name search — both want an index.
- **Performance Considerations**: Low growth means the blob-rewrite cost from Customer's *own* size is minor — its main cost today is that computing "pending dues" requires touching the *entire* Sales array on every customer-profile view.
- **Migration Difficulty**: Low — flat structure, one row per customer, and this is the cleanest opportunity to finally decide honestly whether `balance`/`loyaltyPoints` are worth implementing for real or should be dropped rather than carried forward as dead columns.

## Repairs (`RepairJob`)

- **Current Implementation**: `DB.repairs[]`; real 5-state lifecycle (`Received→Diagnosing→Repairing→Ready→Delivered`, not strictly sequential); no technician-assignment field despite a `technician` role existing.
- **Business Rules**: `partsUsed[]` consumes Inventory (mirrors SaleItem's pattern); delete restores consumed parts; warranty-reopen is a real, distinct transition back into the cycle.
- **Relationships**: Many-to-1 Customer; many-to-many InventoryItem via nested `partsUsed[]`.
- **Expected Growth**: Similar profile to Sales — ongoing, unbounded, continuous operational volume (every repair job is a new row).
- **Reporting Requirements**: Turnaround-time analysis (`Received` to `Delivered` duration), revenue-by-repair, parts-consumption reporting — all need this table joined against Inventory and Customer.
- **Query Complexity**: Status-based filtering (the repairs board/kanban-style UI needs "all jobs in `Repairing`" instantly), date-range, customer history.
- **Performance Considerations**: Same write-amplification argument as Sales — a second unbounded, continuously-growing array sharing the same blob.
- **Offline Compatibility**: Not a live constraint (as above).
- **Migration Difficulty**: Moderate-high — `partsUsed[]` needs the same child-table treatment as `SaleItem`; the lifecycle's non-sequential nature (any status reachable from any status, warranty-reopen) must be preserved as free-form status transitions, not constrained by a stricter state machine than the code actually enforces today.

## Expenses (`Expense`)

- **Current Implementation**: `DB.expenses[]`; simple flat shape (`title`, `category`, `amount`, `date`, `note`); `paidTo`/`paymentMode` are dead demo-only fields, not real.
- **Expected Growth**: **Low volume** — a handful of entries per week/month, nowhere near Sales/Repairs' pace.
- **Reporting Requirements**: Expense-by-category summaries — a simple `GROUP BY`, low value from normalization purely for query-speed reasons given the small dataset size.
- **Query Complexity**: Low — mostly date-range and category filters, easily handled either way.
- **Performance Considerations**: Low growth means Expense contributes little to the whole-blob-rewrite problem on its own — but it still *pays* the cost created by Sales/Repairs' growth if everything stays in one blob.
- **Migration Difficulty**: Low — flat structure, small dataset, trivial migration.

## RecurringExpense

- **Current Implementation**: `DB.recurringExpenses[]`, distinct from Expense; generation is **100% manually triggered** (an "Apply This Month" button) — no scheduler exists.
- **Expected Growth**: Very low — a handful of templates per shop (rent, salary, etc.), essentially static.
- **Reporting Requirements**: None beyond listing the templates themselves.
- **Migration Difficulty**: Trivial — tiny, static dataset.

## Configuration (`DB.settings`)

- **Current Implementation**: One large, heterogeneous object — branding, licensing cache (out of scope), tax settings, backup schedule; several fields confirmed dead (`theme` actually lives in raw `localStorage`, bypassing this object entirely; `taxRate`/`showGST`/`receiptFooter` are never read anywhere).
- **Business Rules**: Tenant-level only, no per-user preferences.
- **Expected Growth**: Effectively static — new settings fields get added occasionally by feature work, but the *number of rows* never grows (it's one object per tenant, not a log).
- **Reporting Requirements**: None — this is configuration, not data to aggregate over.
- **Query Complexity**: Always a single "get everything for this tenant" read — never filtered, never joined, never searched.
- **Performance Considerations**: **The weakest case for normalization in this entire analysis.** A single, small, whole-object read/write is exactly what a JSON blob (or a JSON column on a single-row-per-tenant table) is good at — normalizing every individual setting into its own column would be real over-engineering for a shape that never needs a `WHERE` clause on an individual field.
- **Migration Difficulty**: Trivial either way — but the *right* choice here is arguably to keep it JSON, not to normalize it.

## Reports

- **Current Implementation**: Not a stored entity at all — the Cashbook and Dashboard "Recent Activity" views are both computed fresh, in JavaScript, from other entities at render time (Phase 1.5 confirmed these two "activity" views aren't even reconciled with each other).
- **Storage Decision**: None needed — whatever the underlying entities' storage model becomes, Reports are queries against them, not a stored thing of their own. Out of scope for a storage-strategy decision.

## Stock (`StockMovement`) — does not exist today

- **Current Implementation**: None. `InventoryItem.stock` is mutated in place from three call sites; only manual adjustments get an unstructured text line in `DB.auditLog`, and even that discards the user's stated reason (Phase 1.5 finding).
- **Business Rules if designed**: Would need to capture `productId`, quantity delta, reason/source (`sale`, `repair-parts`, `manual-adjust`, `product-delete-restore`), a reference back to whatever triggered it (`saleId`/`repairId`/nothing for manual), and a timestamp.
- **Expected Growth**: Would be the **highest-volume entity of all** if implemented — one row per stock-affecting event, likely several per Sale/Repair.
- **Reporting Requirements**: This is *specifically* what would let "why is this product's stock what it is" become answerable — a real, currently-missing capability, not just a storage-format question.
- **Query Complexity**: Needs a `product_id` index (for a single product's full history) and a `created_at` range index (for period reports).
- **Performance Considerations**: An append-only, ever-growing ledger is close to the textbook case for a real table with an index — a JSON array for this would immediately inherit Sales' exact write-amplification problem, on day one, at a *higher* row-creation rate than Sales itself.
- **Migration Difficulty**: N/A for existing data (nothing to migrate — there is no history to backfill, since it was never captured); moderate effort to build the write-paths that would populate it going forward (sale creation, repair parts consumption, manual adjustment, product deletion — the same four call sites already identified in `docs/architecture/DomainModel.md`).

## Payment — currently a value object, not an entity

- **Current Implementation**: Embedded `payments[]` on Sale/RepairJob, plus a wholly separate `DB.cashEntries[]` manual ledger — three unconnected representations of "money moved," reconciled only at render time by the Cashbook view (Phase 1.5 finding).
- **Business Rules**: Payment methods are inconsistent between contexts (Cash/UPI/Card for sale/repair collection; +Bank Transfer for manual cash entries only).
- **Expected Growth**: Scales with Sales+Repairs (most transactions have at least one payment) plus whatever volume of manual cash-book entries a shop makes.
- **Reporting Requirements**: A unified "all money movement" ledger is exactly what the Cashbook view is already trying, awkwardly, to reconstruct at render time today — a real `Payment`/`Transaction` table would let that become a straightforward query instead of a three-way in-memory merge.
- **Query Complexity**: Needs to answer "all payments for this sale/repair" and "all payments in this date range regardless of source" — the second query is essentially impossible to do efficiently against the current three-way-split model.
- **Performance Considerations**: Same write-amplification logic as Sale/Repair.
- **Migration Difficulty**: **Moderate-high, and the most design-sensitive migration in this whole analysis** — unifying three currently-separate representations (`Sale.payments[]`, `RepairJob.payments[]`, `DB.cashEntries[]`) into one table is a real design decision, not a mechanical extraction, since they don't share an identical shape today (cash entries have no `sale_id`/`repair_id` at all).

## Invoice — evaluated per the mission's "only if justified by current behavior" instruction

**Not justified as a distinct entity.** `docs/architecture/DomainModel.md` (Phase 1.5) already established that no Invoice document exists separately from Sale today — `viewInvoice()`/`printInvoice()` both read live from the Sale record at view/print time, and the only Invoice-specific stored data is the `invoiceNo` string already on Sale. Creating a separate `invoices` table now would be *inventing* structure the current behavior doesn't have, not extracting it — precisely what this whole reconstruction's methodology has consistently avoided. **Recommendation: no Invoice table. `Sale.invoice_no` remains the only invoice-related column.** If the business later decides it wants genuinely immutable, point-in-time invoice documents (a real gap — Sales are editable indefinitely today, per Phase 1.5/2's findings), that is a future business-rule decision requiring its own approval, not something to smuggle in as a byproduct of a storage-format migration.

## Cloud Backup — out of scope for this Operations Domain decision

Included in the mission's analysis list, but `docs/architecture/Architecture.md` (Phase 2) and `docs/architecture/DomainModel.md` (Phase 1.5) both already classify `CloudBackup` as an Administration-domain concern (the legacy desktop-to-cloud backup bridge, `server/local.js`'s `cloud_backups` table, admin-credential-gated) — not part of the tenant's live operational data at all. It stores a backup *of* the operations domain (as an opaque blob, by design — a backup should be a snapshot, not a live queryable structure), which is a completely different storage requirement than the live operational entities above. **No storage-strategy decision is needed for it here**; it remains exactly as it is, out of this phase's scope.
