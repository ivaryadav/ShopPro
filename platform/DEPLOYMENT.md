# Deploying Z-SUPERADMIN to Production

Z-SUPERADMIN is a plain Node process (`node server.js`) with no build step and no external service dependencies beyond the SQLite file it creates itself. This document covers running it as a persistent, production-grade service.

## Network posture

Z-SUPERADMIN speaks plain HTTP only — it has no TLS support of its own. Run it behind a reverse proxy that terminates TLS, and bind the Node process itself to `127.0.0.1` (not `0.0.0.0`) so it is only reachable through that proxy:

```nginx
server {
    listen 443 ssl;
    server_name zsuperadmin.yourcompany.internal;

    ssl_certificate     /etc/letsencrypt/live/zsuperadmin.yourcompany.internal/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/zsuperadmin.yourcompany.internal/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`app.js` already sets `app.set('trust proxy', 1)` — rate limiting and IP-based audit logging correctly see the real client IP through the proxy's `X-Forwarded-For` header, not the proxy's own address.

This is an internal operator console, not a public-facing product — put it behind your VPN or a network ACL in addition to the reverse proxy; don't expose port 4100 (or 443 in front of it) to the open internet unless you have a specific reason to.

## Process management

Plain `node server.js` exits if it crashes and does not restart on boot. Use a real process supervisor.

### systemd (recommended for a Linux VPS)

`/etc/systemd/system/zsuperadmin.service`:

```ini
[Unit]
Description=Z-SUPERADMIN platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/zmax/platform
EnvironmentFile=/opt/zmax/platform/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
User=zsuperadmin
Group=zsuperadmin

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zsuperadmin
sudo systemctl status zsuperadmin
sudo journalctl -u zsuperadmin -f     # live logs
```

`systemctl stop`/`restart` send `SIGTERM`, which `server.js` already handles gracefully (stops every scheduled job, closes the HTTP server, then exits) — see [OPERATIONS.md](./OPERATIONS.md#graceful-shutdown).

### pm2 (alternative, if you already use it for other Node services)

```bash
pm2 start server.js --name zsuperadmin
pm2 save
pm2 startup   # follow the printed instructions to survive a reboot
```

## Secrets management

`.env` holds `PLATFORM_JWT_SECRET`, `PLATFORM_SMTP_PASS`, and `SHOPERP_ADMIN_PASSWORD` — real secrets. Do not commit it (it's already gitignored). File permissions:

```bash
chmod 600 /opt/zmax/platform/.env
chown zsuperadmin:zsuperadmin /opt/zmax/platform/.env
```

Rotating `PLATFORM_JWT_SECRET` invalidates every existing platform session (everyone is logged out) — expected, not a bug; there's no session store separate from the JWTs it signs.

## Upgrade procedure

Z-SUPERADMIN has no build step and no separate migration command to run by hand — every boot applies any new/changed schema via the same idempotent `CREATE TABLE IF NOT EXISTS` / additive `ALTER TABLE` pattern (`src/database/schema.js`), safe to run against an already-populated `platform.db`.

```bash
cd /opt/zmax/platform
node scripts/backup-verify.js          # 1. back up first — see BACKUP_AND_RESTORE.md
git pull                                # 2. pull the new version
npm install                             # 3. pick up any dependency changes
npm test                                # 4. confirm the new code passes on THIS machine
                                         #    (against disposable test DBs — safe to run anytime)
sudo systemctl restart zsuperadmin       # 5. restart — schema migrations run automatically on boot
sudo journalctl -u zsuperadmin -n 50     # 6. confirm a clean boot, no migration errors
curl http://127.0.0.1:4100/healthz       # 7. confirm it's actually serving requests
```

## Rollback procedure

Since schema changes are additive-only (new tables/columns, never a destructive `ALTER`/`DROP` in the history of this codebase), an older version's code can safely run against a database that a newer version has already migrated — it simply won't know about the new columns/tables and won't touch them.

```bash
cd /opt/zmax/platform
git log --oneline -5                    # find the previous known-good commit
git checkout <previous-commit-or-tag>
npm install                             # in case dependencies changed
sudo systemctl restart zsuperadmin
curl http://127.0.0.1:4100/healthz
```

If the new version's schema change genuinely isn't backward-compatible (has not happened yet, but if it ever does), restore `platform.db` from the pre-upgrade backup taken in step 1 above instead — see [BACKUP_AND_RESTORE.md](./BACKUP_AND_RESTORE.md#restoring).

## Versioning

`package.json`'s `version` field is the source of truth. This release is `1.0.0`. See [CHANGELOG.md](./CHANGELOG.md) for what shipped in each version and [RELEASE_NOTES_v1.0.md](./RELEASE_NOTES_v1.0.md) for this specific release.
