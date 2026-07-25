# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versioning per `docs/architecture/Versioning.md`.

## [Unreleased] — v2.0 Enterprise Reconstruction (in progress)

Tracked in `docs/adr/0001-enterprise-reconstruction.md`. Not deployed, not cut over — `v1.0.0` remains the released, running product throughout this work.

### Phase 2 — Identity & Tenant Core
- Added a MariaDB-backed, layered (routes/controllers/services/repositories) implementation of Tenant, Hosted User, Hosted Session, Trusted Device, Authentication, Authorization, and Role/Permission — parallel to, not replacing, `server/local.js`.
- Added `docs/adr/0006-table-driven-authorization.md`: a real `roles`/`permissions`/`role_permissions` schema, seeded to reproduce `local.js`'s exact 3 authorization gates.
- Extracted `generateBrowserMachineId()` and the `_api` session/auth-helper object from `app/ShopERP_Pro_v8.html` into `app/modules/auth.js` (`docs/adr/0004-incremental-frontend-modularization.md`). Added a static-file route in `local.js` so this loads correctly in hosted/browser mode, not just Electron.
- 151 new test assertions across 12 files (`server/src/tests/`), all passing; 8 database-integration assertions honestly skip (no credentialed MariaDB available in this environment).
- Zero behavior change to `server/local.js`'s business logic, `server/index.js`, or `app/ShopERP_Pro_v8.html`'s existing functions — the existing 436-assertion suite (`server/test/`) passes unmodified.

### Phase 1 — Foundations & Governance
- Git branching strategy (`main`/`develop`/`feature`/`refactor`/`release`/`hotfix`); resolved the historical `main`-vs-`master` default-branch divergence.
- Repository governance (`CODEOWNERS`, PR/issue templates, `SECURITY.md`, `CONTRIBUTING.md`).
- `server/src/` layered folder skeleton with real (not stub) config/logging/error-handling/MariaDB infrastructure.
- 5 ADRs (`docs/adr/0001`-`0005`).

### Phase 1.5 — Canonical Domain Model
- Extracted the actual business domain from the live implementation into `docs/architecture/{CanonicalDomainModel,DomainModel,EntityRelationship,BusinessRules,LifecycleDiagrams}.md`. Found 14 of 31 expected entities don't exist as distinct concepts (most notably: no Purchase/PurchaseItem entity at all; Invoices are not immutable, contradicting an initial assumption).

## [1.0.0] — released

SaaS licensing/registration/subscription system, security hardening (bcrypt migration, backdoor removal, enumeration fix, DevOps headers), independent Release Approval Board audit and remediation of its one Critical finding. See `docs/independent-audit/` and `docs/production-hardening/` for full detail.
