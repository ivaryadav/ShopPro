# ShopERP Pro

Professional ERP for Indian mobile-phone repair/retail shops — Inventory, Sales/POS, Repairs, Customers, Expenses, and Configuration — shipping in two product modes from one shared frontend (`app/ShopERP_Pro_v8.html`):

- **Offline Desktop (Electron)** — `main.js` loads the app locally; all data lives in the browser/Electron process's own storage; license activation is validated entirely client-side. No internet connection required. This is the released `v1.0.0` product.
- **Hosted/Web (`server/local.js`)** — the same frontend served over a network, backed by SQLite, with mobile+PIN login, JWT sessions, and a SaaS licensing/registration/subscription system. This is the real, running, production server.

## Status: v2.0 Enterprise Reconstruction in progress

This repository is mid-way through a phased architectural reconstruction (`docs/adr/0001-enterprise-reconstruction.md`) — moving the hosted backend onto MariaDB with a real layered architecture (`server/src/`), built and verified in parallel to the production system with zero behavior change so far. **`server/local.js` remains the actual running production server** until an explicit, separately-approved cutover phase. See `docs/architecture/Architecture.md` for the full current state and `CHANGELOG.md` for a phase-by-phase history.

## Running it

**Desktop (Electron):**
```
npm install
npm start
```

**Hosted/Web server:**
```
cd server
npm install
cp .env.example .env   # fill in JWT_SECRET, ADMIN_KEY, SMTP_* — see comments in the file
npm run start:local
```

**New MariaDB-backed backend (`server/src/`)** — not yet a standalone deployable service; see `docs/architecture/DeploymentGuide.md` for its current status and how a future cutover phase would run it, and `npm run migrate:up`/`migrate:status` (from `server/`) for its migration tooling.

## Tests

```
cd server
npm test        # the original, production-facing suite (server/test/) — 436 assertions
npm run test:src  # the new server/src/ layered-architecture suite — mocked by default,
                  # or against a real MariaDB instance via TEST_DB_HOST/PORT/USER/PASSWORD/NAME
npm run lint     # syntax-checks every server/*.js and app/*.html inline script
```

## Documentation map

- `docs/architecture/` — Architecture, ERD, API, Business Rules, domain model, and every phase's review.
- `docs/adr/` — Architecture Decision Records (index in `docs/adr/README.md`).
- `docs/database/` — ERD, migration notes, schema design.
- `docs/security/` — Authentication, tenant isolation, and the standing security review.
- `docs/independent-audit/`, `docs/production-hardening/` — the pre-reconstruction v1.0.0 audit and hardening history.

## License

Proprietary — see `package.json`'s `license` field (`UNLICENSED`).
