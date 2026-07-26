# Backlog — RC1 End-to-End Product Validation

Findings surfaced during the RC1 validation pass (2026-07) that do NOT meet the
pass's fix bar (critical bug, high-severity bug, data corruption, security
vulnerability, broken workflow, crash, production blocker). Recorded here per
that mission's explicit instruction, not silently dropped.

## HIGH — architectural, not a quick fix

### 1. `server/local.js`'s whole-blob `/api/data` model has a hard, worsening growth ceiling
A real, successful, long-running shop's entire dataset (inventory + sales +
customers + repairs + expenses + settings) is one JSON blob, re-sent in full
on every single save. Measured empirically: at realistic field sizes, this
blob crosses `express.json()`'s 5MB limit at roughly **15,000-20,000
accumulated sales** (less if the shop also carries a large inventory/customer
catalog). Once crossed, `PUT /api/data` starts failing with 413 on every
save attempt — a real shop doing 20-30 sales/day would hit this within 2-3
years of continuous, successful use, and the ceiling only gets worse over
time, never better. This is not a bug to patch (raising the body limit only
delays the same wall; the real fix is per-entity storage) — it is the exact
problem `server/src/`'s Operations domain (Phase 4) was built to solve. Not
fixed in this pass per "DO NOT: change architecture, change database design."
**Recommendation:** treat cutover to `server/src/` as a genuine business
deadline tied to real customer data growth, not just a technical nice-to-have.

### 2. No pagination on any `server/src/` list endpoint
`GET /api/inventory`, `/api/customers`, `/api/sales`, `/api/repairs` all
return the FULL tenant dataset in one response, unbounded. Measured: listing
50,000 sales for one tenant (a realistic per-tenant share of the mission's
500,000-sale target across 10 tenants) takes ~85ms server-side, but returns
a large (multi-MB) JSON payload the frontend would have to parse and render
in one pass — a real scalability concern well before it becomes a crash.
Not fixed here: adding pagination changes the API contract shape, explicitly
out of scope ("DO NOT... rename APIs unless required for parity").

## MEDIUM

### 3. `customers` listing has no covering index for its `ORDER BY name`
`EXPLAIN` on `customerRepository.listByTenant` shows `type: ALL` +
`Using filesort` — only `(tenant_id, phone)` is indexed, not
`(tenant_id, name)`. At 5,000 rows this costs ~6ms (negligible); flagged for
before it stops being negligible. A straightforward additive index, not
attempted here since this pass's scope is bug-fixing, not schema/performance
tuning beyond what a found bug required.

### 4. `sales` listing has the same filesort characteristic
`ORDER BY sale_date DESC, id DESC` is only partially covered by
`idx_sales_date(tenant_id, sale_date)`. Cost was ~85ms at 50,000 rows in
testing — acceptable today, worth revisiting alongside item #2 (pagination)
since both point at the same underlying need (bounded, indexed sales
listing) rather than two separate fixes.

### 5. `server/src/`'s global error handler returns 500, not 413, for oversized request bodies
Verified no information disclosure (server/src/'s `errorHandler` already
returns a clean, generic JSON message with no stack trace — this was
already correct before this validation pass). The status code itself is
just technically imprecise for this one error type; low value fixing in
isolation, unrelated to any of the actual bugs found this pass.

### 6. Real-outage failure mode: dead DB connection reused from the pool can stall a request for ~10s in a specific loopback-kill test scenario
Found via a live "kill the database process mid-request" test. Applied a
scoped `connectTimeout`/`socketTimeout` fix (`DB_CONNECT_TIMEOUT_MS`,
default 5000ms) to `server/src/`'s MariaDB pool — a correct, low-risk
improvement for genuinely slow/hung queries in general. However, the
specific "kill -9 the DB process on 127.0.0.1, then reuse a pooled
connection" scenario still measured a ~10.1s stall in this environment even
with the fix, most likely a macOS-loopback-specific TCP/socket-teardown
behavior beneath the driver's own timeout settings rather than something
code-level config can fully control — not confirmed to reproduce identically
against a real, network-separated database (a managed/remote MariaDB would
surface a dead peer differently, likely faster, via a real RST/ICMP
unreachable). Needs verification against a real non-loopback outage before
concluding the timeout tuning is sufficient on its own.
**Also affected:** the resulting error message ("Session expired. Please log
in again.") is genuinely misleading during a real infrastructure outage —
this exists identically in `server/local.js`'s own `requireAuth` (a
pre-existing characteristic inherited faithfully, not a new regression) and
in `server/src/`'s port of it. Fails safe (denies access, no security risk)
but is a real support-burden/confusion risk during any DB blip. Not changed
in this pass: touching either system's auth error-handling path for a
message-wording issue carries more risk than the benefit justifies here.

## LOW

### 7. No rate limiting on `local.js`'s or `server/src/`'s Cloud Backup endpoints
Documented already in `docs/architecture/Backup.md` from RC1 Sprint 3 —
repeated here only for backlog completeness. A deliberately preserved,
pre-existing `local.js` characteristic, not new.

### 8. `saleService.updateSale`'s compensating stock-revert-on-failure is best-effort, not transactional
This pass's concurrency fix (see CHANGELOG/Sprint N+1 report) reverts a
failed sale edit's partial stock changes via explicit compensating
increments/decrements rather than a real database transaction spanning
`saleRepository`/`inventoryRepository`/`stockMovementRepository` calls. In
the astronomically rare case where the compensating call ITSELF loses a race
(another request grabs the stock in the microseconds between the original
decrement and its revert), the revert could silently fail to fully restore
prior state. A real shared-transaction refactor across those three
repositories would close this completely but is a larger architectural
change than this pass's scope permits.

## Deferred features (explicitly out of scope for this validation pass)

- Bulk import, barcode scanning — frontend-only concepts in the current
  architecture (no corresponding endpoint in either `local.js` or
  `server/src/` to validate at the API level).
- Refunds as a distinct workflow — neither system has a dedicated refund
  endpoint separate from a manual sale edit/cancellation today.
