# Z-SUPERADMIN — Release Notes, Version 1.0

**General Availability.** Z-SUPERADMIN is the single operating console for the entire ZMAX ecosystem — the one place a founder or ops team runs the SaaS business, day to day, at real scale.

## What's in this release

**Run the business:**
- Organizations, licenses, and subscriptions for every product (ShopERP today) in one place.
- A real subscription plan catalog with device/user/storage limits, and a full license lifecycle: issue, renew, upgrade/downgrade, suspend, cancel, with grace periods and an expiration dashboard.
- A manual billing ledger — invoices, payments, credit notes, debit adjustments, and a live outstanding-balance figure. (No payment gateway yet — see Known Limitations.)
- A Business Dashboard, Renewal Center, and Reports (revenue trends, subscription growth, renewal success rate, customer lifetime, license distribution).

**Operate the platform:**
- System Health, a reusable Job Runner (12 scheduled jobs), and a full Security Center (MFA, sessions, API keys, password policy, audit log).
- Hybrid Maintenance Mode — publish a policy once here; every product keeps enforcing its own cached copy even if Z-SUPERADMIN is briefly unreachable.
- An Organization 360 workspace — notes, renewals, security history, subscription, billing, usage, and a unified activity timeline, all for one customer in one screen.

**Extend the platform:**
- A Platform Event Bus and Outbound Webhooks (HMAC-signed, retried, dead-lettered, replayable) — the real foundation future integrations (payment gateways, WhatsApp, CRM/accounting connectors) will plug into.
- A Public API foundation (`/api/public/v1`) reusing the same Platform API Keys.

## Known Limitations

These are deliberate scope boundaries for this release, not oversights:

- **No payment gateway integration.** Billing is entirely manual/operator-entered by design — Stripe/Razorpay/PayPal integration is explicitly future work the Event Bus and Webhooks are built to support.
- **No structured/leveled logging.** Output goes to stdout/stderr only; a handful of well-placed error logs mark genuine failure points. Adequate for the current operational scale; log aggregation is a natural next step, not built here.
- **SSRF protection on webhooks is hostname-pattern-based**, not DNS-rebinding-proof. A hostname that resolves safely when a webhook is created could theoretically be repointed at a private address before a later delivery. Full protection would re-resolve and re-validate at delivery time.
- **No composable/custom RBAC roles** beyond the 7 fixed platform roles (`OWNER`, `SUPER_ADMIN`, `ADMINISTRATOR`, `SUPPORT`, `BILLING`, `AUDITOR`, `READ_ONLY`).
- **Accessibility:** keyboard modal-dismissal and toast announcements are in place; most form inputs still rely on placeholder text rather than associated `<label>` elements. Adequate for an internal admin console; not WCAG-AA certified.
- **Single-node only.** No clustering, no horizontal scaling story — one process, one SQLite file. Correct for the current scale; a real constraint if that changes materially.

## Upgrade Notes

This is the first General Availability release — there is no prior published version to upgrade from. Future upgrades: see [DEPLOYMENT.md](./DEPLOYMENT.md#upgrade-procedure). Schema changes throughout this codebase's history have been exclusively additive (new tables/columns via idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`) — no destructive migration has ever shipped, and none is anticipated.

## Verification performed for this release

- Full regression: 278 platform assertions across 8 test suites, 0 failures. Full ShopERP server regression: 24 test files, 0 failures.
- `npm audit`: 0 vulnerabilities in both `platform/` and `server/`.
- Manual verification against real running instances: clean fresh boot, graceful `SIGTERM` shutdown, cross-instance maintenance sync, backup + restore round-trip (see [BACKUP_AND_RESTORE.md](./BACKUP_AND_RESTORE.md)).

## Thanks

This release represents the Platform Foundation plus Phases 5A through 5F plus two stabilization passes (RC1 and this GA prep), built and verified end-to-end against real running instances at every phase.
