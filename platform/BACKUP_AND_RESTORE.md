# Backing Up and Restoring Z-SUPERADMIN

Everything Z-SUPERADMIN owns — organizations, licenses, subscriptions, invoices, security state, audit log, maintenance policy, platform events, webhook config — lives in one SQLite file (`platform.db` by default, path from `PLATFORM_DB_PATH`). Back up that one file and you have backed up the whole platform.

## Backing up

```bash
cd platform
npm run backup:verify
```

This runs `scripts/backup-verify.js`, which:

1. Opens the live database read-only.
2. Uses better-sqlite3's own `.backup()` API — the same WAL-aware mechanism as SQLite's own `.backup` CLI command, safe to run against a live database (a raw `cp` of a WAL-mode database file is **not** safe and can copy a torn, inconsistent state).
3. Writes the copy to `platform/backups/platform_manual_backup_<timestamp>.db`.
4. Opens the copy and runs `PRAGMA integrity_check` on it.
5. Exits `0` only if the check passed — exits `1` on any failure (source unreadable, write failed, or integrity check failed), so it's safe to use in a script: `npm run backup:verify || alert-on-call`.

Options:

```bash
node scripts/backup-verify.js --path /custom/path/platform.db --out /custom/backup/dir
```

### Scheduling it

This is an on-demand command, not one of the platform's own scheduled jobs (the Job Runner is reserved for Z-SUPERADMIN's own business logic, not host-level backup scheduling). Put it on your own cron or systemd timer:

```cron
# crontab -e — daily at 2am
0 2 * * * cd /opt/zmax/platform && /usr/bin/node scripts/backup-verify.js >> /var/log/zsuperadmin-backup.log 2>&1
```

Retain backups per your own policy (e.g. `find backups/ -mtime +30 -delete` for a 30-day retention) — this script does not prune old backups itself.

### Off-host copies

`backup-verify.js` only writes locally. Copy the verified backup file off-host afterward (rsync to another server, upload to S3/whatever object storage you use) — a local-disk-only backup doesn't protect against a lost/failed disk or host.

## Restoring

1. Stop Z-SUPERADMIN first — never restore into a file a running process has open.
   ```bash
   sudo systemctl stop zsuperadmin
   ```
2. Move the current (possibly corrupted/lost) database aside rather than deleting it outright, in case you need to inspect it later:
   ```bash
   mv platform.db platform.db.pre-restore-$(date +%Y%m%d%H%M%S)
   ```
3. Copy the verified backup into place:
   ```bash
   cp backups/platform_manual_backup_<timestamp>.db platform.db
   ```
4. Start it back up and confirm:
   ```bash
   sudo systemctl start zsuperadmin
   curl http://127.0.0.1:4100/healthz
   ```
   Then log in and spot-check: an organization you know existed, a recent audit log entry, System Health.

## Verifying a backup is actually restorable

Don't wait for a real incident to find out a backup is bad. Periodically:

```bash
cp backups/platform_manual_backup_<timestamp>.db /tmp/restore-test.db
PLATFORM_DB_PATH=/tmp/restore-test.db PLATFORM_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") \
  node -e "require('./src/database/connection').getDb(); console.log('opens and migrates cleanly');"
rm /tmp/restore-test.db
```

If that line prints cleanly with no errors, the backup is a genuinely valid, restorable database — this is exactly the check performed as part of this release's own verification (see [RELEASE_NOTES_v1.0.md](./RELEASE_NOTES_v1.0.md)).

## What is NOT backed up by this procedure

- `.env` (secrets) — back this up separately, encrypted, since it's not part of the database.
- Anything in ShopERP's own `shoperpro.db` — a completely separate system with its own backup procedure (`server/scripts/backup-verify.js`, `server/DEPLOY.md`).
