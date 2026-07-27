# Installing Z-SUPERADMIN

## Prerequisites

- **Node.js 18 or later** (the codebase uses global `fetch`, available without a flag from Node 18 onward — the ShopERP adapter, maintenance sync verification, and webhook delivery all depend on it). CI runs on Node 20.
- A C/C++ toolchain if `better-sqlite3`'s prebuilt binary isn't available for your platform/architecture (rare — prebuilt binaries cover all common combinations).
- Nothing else. No external database server, no Redis, no message queue — everything lives in one SQLite file (`platform.db`).

## 1. Install dependencies

```bash
cd platform
npm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. At minimum, set:

```
PLATFORM_JWT_SECRET=<a real random 64-char hex string>
```

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The process refuses to boot without this — see `src/config/env.js`. Everything else in `.env.example` is optional and defaults to a safe, fully-functional no-op (unset SMTP = emails are logged, not sent; unset `SHOPERP_BASE_URL` = the ShopERP adapter reports itself unconfigured and simply doesn't appear anywhere in the UI, rather than erroring).

## 3. First boot — creates the database and schema

```bash
npm start
```

On first run, `platform.db` (or whatever `PLATFORM_DB_PATH` points to) is created fresh and every table/index is applied — see `src/database/schema.js`. Every subsequent boot re-applies the same `CREATE TABLE IF NOT EXISTS` / additive `ALTER TABLE` migrations idempotently; this is safe to run against an existing database (see [OPERATIONS.md](./OPERATIONS.md) for the upgrade path).

Stop it once it prints `Z-SUPERADMIN platform running: http://localhost:4100` (Ctrl+C) — you need a Platform Owner account before logging in.

## 4. Create the first Platform Owner account

There is no default or seeded platform user, unlike ShopERP's `ADMIN_KEY` fallback — deliberately, since a platform managing every ZMAX product should never ship with a guessable default credential.

```bash
node scripts/createOwner.js owner@yourcompany.com 'a-strong-password' 'Your Name'
```

## 5. Start it for real and log in

```bash
npm start
```

Open `http://localhost:4100`, log in with the email/password from step 4. The `OWNER` role requires MFA (TOTP) — you'll be prompted to enroll (scan the QR code with any authenticator app) on your very first login before you can use anything else. Save the recovery codes shown at that point somewhere safe; they are shown exactly once.

## 6. (Optional) Connect the ShopERP adapter

If you're also running ShopERP's hosted server (`server/local.js`), set in `platform/.env`:

```
SHOPERP_BASE_URL=http://localhost:3000
SHOPERP_ADMIN_PASSWORD=<the real ShopERP admin password>
```

`SHOPERP_ADMIN_PASSWORD` is used only to authenticate the adapter's own calls against ShopERP's existing admin API — it is never stored beyond this env var, and never used to create or change any ShopERP account. Restart Z-SUPERADMIN; ShopERP's organizations, licenses, and health status now appear throughout the console.

## Verifying the install

```bash
npm run lint   # every file parses, including the inline superadmin.html script
npm test       # 8 suites, 278 assertions, all against disposable databases — never touches platform.db
curl http://localhost:4100/healthz   # {"status":"ok","uptime":...}
```

## Next

- [DEPLOYMENT.md](./DEPLOYMENT.md) — running this as a real, persistent production service.
- [OPERATIONS.md](./OPERATIONS.md) — day-2 operations once it's running.
