# Operations Domain — Implementation (Phase 4)

Converts the architecture approved in Phase 3 (`docs/adr/0008-operations-domain-storage-strategy.md`, `docs/database/OperationsSchemaDesign.md`) into real, production-quality code: migrations, repositories, services, controllers, routes, tests. **Does not redesign the domain and does not revisit ADR-0008** — every design decision below either implements what Phase 3 already approved, or documents a deliberate, narrow deviation where "preserve existing behavior" (this phase's overriding instruction) conflicted with a Phase 3 proposal that was never actually approved.

## Layers (ADR-0005)

```
routes/{inventory,customers,sales,repairs,expenses,settings}/  →  Express routing + middleware wiring
controllers/{inventory,customer,sale,repair,expense,settings}Controller.js  →  Request/response only
services/{inventory,customer,sale,repair,expense,recurringExpense,payment,settings}Service.js  →  Business rules
repositories/{inventory,customer,sale,repair,expense,recurringExpense,stockMovement,payment,settings}Repository.js  →  Persistence only
database/migrations/002_operations_domain.sql(+.rollback.sql)  →  10 real tables
```

Sale+SaleItem and Repair+RepairPart are each handled by ONE repository — a SaleItem/RepairPart has no independent lifecycle apart from its parent (confirmed: `local.js` never queries/creates one outside its parent), so the repository boundary matches the real aggregate, not a mechanical one-file-per-table split.

## What's implemented

- **Inventory** (`inventory_items`): create/update/adjust-stock/delete, exact IMEI-duplicate and sell-price-vs-cost-price validation from `saveProduct`/`updateProduct`, auto-generated SKU fallback, atomic stock increment/decrement SQL.
- **Customer** (`customers`): create/update, the real phone-duplicate warn-vs-block inconsistency reproduced via an explicit `allowDuplicate` parameter (see "Documented deviations" below).
- **Sale/SaleItem** (`sales`, `sale_items`): self-healing invoice numbering (`nextInvoiceNo`), hard stock validation before save, discount bounds, full item-replace on edit with stock restore-then-deduct, denormalized product-name/price snapshots preserved exactly.
- **Repair/RepairPart** (`repairs`, `repair_parts`): self-healing job numbering, part consumption/restoration against live stock, free status transitions across all 5 real states (including warranty-reopen back to `Repairing`), auto-calculated `final_cost = parts + labour` on every change, stock restored on job deletion.
- **Expense** (`expenses`) and **RecurringExpense** (`recurring_expenses`): create/delete, manual `applyForMonth` trigger identical to `applyRecurringExpenses` — **no scheduler**, explicitly out of scope.
- **StockMovement** (`stock_movements`, new): one row per stock mutation across all 4 real call sites (sale create/edit, repair parts consume/restore, manual adjust, product delete) — genuinely new capability, not an extraction (no current data to migrate).
- **Payment** (`payments`, new, unifying): `Sale.payments[]`, `RepairJob.payments[]`, and `DB.cashEntries[]` collapse into one table (`source_type` = sale/repair/manual). The per-context method restriction (`Cash`/`UPI`/`Card` for collection, `+Bank Transfer` for manual only) is enforced in `paymentService.js`, not the DB schema.
- **Configuration** (`tenant_settings`): stays JSON, per ADR-0008 — a thin `settingsService`/`settingsRepository` reads/writes the whole blob, matching `DB.settings`'s existing whole-object-replace semantics.

## API surface (new, necessary consequence of ADR-0008)

`local.js` has **no** per-entity REST endpoints for Operations data today — everything goes through one `GET/PUT /api/data` whole-blob path (the exact mechanism ADR-0008's decision was based on). Normalizing into real tables necessarily requires real per-entity endpoints; this is an approved consequence of Phase 3's decision, not new scope invented by this phase. Full endpoint list: `docs/architecture/API.md`.

## Documented deviations from Phase 3's design doc (none silent)

1. **`inventory_items` has no `is_deleted` column.** Phase 3's schema doc proposed soft-delete but explicitly flagged it as a "real decision, flagged for approval, not decided unilaterally" — it was never actually approved. Given this phase's overriding "preserve existing behavior" instruction, `deleteProduct` hard-deletes exactly as `local.js` does. `sale_items`/`repair_parts`/`stock_movements`' `product_id` FKs are `ON DELETE SET NULL` (nullable) so a hard delete doesn't destroy historical sales/repair rows — reproducing `local.js`'s actual behavior (deleting a product never touches old sales/repairs) under real FK constraints.
2. **Payment split-overpayment handling is simplified, not replicated byte-for-byte.** `local.js`'s `saveSale` has a real edge case: if a client's split-payment sum exceeds the invoice total, it silently falls back to charging the *entire* total in cash (`saveSale:10052-10056`). That's an artifact of client-side split-tracking arithmetic, not a deliberate business rule. `paymentService.validateCollectionPayments` instead rejects a payment set that exceeds the total with a clear `ValidationError` — a documented, deliberate simplification per the project's standing "if code and documentation disagree: document it, do not silently change behavior" principle.
3. **Sale/repair payment collection continues to allow only `Cash`/`UPI`/`Card`; manual cash-book entries allow `+Bank Transfer`.** The `payments.method` column is a single enum spanning all 4 values (a schema-level union, per Phase 3's own flag), but which methods are valid in which context is enforced in `paymentService.js` — preserving current behavior exactly without inventing a schema-level restriction that would need a different enum per context.
4. **Customer phone-duplicate handling reproduces BOTH of `local.js`'s two real, different code paths**, via an explicit `allowDuplicate` boolean: `saveCustomer`'s full "Add Customer" form warns then lets the user confirm through a duplicate phone (`confirm('...Add anyway?')`); `saveCustomerAndReturnToSale`'s quick-add-from-POS path hard-blocks with no override. A stateless REST API can't show a JS `confirm()` dialog, so the caller passes `allowDuplicate:true` to reproduce the "confirmed anyway" path, or omits it (default `false`) to reproduce the hard-block path.

## Explicitly NOT introduced (per the mission's own instruction)

Purchasing, Invoice immutability, a RecurringExpense scheduler, Repair technician assignment, an `invoices` table, SKU/phone uniqueness enforcement (neither exists in `local.js` today), and unification of the Payment method restriction across contexts.

## Frontend extraction

`app/modules/validation.js` — the shared field-validation helpers (`validatePhone`, `validateEmail`, `validateRequired`, `validateNumeric`, `validateGST`, `validateIMEI`, `runValidations`, `fieldErr`, `clearFieldErr`) used identically across all 6 in-scope areas. This is the one genuinely self-contained, DOM-and-argument-only layer in the Operations domain — every actual business-logic function (`saveProduct`, `saveSale`, `saveJob`, etc.) remains in the main script, unextracted, because each is entangled with the global `DB` blob, `saveDB()`, and page-specific mutable state (`saleItems`, `editSaleOriginalItems`, etc.); extracting any of them would require either dragging that entanglement into a module or restructuring it apart from what it depends on — exactly the redesign this phase's mission forbids. See `app/modules/validation.js`'s own header for the full reasoning.

## Deployment status

Same as Phase 2: not deployed, not cut over. `server/src/app.js` now mounts `/api/inventory`, `/api/customers`, `/api/sales`, `/api/repairs`, `/api/expenses`, `/api/settings` alongside the existing `/api/auth`/`/api/data` (users) routes from Phase 2. `local.js` and `app/ShopERP_Pro_v8.html`'s live Operations-domain behavior (the whole-blob `DB` object) are completely unchanged.
