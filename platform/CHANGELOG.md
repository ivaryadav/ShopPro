# Changelog

All notable changes to Z-SUPERADMIN. Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Everything below shipped under version `1.0.0` — this is a from-scratch build to General Availability, not a series of published pre-1.0 releases.

## [1.0.0] — Version 1.0 General Availability

### Platform Foundation
Z-SUPERADMIN built as a completely independent Node/Express/SQLite service — its own auth, own database, own process — replacing ShopERP's own removed Super Admin console. Adapter pattern (`src/adapters/`) for cross-product integration without any product knowing about any other. Product Registry, Organizations, License Center, Audit Log, Platform Users.

### Phase 5A — Platform Operations
Organization 360 Workspace (Internal Notes, Renewals, Security, Activity Timeline), System Health, Alerts & Notifications Center, Reports & Trends, UX modernization (command palette, nav regrouping, notification bell, breadcrumbs).

### Phase 5B — Platform Security
MFA (TOTP + QR, recovery codes, trusted devices, role-forced enrollment for `OWNER`/`SUPER_ADMIN`), Session Management, Platform API Keys, Password Policies, Security Center, Security Logs.

### Phase 5B.1 — Security Hardening
Adversarial security review of Phase 5B: fixed a timing-based user-enumeration vector and a missing password-policy validation gap that could allow self-lockout; added MFA-challenge lockout tracking and transaction wrapping around MFA state changes.

### Phase 5C — Platform Runtime Operations
The Job Runner framework — register/start/stop/run-now, retry handling, persisted execution history, graceful shutdown. First 3 jobs: Metric Snapshot, Session Cleanup, Login Failure Retention.

### Phase 5D — Platform Maintenance & Business Continuity
The Hybrid Maintenance Platform: Z-SUPERADMIN publishes maintenance policy (Global/Product/Organization scope, Scheduled/Immediate/Emergency mode, Read-Only/Full-Lock), every product pulls and caches it locally, continuing to enforce its last-known policy even if Z-SUPERADMIN becomes unreachable. 3 new jobs (Publish, Expiry, Synchronization Monitor) on the existing Job Runner. ShopERP-side `maintenanceSync.js`/`maintenanceGate`.

### Phase 5E — Business Operations
Subscription Center (a real plan catalog — device/user/storage limits, features, billing cycle — layered on the existing License Center), License Center extensions (key generation, dedicated timeline, grace countdown, expiration dashboard), Manual Billing Ledger (invoices, payments, credit notes, debit adjustments, live-computed outstanding balance), Organization 360 expansion (Subscription/Usage/Billing tabs), Business Dashboard, Renewal Center, Business Reports. 3 new jobs (License Expiry, Grace Period, Renewal Reminder).

### Phase 5F — Integration & Extensibility Platform
Platform Event Bus (13 business event types, immutable append-only log), Outbound Webhooks (HMAC-SHA256 signed, retried with backoff, dead-lettered, replayable), Integration Center, Public API Foundation (`/api/public/v1` — versioning, correlation IDs, standard error format, usage metrics, doc metadata, reusing existing Platform API Keys). 3 new jobs (Webhook Retry, Dead Letter Cleanup, Event Retention).

### Version 1.0 RC1 — Stabilization
Full cross-phase review (architecture, security, performance, database, accessibility, dependencies). Fixed:
- **Security:** nodemailer CVEs (all versions ≤9.0.0) via major-version bump; a webhook SSRF gap (URLs could target internal/private/link-local addresses).
- **Reliability:** a webhook-delivery race condition (concurrent retry + manual replay could duplicate an outbound delivery); a missing timeout on outbound webhook HTTP calls; a missing transaction around payment-recording + invoice-paid transition.
- **Performance:** a missing index supporting the renewal-success-rate report query.
- **Cleanup:** removed 2 fully-unreferenced dead repository files.
- **Accessibility:** keyboard (Escape) dismissal for every modal dialog; `aria-live`/`role` on toast notifications.

### Version 1.0 GA — Release Preparation
Production-readiness pass, no functional changes:
- Fixed `platform/package.json`'s `test` script — it only ran 1 of 8 test suites (41 of 278 assertions); now chains all 8, matching the established convention already used in `server/`.
- Added a `platform-test` CI job — `platform/` previously had **zero** CI coverage.
- Added `platform/scripts/backup-verify.js` (backup + integrity-check, mirroring `server/`'s established pattern) and a `backup:verify` npm script.
- Filled real gaps in `.env.example` (`SHOPERP_ADMIN_PASSWORD`, webhook/event retention vars, the RC1 SSRF test-bypass var were all missing).
- Added `engines.node >= 18.0.0` to `package.json` (the codebase relies on global `fetch`).
- Full documentation set: `README.md`, `INSTALL.md`, `DEPLOYMENT.md`, `OPERATIONS.md`, `BACKUP_AND_RESTORE.md`, `TROUBLESHOOTING.md`, this file, `RELEASE_NOTES_v1.0.md`.
