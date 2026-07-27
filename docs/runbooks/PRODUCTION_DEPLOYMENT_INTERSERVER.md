# Production Deployment Guide — InterServer / DirectAdmin / Ubuntu / PM2

Deploys two independent Node.js applications on one InterServer VPS, both fronted by DirectAdmin's web server, on subdomains of `zmaxlab.site`:

| App | Purpose | Domain | Codebase | Internal port |
|---|---|---|---|---|
| Application 1 | Z-SUPERADMIN | `admin.zmaxlab.site` | `platform/` | `127.0.0.1:4100` |
| Application 2 | ShopERP | `erp.zmaxlab.site` | `server/` (entrypoint `local.js`) | `127.0.0.1:3000` |

**Assumptions, stated explicitly:**
- A fresh Ubuntu VPS from InterServer with DirectAdmin already licensed and installed (DirectAdmin's own installation is done by InterServer at provisioning — not covered here).
- You have root (or sudo) SSH access, and DirectAdmin admin/reseller access to create domains.
- The DirectAdmin system username used throughout is `zmaxlab` — substitute your actual account username everywhere it appears.
- DNS for `zmaxlab.site`, `admin.zmaxlab.site`, and `erp.zmaxlab.site` already points at this server's IP (an A record for each, or a wildcard) — DNS propagation is outside this guide's scope.
- DirectAdmin is running the common InterServer combo of Nginx (frontend, ports 80/443) reverse-proxying to Apache (backend) — the **Custom HTTPD Configuration** steps below target Nginx, since that's the layer that needs to proxy to Node instead of Apache for these two specific subdomains. If your installation is Apache-only (no Nginx), the equivalent Apache `mod_proxy` block is given as a fallback in step 7.
- Neither Node app is ever bound to a public interface — both listen on `127.0.0.1` only; DirectAdmin's web server is the only public-facing listener on 80/443.

---

## 1. Directory Structure

```
/home/zmaxlab/
├── domains/
│   └── zmaxlab.site/
│       └── public_html/
│           ├── admin/          # docroot for admin.zmaxlab.site — placeholder only,
│           │                   # ACME challenge files land here during SSL issuance;
│           │                   # the reverse proxy handles all real traffic.
│           └── erp/            # docroot for erp.zmaxlab.site — same role.
└── apps/
    ├── zsuperadmin/            # git clone of the platform/ codebase — the actual app
    │   ├── .env
    │   ├── platform.db
    │   ├── backups/
    │   └── logs/               # PM2 log destination for this app
    └── shoperp/                # git clone of the server/ codebase — the actual app
        ├── .env
        ├── shoperpro.db
        ├── backups/
        └── logs/
```

Two separate, independent directory trees under `apps/` — matching the two services' own "shares nothing at runtime" design (separate database files, separate env files, separate processes).

---

## 2. Prerequisites & System Packages

SSH in as the `zmaxlab` DirectAdmin user (or root, then `su - zmaxlab` for app-level steps):

```bash
ssh zmaxlab@<server-ip>
```

Confirm Ubuntu version (this guide targets 20.04/22.04/24.04 — all supported):

```bash
lsb_release -a
```

Update system packages:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git build-essential python3 sqlite3 curl
```

`build-essential` + `python3` are required so `better-sqlite3`'s native module can compile from source if InterServer's architecture/Node version doesn't have a matching prebuilt binary available — installing them up front avoids a confusing `npm install` failure later.

---

## 3. Install Node.js

Both apps require **Node.js 18 or later** (both use global `fetch`, unavailable before Node 18). Install Node 20 LTS via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # expect v20.x.x
npm -v
```

---

## 4. Install PM2

```bash
sudo npm install -g pm2
pm2 -v
```

---

## 5. Create the Directory Structure

```bash
mkdir -p /home/zmaxlab/apps
mkdir -p /home/zmaxlab/domains/zmaxlab.site/public_html/admin
mkdir -p /home/zmaxlab/domains/zmaxlab.site/public_html/erp
```

(If `zmaxlab.site` isn't yet a domain in DirectAdmin, add it first — **DirectAdmin UI → Account Manager → Domain Setup → Add Domain** → `zmaxlab.site`. This creates the `domains/zmaxlab.site/public_html` tree automatically; the `admin`/`erp` subfolders above are created by the Subdomain step in §7.)

---

## 6. Git Clone Both Applications

```bash
cd /home/zmaxlab/apps
git clone https://github.com/ivaryadav/ShopPro.git zsuperadmin-src
```

This clones the whole monorepo once; both apps live inside it as subdirectories. Point each app's working directory at its own subfolder rather than cloning twice (keeps one canonical checkout, avoids two independent clones drifting out of sync on `git pull`):

```bash
ls /home/zmaxlab/apps/zsuperadmin-src
# app/ docs/ platform/ server/ ...
```

Checkout the release tag:

```bash
cd /home/zmaxlab/apps/zsuperadmin-src
git checkout z-superadmin-v1.0.0
```

For PM2's working directories, reference the subfolders directly:

- Z-SUPERADMIN: `/home/zmaxlab/apps/zsuperadmin-src/platform`
- ShopERP: `/home/zmaxlab/apps/zsuperadmin-src/server`

---

## 7. npm Install

```bash
cd /home/zmaxlab/apps/zsuperadmin-src/platform
npm install --omit=dev

cd /home/zmaxlab/apps/zsuperadmin-src/server
npm install --omit=dev
```

If `better-sqlite3` fails to fetch a prebuilt binary for InterServer's architecture, it falls back to compiling from source using the `build-essential`/`python3` packages installed in §2 — this can take a minute or two; it is not a hang.

---

## 8. Environment Variables

### 8a. Z-SUPERADMIN (`platform/.env`)

```bash
cd /home/zmaxlab/apps/zsuperadmin-src/platform
cp .env.example .env
nano .env
```

Set:

```bash
PLATFORM_JWT_SECRET=<generate below>
PLATFORM_PORT=4100
PLATFORM_DB_PATH=/home/zmaxlab/apps/zsuperadmin-src/platform/platform.db
PLATFORM_ALLOWED_ORIGINS=https://admin.zmaxlab.site

# SMTP — optional; unset = emails logged, not sent
PLATFORM_SMTP_HOST=
PLATFORM_SMTP_PORT=587
PLATFORM_SMTP_USER=
PLATFORM_SMTP_PASS=
PLATFORM_SMTP_FROM=Z-SUPERADMIN <no-reply@zmaxlab.site>

# ShopERP adapter — internal loopback call, never the public domain
# (avoids an unnecessary round trip through Nginx/SSL for server-to-server calls)
SHOPERP_BASE_URL=http://127.0.0.1:3000
SHOPERP_ADMIN_PASSWORD=<the PLAINTEXT ShopERP admin password — see 8b, must match>

# Optional — defaults shown, leave unset to use them
EVENT_RETENTION_DAYS=180
WEBHOOK_DEAD_LETTER_RETENTION_DAYS=90
# PLATFORM_ALLOW_PRIVATE_WEBHOOKS — never set this in production.
```

Generate `PLATFORM_JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 8b. ShopERP (`server/.env`)

```bash
cd /home/zmaxlab/apps/zsuperadmin-src/server
cp .env.example .env
nano .env
```

Set:

```bash
JWT_SECRET=<generate below>
PORT=3000

# ADMIN_KEY = sha256 hash of the SAME plaintext password you put in
# SHOPERP_ADMIN_PASSWORD above (8a) — the adapter logs in with the
# plaintext via POST /api/admin/login; ShopERP checks it against this hash.
ADMIN_KEY=<sha256 hash — see command below>

# SMTP — all 5 required, boot fails loudly without them
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM=ShopERP Pro <no-reply@zmaxlab.site>

# Z-SUPERADMIN maintenance sync — internal loopback, real Platform API Key
# (create this key from the Z-SUPERADMIN UI AFTER Z-SUPERADMIN is up — see §14)
ZSUPERADMIN_BASE_URL=http://127.0.0.1:4100
ZSUPERADMIN_API_KEY=
```

Generate `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Generate `ADMIN_KEY` (choose a real, strong admin password first — replace `YourStrongPassword` below, and put that exact same plaintext into `SHOPERP_ADMIN_PASSWORD` in 8a):

```bash
echo -n 'YourStrongPassword' | shasum -a 256
```

Lock down both `.env` files:

```bash
chmod 600 /home/zmaxlab/apps/zsuperadmin-src/platform/.env
chmod 600 /home/zmaxlab/apps/zsuperadmin-src/server/.env
```

---

## 9. First Boot & Bootstrap Accounts

Boot each app once, directly (not via PM2 yet), to create the database schema and confirm no config errors:

```bash
cd /home/zmaxlab/apps/zsuperadmin-src/platform
node server.js
# expect: "Z-SUPERADMIN platform running: http://localhost:4100"
# Ctrl+C once confirmed
```

```bash
cd /home/zmaxlab/apps/zsuperadmin-src/server
node local.js
# expect the ASCII banner ending "Running" with no [MAILER]/[ADMIN_KEY] fatal errors
# Ctrl+C once confirmed
```

**Do not run `npm start` for ShopERP** — `server/package.json`'s `"start"` script points at `index.js`, a vestigial, out-of-sync Postgres implementation never actually developed or tested. The real, production entrypoint is `local.js`, via `npm run start:local` or `node local.js` directly — this is exactly what the PM2 config in §10 uses.

Create the first Z-SUPERADMIN Platform Owner account:

```bash
cd /home/zmaxlab/apps/zsuperadmin-src/platform
node scripts/createOwner.js owner@zmaxlab.site 'a-strong-password' 'Your Name'
```

---

## 10. PM2 Configuration

Create one ecosystem file covering both apps:

```bash
nano /home/zmaxlab/apps/ecosystem.config.js
```

```js
module.exports = {
  apps: [
    {
      name: 'zsuperadmin',
      cwd: '/home/zmaxlab/apps/zsuperadmin-src/platform',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      out_file: '/home/zmaxlab/apps/zsuperadmin-src/platform/logs/out.log',
      error_file: '/home/zmaxlab/apps/zsuperadmin-src/platform/logs/error.log',
      time: true,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'shoperp',
      cwd: '/home/zmaxlab/apps/zsuperadmin-src/server',
      script: 'local.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      out_file: '/home/zmaxlab/apps/zsuperadmin-src/server/logs/out.log',
      error_file: '/home/zmaxlab/apps/zsuperadmin-src/server/logs/error.log',
      time: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

Both apps read their real configuration from their own `.env` files via `dotenv`/manual parsing at boot — `env:` here only sets `NODE_ENV`, not secrets (secrets stay in `.env`, never in the PM2 config file, which is easier to accidentally expose via `pm2 describe`/logs).

`instances: 1` / `exec_mode: 'fork'` — **do not use PM2 cluster mode** for either app. Both use a single-file SQLite database via `better-sqlite3`; multiple Node processes writing to the same SQLite file is exactly the concurrent-writer hazard this architecture avoids by being single-process.

Create the log directories PM2 will write into:

```bash
mkdir -p /home/zmaxlab/apps/zsuperadmin-src/platform/logs
mkdir -p /home/zmaxlab/apps/zsuperadmin-src/server/logs
```

Start both apps:

```bash
cd /home/zmaxlab/apps
pm2 start ecosystem.config.js
pm2 status
```

Persist across reboots:

```bash
pm2 save
pm2 startup systemd -u zmaxlab --hp /home/zmaxlab
```

`pm2 startup` prints one `sudo env PATH=... pm2 startup systemd ...` command — copy and run exactly that printed command (it registers a systemd service for PM2 itself under this user, and its exact form depends on your Node install path).

---

## 11. Reverse Proxy — DirectAdmin Custom HTTPD Configuration

### 11a. Create the subdomains in DirectAdmin

**DirectAdmin UI → Account Manager → Domain Setup → `zmaxlab.site` → Subdomain Management → Add Subdomain:**
- `admin` (creates `admin.zmaxlab.site`, docroot `domains/zmaxlab.site/public_html/admin`)
- `erp` (creates `erp.zmaxlab.site`, docroot `domains/zmaxlab.site/public_html/erp`)

### 11b. Nginx reverse-proxy config (the common InterServer DirectAdmin combo)

DirectAdmin stores per-user custom Nginx server-block additions in one file, with sections delimited per domain:

```bash
sudo nano /usr/local/directadmin/data/users/zmaxlab/nginx.conf
```

Add (creating the sections if they don't already exist — DirectAdmin's own delimiter format):

```nginx
==== admin.zmaxlab.site ====
location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

==== erp.zmaxlab.site ====
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Regenerate the real vhost configs from these fragments and reload:

```bash
cd /usr/local/directadmin/custombuild
sudo ./build rewrite_confs
sudo systemctl reload nginx
```

**Do not hand-edit the generated vhost files directly** (e.g. under `/etc/nginx/conf.d/`) — DirectAdmin regenerates them from the fragment files above on the next `rewrite_confs`/domain change and silently discards direct edits.

### 11c. Apache-only fallback (no Nginx layer)

If this installation is Apache-only, the equivalent goes in the Apache custom-config fragment file instead:

```bash
sudo nano /usr/local/directadmin/data/users/zmaxlab/httpd.conf
```

```apache
==== admin.zmaxlab.site ====
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:4100/
ProxyPassReverse / http://127.0.0.1:4100/

==== erp.zmaxlab.site ====
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:3000/
ProxyPassReverse / http://127.0.0.1:3000/
```

```bash
sudo a2enmod proxy proxy_http    # if not already enabled
cd /usr/local/directadmin/custombuild
sudo ./build rewrite_confs
sudo systemctl reload apache2 || sudo systemctl reload httpd
```

---

## 12. SSL

DirectAdmin's built-in Let's Encrypt integration, per subdomain:

**DirectAdmin UI → SSL Certificates → Free & Automatic Certificate from Let's Encrypt** → select **both** `admin.zmaxlab.site` and `erp.zmaxlab.site` → **Save**.

This issues and installs the certificates, and DirectAdmin's own cron handles renewal automatically — no separate `certbot` cron job needed. Confirm both resolve over HTTPS afterward:

```bash
curl -Iv https://admin.zmaxlab.site/healthz 2>&1 | grep -E "SSL|HTTP"
curl -Iv https://erp.zmaxlab.site 2>&1 | grep -E "SSL|HTTP"
```

If DirectAdmin's Let's Encrypt tool isn't available (older CustomBuild without ACME support), fall back to `certbot --nginx` (or `--apache`) run manually per subdomain — but check the DirectAdmin UI first, since running certbot standalone alongside DirectAdmin's own SSL management can create two competing certificate sources for the same domain.

---

## 13. Firewall

InterServer/DirectAdmin installs typically include **CSF (ConfigServer Security & Firewall)**. Confirm it's active and only the necessary ports are open:

```bash
sudo csf -l | grep -E "^(TCP_IN|TCP_OUT)"
```

Expected inbound: `20,21,22,25,53,80,110,143,443,465,587,993,995,2222,2087,2096` (DirectAdmin's standard set) — **4100 and 3000 should NOT appear**, since both apps bind to `127.0.0.1` only and are never meant to be reached directly from the internet.

If CSF isn't installed and `ufw` is the firewall instead:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 2222/tcp   # DirectAdmin's own admin panel port
sudo ufw enable
sudo ufw status
```

Verify neither Node port is reachable externally (run from a different machine):

```bash
curl -m 5 http://<server-ip>:4100/healthz   # should time out / connection refused
curl -m 5 http://<server-ip>:3000           # should time out / connection refused
```

---

## 14. Connect the Two Apps (Maintenance Sync + Adapter)

With both apps running:

1. Log into `https://admin.zmaxlab.site`, complete MFA enrollment for the Owner account (required for the `OWNER` role).
2. **Settings → API Keys → Create API Key** — name it `shoperp-maintenance-sync`, grant it read access. Copy the raw key shown once.
3. Paste it into `server/.env`'s `ZSUPERADMIN_API_KEY`, then restart ShopERP: `pm2 restart shoperp`.
4. Confirm the sync: **Operations → System Health** in the Z-SUPERADMIN UI should show `shoperp` as `configured: true, reachable: true`, and after ~2 minutes:
   ```bash
   sqlite3 /home/zmaxlab/apps/zsuperadmin-src/server/shoperpro.db \
     "SELECT last_sync_status, last_synced_at FROM maintenance_cache WHERE id=1;"
   # expect: success|<a recent timestamp>
   ```

---

## 15. Database Locations

| App | File | Notes |
|---|---|---|
| Z-SUPERADMIN | `/home/zmaxlab/apps/zsuperadmin-src/platform/platform.db` | + `.db-wal`/`.db-shm` (WAL mode — normal, do not delete while running) |
| ShopERP | `/home/zmaxlab/apps/zsuperadmin-src/server/shoperpro.db` | + `.db-wal`/`.db-shm` |

Both are single SQLite files — no external database server to install or manage.

---

## 16. Backup Strategy

Both apps ship their own backup+integrity-check script. Run manually:

```bash
cd /home/zmaxlab/apps/zsuperadmin-src/platform && npm run backup:verify
cd /home/zmaxlab/apps/zsuperadmin-src/server && npm run backup:verify
```

Each writes a `.backup()`-API (WAL-safe) copy plus a `PRAGMA integrity_check` into that app's own `backups/` directory, and exits non-zero on any failure.

Schedule both daily via cron (as the `zmaxlab` user — `crontab -e`):

```cron
0 2 * * * cd /home/zmaxlab/apps/zsuperadmin-src/platform && /usr/bin/node scripts/backup-verify.js >> logs/backup.log 2>&1
15 2 * * * cd /home/zmaxlab/apps/zsuperadmin-src/server && /usr/bin/node scripts/backup-verify.js >> logs/backup.log 2>&1
```

Retention (30 days, adjust to your policy):

```cron
30 2 * * * find /home/zmaxlab/apps/zsuperadmin-src/platform/backups -mtime +30 -delete
30 2 * * * find /home/zmaxlab/apps/zsuperadmin-src/server/backups -mtime +30 -delete
```

**Off-host copies matter** — a local-disk-only backup doesn't survive a lost/failed disk. Add an off-host sync (rsync to another host, or an object-storage upload) after the nightly backup completes; not prescribed here since it depends on what off-host storage you have.

Also back up both `.env` files separately (they hold secrets, not part of the database):

```bash
sudo tar czf /root/zmaxlab-env-backup-$(date +%Y%m%d).tar.gz \
  /home/zmaxlab/apps/zsuperadmin-src/platform/.env \
  /home/zmaxlab/apps/zsuperadmin-src/server/.env
```
Store that archive somewhere encrypted and off-host, not in the repo.

---

## 17. Log Locations

| App | stdout/info | stderr/errors |
|---|---|---|
| Z-SUPERADMIN | `platform/logs/out.log` | `platform/logs/error.log` |
| ShopERP | `server/logs/out.log` | `server/logs/error.log` |

Also viewable live via PM2 directly:

```bash
pm2 logs zsuperadmin
pm2 logs shoperp
pm2 logs             # both, interleaved
```

PM2's own internal logs (its own process, not the apps):

```bash
~/.pm2/pm2.log
~/.pm2/logs/
```

Rotate PM2 logs (they grow unbounded otherwise):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
```

Neither app has structured/leveled application logging beyond a small number of deliberate `console.error` calls at genuine failure points — see each app's own `TROUBLESHOOTING.md`.

---

## 18. Restart Strategy

Routine restart (both apps handle `SIGTERM` gracefully already — Z-SUPERADMIN stops its 12 scheduled jobs first, ShopERP finishes in-flight requests):

```bash
pm2 restart zsuperadmin
pm2 restart shoperp
```

Zero-downtime is **not** available via `pm2 reload` for either app (that requires cluster mode, explicitly not used here — see §10) — a `restart` has a brief gap while the process comes back up. For a genuinely zero-downtime deploy, that's future work, not built into either app today.

Restart everything (e.g. after a server reboot, though `pm2 startup` + `pm2 save` already handle this automatically):

```bash
pm2 restart all
```

---

## 19. Update Procedure

```bash
cd /home/zmaxlab/apps/zsuperadmin-src

# 1. Back up first
(cd platform && npm run backup:verify)
(cd server && npm run backup:verify)

# 2. Pull the new version
git fetch --tags origin
git checkout <new-tag-or-branch>

# 3. Install any dependency changes
(cd platform && npm install --omit=dev)
(cd server && npm install --omit=dev)

# 4. Restart — schema migrations for both apps are additive-only and
#    run automatically on boot, no separate migration command needed
pm2 restart zsuperadmin
pm2 restart shoperp

# 5. Verify (see §20)
pm2 status
pm2 logs --lines 50
```

---

## 20. Rollback Procedure

Since both apps' schema changes have been additive-only throughout their history (new tables/columns, never a destructive `DROP`/`ALTER`), an older code version can safely run against a database a newer version has already migrated:

```bash
cd /home/zmaxlab/apps/zsuperadmin-src
git log --oneline -10                 # find the previous known-good tag/commit
git checkout <previous-tag-or-commit>
(cd platform && npm install --omit=dev)
(cd server && npm install --omit=dev)
pm2 restart zsuperadmin
pm2 restart shoperp
```

If a future schema change genuinely isn't backward-compatible, restore from the pre-update backup instead:

```bash
pm2 stop zsuperadmin
cp platform/platform.db platform/platform.db.bad-$(date +%Y%m%d%H%M%S)
cp platform/backups/<the-pre-update-backup>.db platform/platform.db
pm2 start zsuperadmin
```

(same pattern for `server/shoperpro.db` if needed).

---

## 21. Health Verification

After any start/restart/update, run all of these:

```bash
# Process status — both should show "online"
pm2 status

# Liveness (unauthenticated, bare)
curl -s https://admin.zmaxlab.site/healthz
curl -s https://erp.zmaxlab.site/api/license/status   # expects a 401 (no token) — proves it's answering, not down

# Z-SUPERADMIN's database + adapter connectivity
curl -s https://admin.zmaxlab.site/health

# Scheduler is genuinely running (not just the process being up)
sqlite3 /home/zmaxlab/apps/zsuperadmin-src/platform/platform.db \
  "SELECT job_name, status, started_at FROM platform_job_runs ORDER BY started_at DESC LIMIT 5;"

# Maintenance sync between the two apps (see §14)
sqlite3 /home/zmaxlab/apps/zsuperadmin-src/server/shoperpro.db \
  "SELECT last_sync_status, last_synced_at FROM maintenance_cache WHERE id=1;"

# TLS is actually terminating correctly
curl -Iv https://admin.zmaxlab.site 2>&1 | grep -E "SSL certificate|subject:"
curl -Iv https://erp.zmaxlab.site 2>&1 | grep -E "SSL certificate|subject:"
```

Expect: PM2 shows both `online` with low restart counts; `/healthz` returns `{"status":"ok",...}`; `/health` reports `platformStatus:"operational"`; the job-runs query shows recent, `success` rows; the maintenance-cache query shows `success` with a recent timestamp; both `curl -Iv` calls show a valid certificate for the correct hostname.

Finally, log into both UIs in a real browser (`https://admin.zmaxlab.site`, `https://erp.zmaxlab.site`) and confirm a real login succeeds end to end — automated checks above confirm the process and network path are healthy, not that the full application logic works from a user's perspective.
