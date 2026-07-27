# Z-SUPERADMIN

**Version 1.0** — the operating console for the entire ZMAX SaaS ecosystem (ShopERP today, future products via the same adapter pattern).

Z-SUPERADMIN is a completely independent Node/Express/SQLite service. It shares nothing at runtime with ShopERP or any other product: its own `package.json`, own database file, own JWT secret, own process, own port (default `4100`). It is the sole super-admin surface for the whole ecosystem — no product ships its own admin console.

## What it does

- **Product Registry** — every ZMAX product (ShopERP, and future ones) as configuration, not code.
- **Organizations** — every customer, across every product, in one place (Organization 360 Workspace: notes, renewals, security, billing, subscription, usage, activity timeline).
- **License Center & Subscription Center** — a real plan catalog, license lifecycle (issue/renew/suspend/cancel), grace periods, expiration dashboard.
- **Manual Billing Ledger** — invoices, payments, credit notes, debit adjustments, outstanding balance. No payment gateway yet — every entry is operator-recorded.
- **Platform Security** — MFA (TOTP), session management, API keys, password policy, security audit log.
- **Runtime Operations** — a reusable Job Runner with 12 scheduled jobs (metrics, cleanup, license lifecycle, maintenance, webhooks).
- **Platform Maintenance** — publish a maintenance policy once here; every product enforces its own locally-cached copy, continuing to work even if Z-SUPERADMIN is temporarily unreachable.
- **Integration Platform** — a Platform Event Bus, outbound webhooks (HMAC-signed, retried, dead-lettered, replayable), a Public API foundation (`/api/public/v1`), and an Integration Center.
- **Business Dashboard, Renewal Center, Reports** — the KPIs an operator actually runs the business from.

## Quick start

```bash
cd platform
npm install
cp .env.example .env   # fill in PLATFORM_JWT_SECRET at minimum — see INSTALL.md
npm start
```

Open `http://localhost:4100` — the UI is `public/superadmin.html`, a single static file with no build step.

## Documentation map

| Doc | Read this for |
|---|---|
| [INSTALL.md](./INSTALL.md) | Fresh installation, first boot, first login |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Running this in production — process management, reverse proxy, upgrade/rollback |
| [OPERATIONS.md](./OPERATIONS.md) | Day-2 operations — health checks, jobs, maintenance mode, logs |
| [BACKUP_AND_RESTORE.md](./BACKUP_AND_RESTORE.md) | Backing up `platform.db` and restoring it |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common problems and their fixes |
| [CHANGELOG.md](./CHANGELOG.md) | Phase-by-phase history of everything built |
| [RELEASE_NOTES_v1.0.md](./RELEASE_NOTES_v1.0.md) | What's in this release |
| [docs/Architecture.md](./docs/Architecture.md) | The durable architecture reference — directory layout, adapter pattern, non-negotiable principles |

## Tests

```bash
npm run lint   # syntax-checks every src/*.js and the inline superadmin.html script
npm test       # 8 suites, 278 assertions, against disposable in-process/child-process instances — never the real platform.db
```

Individual suites (`npm run test:foundation`, `test:security`, `test:business-operations`, `test:integration-platform`, etc.) are also runnable on their own — see `package.json`.

## License

Internal ZMAX platform component — not independently licensed for external distribution.
