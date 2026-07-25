# Deployment Guide — `server/src/` (Phase 6)

**This describes how a future cutover phase would deploy `server/src/` — it does not itself deploy anything.** `server/local.js` remains the production server; nothing in this guide has been executed against production infrastructure.

## Current state

`server/src/app.js`'s `createApp({jwtSecret, allowedOrigins})` assembles a complete Express app covering Identity & Tenant Core (Phase 2) and the Operations Domain (Phase 4), rate-limited (Phase 6) and verified against a real MariaDB instance (Phase 6) — but never run anywhere outside test harnesses.

## Prerequisites

- A MariaDB instance (production: a managed service — RDS, Cloud SQL, PlanetScale, etc.; this phase validated against a disposable local Homebrew install, not representative of production infrastructure).
- Node.js (matching whatever version `local.js` currently runs under — not changed by this reconstruction).
- Every environment variable `server/src/config/env.js`'s `SPEC` declares as required — the app fails fast at boot if any are missing (`JWT_SECRET`, `DB_*`, etc.).

## Steps

1. **Provision the database.** Create a MariaDB database and a dedicated application user with privileges scoped to that database only (never reuse a shared/root credential in production — this phase's own validation used a dedicated, isolated instance for exactly this reason).
2. **Set environment variables**: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`, and any others `env.js` requires.
3. **Run schema migrations**: `npm run migrate:up`. Verify with `npm run migrate:status` — both `001_identity_tenant_core` and `002_operations_domain` must show as applied.
4. **Start the app** via `createApp({jwtSecret, allowedOrigins})` and a process manager of choice (this reconstruction has not built a dedicated `server/src/index.js` entrypoint yet — every phase so far has run this only inside test harnesses; a future phase would need to add one, matching `local.js`'s own bootstrap pattern).
5. **Verify `/health`** reports `db: 'ok'`.
6. **Do not repoint the frontend yet.** `app/ShopERP_Pro_v8.html` continues calling `local.js`'s endpoints until an explicit, separately-approved cutover decision — this reconstruction has never modified the frontend's actual API calls, only extracted shared, non-networking helper code (`app/modules/auth.js`, `app/modules/validation.js`).

## Data migration (existing tenants)

See `docs/architecture/ProductionReadinessChecklists.md`'s Deployment Checklist, and `docs/database/MigrationNotes.md`'s Phase 6 section for the full `migrateTenantData.js` CLI reference.

## Rollback

See `docs/architecture/ProductionReadinessChecklists.md`'s Rollback Checklist, and `docs/architecture/Runbook.md` for the operational procedure.

## What this guide deliberately does not cover

Licensing, Administration, and Cloud Backup domains (unported to `server/src/` — see `docs/architecture/ParityValidation.md`), load testing under production traffic, and the actual frontend cutover itself — all future, separately-scoped work.
