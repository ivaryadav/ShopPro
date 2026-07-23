# DevOps Audit — Independent Verification

## HTTPS / Reverse proxy

The app itself implements no TLS (`grep -n "https.createServer|tls\." server/local.js` → zero matches) — by design, per `docs/deployment/DeploymentChecklist.md`, which correctly documents that termination happens at a reverse proxy (Nginx example provided in `server/DEPLOY.md`) and that the app's own port must never be exposed directly to the internet. This is a standard, correct architecture for a single-process Node app. **Not independently re-verified**: whether any actual production host has this proxy correctly configured — that is an operational fact about a specific deployment, not something a repository audit can confirm from source code alone.

**Finding DO-1 (Low-Medium)**: `Strict-Transport-Security` (HSTS) is not set anywhere in `local.js`, and no deployment document explicitly instructs the operator to add it at the proxy layer (the checklist covers "confirm the app is never exposed on plain HTTP" and "obtain a certificate," but never names HSTS specifically). Recommend adding an explicit HSTS line item to `DeploymentChecklist.md`'s HTTPS section — its absence is invisible until someone runs a header scanner against the live site.

## Security headers

Independently re-verified live (via `devops-hardening.test.js`, re-run fresh during this audit): `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`, and `Content-Security-Policy` are all present on every response. Full detail and the CSP `unsafe-inline`/`unsafe-eval` caveat are in `IndependentSecurityReview.md` §7-8 — not repeated here.

## Compression

Independently re-verified live: gzip activates conditionally on `Accept-Encoding`, content round-trips byte-identical, JSON responses unaffected. `IndependentSecurityReview.md` §6.

## Caching

`local.js:1858-1860` sets `Cache-Control: no-cache, no-store, must-revalidate` / `Pragma: no-cache` / `Expires: 0` on the admin-facing HTML response path — appropriate for a page that must never be served stale from a shared cache. No caching headers were found on the main app HTML response (`app.get('/', ...)`) or on JSON API responses — for a single-page app served from one file, this means every request re-fetches the full (compressed) 2.4 MB payload rather than relying on browser/CDN caching with revalidation (e.g., `ETag`/`Cache-Control: no-cache` would still allow a conditional-GET 304). **Finding DO-2 (Low)**: no caching strategy at all for the main static asset — functionally correct (never serves stale data) but leaves a real, free performance win (conditional GETs, or at minimum a `Cache-Control: no-cache` + `ETag` pair) on the table, especially relevant given the file is 2.4 MB uncompressed.

## Secrets

Covered exhaustively in `RepositoryReview.md` and `IndependentSecurityReview.md` §1/§18/§19 — `server/.env` confirmed gitignored and untracked, no secrets in git history, one real hardcoded-default-hash fallback (`ADMIN_KEY`) flagged as High severity there. Not repeated here.

## Logging

`local.js` uses both raw `console.log`/`console.error` and a structured `logger` object (seen in calls like `logger.warn(...)`, `logger.error(...)` with a `meta` object — e.g. `local.js:93-95`, `655`). This is a slightly inconsistent logging story (two different logging idioms coexisting in the same file) but functionally fine — both ultimately write to stdout/stderr, which is the correct 12-factor-app pattern for a containerized/process-supervised deployment (let the process manager or log aggregator handle routing, don't manage log files inside the app). The one real logging finding (partial secret-hash printed to stdout at boot) is covered in `IndependentSecurityReview.md` §22/`CodeAudit.md`.

## Monitoring

`GET /health` (`local.js:649-674`) performs a real DB connectivity check (`SELECT 1`) and reports migration-failure counts, not just "process is alive" — independently confirmed by reading the handler, this is a genuine improvement over a naive static health check and is suitable for a real uptime monitor or orchestrator liveness/readiness probe. **No metrics/APM integration exists** (no Prometheus endpoint, no request-duration histograms, no error-rate counters beyond what ends up in plain-text logs) — for a single-instance deployment at this product's target scale (50-500 shop tenants), this is a defensible, proportionate omission rather than a real gap; it would become a real gap if the deployment ever needed to run more than one instance or diagnose intermittent performance issues without SSHing in to read logs by hand.

## Health checks

See Monitoring above — genuinely real, not a stub. Independently confirmed via direct code read, not inherited from a prior claim.

## Graceful shutdown — Finding DO-3 (Medium), previously unexamined

**No `SIGTERM`/`SIGINT` handler exists anywhere in `local.js`** (`grep -n "SIGTERM|SIGINT|process.on|server.close"` → zero matches). On a `docker stop`, `systemctl restart`, or any orchestrator-issued termination signal, the default Node.js behavior applies: the process is killed essentially immediately, with no opportunity to stop accepting new connections, drain in-flight requests, or cleanly close the SQLite handle. **Mitigating factor**: SQLite in WAL mode (confirmed enabled, `DatabaseAudit.md`) is specifically designed to tolerate abrupt process termination without corruption — the WAL file replays cleanly on next open — so the *data-integrity* risk from this gap is low. The *availability* risk is real but small: in-flight requests at the moment of a restart will receive a connection-reset rather than a clean response, which is a normal, generally-tolerated blip during a deploy for a product at this scale, but is nonetheless a real gap relative to "production-grade" hygiene. Recommend adding a standard `process.on('SIGTERM', () => server.close(() => process.exit(0)))` handler — small, low-risk, mechanical change.

## Backups / Restore

**Independently confirmed still true, not resolved by this or the prior engagement**: `server/scripts/backup-verify.js` exists and can *verify* a backup, but **no automated backup schedule exists** — no cron entry, no systemd timer, nothing in the repository actually triggers a backup on any interval. This was already honestly disclosed in `docs/deployment/DeploymentChecklist.md` ("Schedule this on a real interval (cron/systemd timer) — no automated backup schedule exists today") and in `ProductionReleaseApproval.md`'s residual-risk list. Independently re-confirmed accurate: this genuinely remains an operator responsibility to set up post-deployment, not something the codebase does for them. This is a real, material risk for a "customer data must never be deleted" product if an operator skips this step — flagged again here because a Release Approval Board should not let an important gap go unmentioned just because it was already named once before.

## Deployment

`docs/deployment/DeploymentChecklist.md` and `server/DEPLOY.md` (referenced but not independently re-read line-by-line in this pass — out of this review's time budget) describe a standard Node-behind-Nginx deployment with PM2/systemd-style process supervision implied but not concretely scripted (no `Dockerfile`, no `docker-compose.yml`, no systemd unit file, no PM2 ecosystem file exists in the repository). **Finding DO-4 (Low)**: deployment is entirely runbook-documentation-driven, not codified as infrastructure-as-code or a container image. This is a legitimate choice for a small-scale, single-operator-run product, but it does mean deployment consistency depends entirely on a human correctly following the checklist every time, with no automated verification that a given production host actually matches the intended configuration.

## Summary table

| # | Item | Verdict |
|---|---|---|
| DO-1 | HSTS not set, not documented | Low-Medium |
| DO-2 | No caching/ETag strategy on the main asset | Low |
| DO-3 | No graceful shutdown handler | Medium |
| DO-4 | No IaC/container/process-supervisor config committed | Low |
| — | No automated backup schedule | Medium-High (previously disclosed, independently reconfirmed still true) |
| — | Security headers, compression, health checks | **Confirmed genuinely implemented** |
| — | HTTPS/reverse-proxy architecture | **Confirmed correctly designed**, not independently verifiable at the infrastructure level from source alone |

None of these findings individually block a release; the backup-schedule gap is the most consequential given the product's own "never lose customer data" principle and should be treated as a same-week follow-up, not a someday item.
