# API — Identity & Tenant Core (Phase 2) + Operations Domain (Phase 4) + Licensing Domain (RC1 Sprint 1)

Identity & Tenant Core paths match `server/local.js` exactly ("API compatibility preserved where possible"). The Operations domain endpoints below are **new** — `local.js` has no per-entity REST surface for this data at all (everything there goes through one `GET/PUT /api/data` whole-blob path); real per-entity endpoints are a necessary, approved consequence of ADR-0008's normalization decision, not new scope invented by this phase. All mounted by `server/src/app.js`, not by `local.js` — this is a parallel implementation, not yet cut over (`docs/architecture/Architecture.md`).

| Method | Path | Middleware chain | Notes |
|---|---|---|---|
| `POST` | `/api/auth/login` | `rateLimit(10, 5min)` | Mobile+PIN, optional `deviceId`. Anti-enumeration (`docs/security/Authentication.md`). |
| `POST` | `/api/auth/refresh` | `rateLimit(30, 5min)` | Rotates both tokens; grace window for multi-tab races. |
| `POST` | `/api/auth/logout` | `requireAuth` | Revokes the current session only. |
| `POST` | `/api/auth/heartbeat` | `requireAuth` | Updates `last_activity`/`current_page`. Legacy (no-`sid`) tokens get `{ok:true, legacy:true}`. |
| `GET` | `/api/auth/sessions` | `requireAuth, requireActive, requirePermission('sessions:view')` | Owner-only, matches `local.js:1069`. |
| `POST` | `/api/auth/sessions/:sessionId/revoke` | `requireAuth, requirePermission('sessions:revoke')` | Owner-only; 404 (not 403) if the session belongs to another tenant, matching `local.js:1078`'s deliberate choice not to confirm the ID exists. |
| `POST` | `/api/auth/add-staff` | `requireAuth, requireActive, requirePermission('staff:add')` | Owner-only. |
| `GET` | `/api/data/users` | `requireAuth, requireActive` | **No permission gate** — matches `local.js` exactly; path kept under `/api/data` for compatibility despite being Identity-domain data. |
| `GET` | `/health` | none | Reports DB connectivity (`checkDatabaseHealth`), not a static stub. |

## Operations domain endpoints (Phase 4, new)

All require `requireAuth(jwtSecret), requireActive` unless noted. `:id` params are the entity's own numeric ID (not the tenant-scoped invoice/job number).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/inventory` | List, tenant-scoped. |
| `GET` | `/api/inventory/:id` | 404 if not found or belongs to another tenant. |
| `POST` | `/api/inventory` | Matches `saveProduct` validation exactly. |
| `PUT` | `/api/inventory/:id` | Matches `updateProduct` exactly. |
| `POST` | `/api/inventory/:id/adjust-stock` | `{type:'add'\|'remove'\|'set', qty, note}` — matches `doAdjustStock` exactly. |
| `DELETE` | `/api/inventory/:id` | Hard delete, matches `deleteProduct` exactly (see `docs/architecture/Operations.md`'s deviation #1). |
| `GET` | `/api/customers` | List. |
| `GET` | `/api/customers/:id` | Single. |
| `POST` | `/api/customers` | `{..., allowDuplicate?}` — see Operations.md deviation #4. |
| `PUT` | `/api/customers/:id` | Same duplicate semantics as create. |
| `GET` | `/api/sales` | List. |
| `GET` | `/api/sales/next-invoice-no` | Preview the next self-healing invoice number without creating a sale. |
| `GET` | `/api/sales/:id` | Includes `items[]` and computed `paid` (summed from `payments`). |
| `POST` | `/api/sales` | Hard stock validation, discount bounds, optional `payments[]` (Cash/UPI/Card only). |
| `PUT` | `/api/sales/:id` | Full item-replace, stock restore-then-deduct, matches `updateSale` exactly. |
| `GET` | `/api/repairs` | List. |
| `GET` | `/api/repairs/:id` | Includes `partsUsed[]` and computed `paid`. |
| `POST` | `/api/repairs` | Optional advance `payments[]`, capped at `estimatedCost`. |
| `POST` | `/api/repairs/:id/parts` | `{productId, qty}` — merges into an existing part row, matches `addJobPart` exactly. |
| `DELETE` | `/api/repairs/:id/parts/:partId` | Restores the part's qty to stock, matches `removeJobPart` exactly. |
| `PUT` | `/api/repairs/:id/financials` | `{labourCharge}` — recalculates `final_cost`, matches `saveJobChanges` exactly. |
| `PUT` | `/api/repairs/:id/status` | `{status, deliveredDate?}` — free transition to any of the 5 states, matches `setJobStatus` exactly (warranty-reopen supported). |
| `POST` | `/api/repairs/:id/payments` | `{payments[], paymentDate}` — appends (not replaces), matches `collectRepairPayment` exactly. |
| `DELETE` | `/api/repairs/:id` | Restores every part's qty to stock, matches `deleteJob` exactly. |
| `GET` | `/api/expenses` | List. |
| `POST` | `/api/expenses` | Matches `saveExpense` exactly (title required, amount ≥ 0.01). |
| `DELETE` | `/api/expenses/:id` | Matches `deleteExpense` exactly. |
| `GET` | `/api/expenses/recurring` | List. |
| `POST` | `/api/expenses/recurring` | Create. |
| `PUT` | `/api/expenses/recurring/:id` | Update. |
| `PUT` | `/api/expenses/recurring/:id/active` | `{active}` — ON/OFF toggle. |
| `DELETE` | `/api/expenses/recurring/:id` | Delete. |
| `POST` | `/api/expenses/recurring/apply` | Manual "Apply This Month" trigger — matches `applyRecurringExpenses` exactly; **no scheduler calls this automatically**. |
| `GET` | `/api/expenses/cash-entries` | Manual cash-book entries (`payments` where `source_type='manual'`). |
| `POST` | `/api/expenses/cash-entries` | Matches `saveCashEntry` exactly — the only Payment context allowing `Bank Transfer`. |
| `GET` | `/api/settings` | Configuration — returns the whole JSON blob, matches `DB.settings`. |
| `PUT` | `/api/settings` | Whole-object replace, matches `PUT /api/data`'s semantics for `DB.settings`. |

## Licensing domain endpoints (RC1 Sprint 1)

| Method | Path | Middleware chain | Notes |
|---|---|---|---|
| `GET` | `/api/license/status` | `requireAuth` only | Matches `local.js:1152` exactly — deliberately no `requireActive` gate, since a suspended/archived tenant must still be able to check its own status. Response is `{license}` only — narrower than `local.js`'s (no outer legacy `tenants`-column fields; see `docs/architecture/Licensing.md`'s deviation #1). |

Every other Licensing action (`approveRegistration`, `rejectRegistration`, `assignPlan`, `startTrial`, `generateLicenseForTenant`, `extendLicense`, `suspendTenant`, `reactivateTenant`, `setDeviceLimit`, `listTenantLicenses`, `listPendingRegistrations`, `getHistory`) is a fully tested `tenantLicenseService` function with **no public route** — its real-world gate (`requireAdminKey`) is Administration domain, out of scope for this sprint. Same precedent as Phase 2's `resetPin`/`setActive`.

## Response shapes

Every response field name matches `local.js`'s exact JSON shape — see each route's controller (`controllers/authController.js`, `sessionController.js`, `userController.js`) for the literal object returned. Errors always follow `errors/errorHandler.js`'s shape: `{ error: { code, message, details? } }` — this is new (Phase 1), `local.js` returns a flatter `{ error: string }`; a client written against `local.js` would need updating for this once/if this system is ever actually deployed behind the same client. Not a concern for Phase 2 itself, since nothing is cut over yet — flagged here for whichever future phase does the cutover.

## Not implemented in this phase

`POST /api/auth/register`, `POST /api/auth/signup`, `POST /api/auth/renew-license`, `POST /api/admin/reset-user-pin`, `POST /api/admin/toggle-user` — see `docs/architecture/Architecture.md`'s "explicitly NOT implemented" section for why each is out of scope.
