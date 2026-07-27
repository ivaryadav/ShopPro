# Z-SUPERADMIN — Day-2 Operations

## Health checks

| Endpoint | Auth | Use |
|---|---|---|
| `GET /healthz` | none | Bare liveness probe — load balancer / uptime monitor. `{"status":"ok","uptime":<seconds>}`. |
| `GET /health` | none | Same idea, plus a real `SELECT 1` database check. `{"status":"ok"\|"degraded","service":"z-superadmin",...}`. |
| `GET /api/platform/health` | session or API key, `view_only` | The full operator view — database status, per-product-adapter reachability, every scheduled job's status, maintenance sync health, integration/webhook health, version info. This is what the System Health screen in the UI shows. |

`GET /api/platform/health`'s shape (fields that matter for external monitoring):

```json
{
  "platformStatus": "operational" | "degraded",
  "database": { "status": "ok" | "error" },
  "services": [ { "slug": "shoperp", "configured": true, "reachable": true, "checkedAt": "..." } ],
  "jobs": { "count": 12, "running": 0, "failing": 0, "jobs": [ /* one entry per job, see below */ ] },
  "maintenance": { "maintenanceActiveAnywhere": false, "syncSuccessRate": 100, "productsConnected": 1, ... },
  "integrations": { "eventsPublishedTotal": 42, "webhooksDelivered": 10, "failedDeliveries": 0, "retryQueueDepth": 0, "deadLetterCount": 0, "deliverySuccessRate": 100 },
  "version": { "platform": "1.0.0", "node": "v20.x.x", "uptimeSeconds": 12345 }
}
```

Wire an external monitor (Uptime Kuma, a cron+curl script, whatever you already use) to poll `/healthz` for liveness and `/api/platform/health` (with a real API key — see below) for the richer signal; alert on `platformStatus !== "operational"`, any `jobs.failing > 0`, or `integrations.deliverySuccessRate` dropping.

## The Job Runner

12 jobs run on their own interval inside the same process (no separate worker, no queue) — see `src/jobs/index.js`:

| Job | Interval | Purpose |
|---|---|---|
| `metric-snapshot` | 24h | Daily snapshot for Reports & Trends |
| `session-cleanup` | 15m | Revokes sessions past the idle/absolute timeout |
| `login-failure-retention` | 24h | Prunes old login-failure records |
| `maintenance-publish` | 1m | Activates scheduled maintenance windows whose start time arrived |
| `maintenance-expiry` | 1m | Expires active maintenance windows whose end time passed |
| `maintenance-sync-monitor` | 30m | Flags a product that hasn't pulled maintenance policy recently |
| `license-expiry` | 1h | Local-organization licenses: ACTIVE → READ_ONLY past `expires_at` |
| `grace-period` | 1h | Local-organization licenses: READ_ONLY → SUSPENDED past the grace window |
| `renewal-reminder` | 24h | Sends a renewal-reminder email for licenses expiring within 7 days (deduped) |
| `webhook-retry` | 1m | Retries pending webhook deliveries whose backoff window has elapsed |
| `dead-letter-cleanup` | 24h | Purges dead-lettered webhook deliveries older than 90 days |
| `event-retention` | 24h | Purges platform events older than 180 days |

All 12 start automatically on boot (`bootAllJobs()` in `server.js`) and stop cleanly on `SIGTERM`/`SIGINT`. View status: **Operations → Scheduled Jobs** in the UI, or `GET /api/platform/jobs`. Trigger one manually (needs `manage_platform_users`): the UI's "Run Now" button, or `POST /api/platform/jobs/:name/run`.

Adapter-backed organizations (ShopERP) are deliberately **not** touched by `license-expiry`/`grace-period` — ShopERP already runs its own equivalent sweep over its own `tenant_licenses`; duplicating that here would create two competing sources of truth.

## Graceful shutdown

`SIGTERM` or `SIGINT` (Ctrl+C, `systemctl stop`, a container stop) triggers: stop every job's timer → close the HTTP server → exit. No in-flight job execution or HTTP request is abruptly killed; the process waits for the server to finish closing before exiting. Verified manually against the real running instance for this release — see RC1 stabilization notes in [CHANGELOG.md](./CHANGELOG.md).

## Maintenance Mode

**Operations → Maintenance Center** in the UI (or `/api/platform/maintenance/*`). Z-SUPERADMIN is the sole source of truth; ShopERP (and any future product) pulls and caches the effective policy locally, continuing to enforce its last-known policy even if Z-SUPERADMIN becomes unreachable — a product never makes a live call to Z-SUPERADMIN on its own request path.

To take the whole platform down for real maintenance:
1. Maintenance Center → Overview → Emergency Controls.
2. Choose scope (platform-wide / one product / one organization), access level (read-only vs full lock), and a message.
3. Immediate/emergency mode takes effect the moment you submit — no publish delay. Scheduled mode waits for the `maintenance-publish` job (checks every minute).
4. Deactivate the same way, or let a configured end time expire it automatically.

Read-only mode blocks writes only; full lock blocks everything including login. See `docs/Architecture.md` for the full resolution precedence (emergency > organization > product > platform).

## Logs

No structured/leveled logging or log-shipping integration exists yet (a known, intentional gap for this release — see [RELEASE_NOTES_v1.0.md](./RELEASE_NOTES_v1.0.md#known-limitations)). All output goes to stdout/stderr:

- `systemd`: `journalctl -u zsuperadmin -f`
- Plain `node server.js`: whatever your shell/nohup redirected it to.
- A small number of deliberate `console.error` calls mark genuine failure points (a failed schema migration, an uncaught request error, an SMTP send failure, an Event Bus publish failure) — there is no debug/noise logging to filter through.

## Authentication & licensing sanity checks

- Log in as a real operator; confirm MFA challenge appears if your role requires it (`OWNER`/`SUPER_ADMIN` always do).
- **License Center** → pick a real organization+product → confirm its current plan/status/expiry render correctly.
- **Subscription Plans** (Settings → Integrations is unrelated; plans live under License Center / Business nav) → confirm the catalog (TRIAL/BASIC/PREMIUM/ENTERPRISE/LIFETIME) loads.

## Restart procedure

```bash
sudo systemctl restart zsuperadmin      # systemd
# or
pm2 restart zsuperadmin                 # pm2
```

Schema migrations, job registration, and everything else needed re-run automatically on boot — no separate steps required for a routine restart (see [DEPLOYMENT.md](./DEPLOYMENT.md#upgrade-procedure) for an upgrade, which is the same restart plus a `git pull`/`npm install` first).
