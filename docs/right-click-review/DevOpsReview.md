# DevOps Production-Readiness Review — Phase 6

Status: **PASS, with pre-existing minor gaps documented honestly (unaffected by this change).** This repo already has a dedicated, recent deployment-readiness engagement (`docs/deployment/`) covering most of this phase's scope in depth — this review confirms none of it is disturbed by enabling the context menu, and spot-checks the header/caching/compression details that engagement didn't itemize individually.

## HTTPS

Unaffected — `server/local.js` doesn't terminate TLS itself; the app is designed to run behind a reverse proxy for HTTPS, per `docs/deployment/DeploymentChecklist.md`'s HTTPS section. A pure client-side JS change cannot affect the transport layer either way.

## Security headers — checked fresh, full inventory

Set on every response (`server/local.js:575-581`):

| Header | Value | Present? |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | ✓ |
| `X-Frame-Options` | `DENY` | ✓ |
| `X-XSS-Protection` | `1; mode=block` | ✓ (legacy header, harmless to keep for older browsers; modern browsers rely on CSP instead) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | ✓ |
| `Content-Security-Policy` | see below | ✓ |
| `Permissions-Policy` | — | **Not set (Low, pre-existing gap)** |
| `Strict-Transport-Security` | — | **Not set by the app (by design — see below)** |

None of these headers relate to `contextmenu`/right-click in any way — they govern framing, MIME-sniffing, referrer leakage, and script/style/connect sources, not mouse-button behavior.

**Finding (Low, pre-existing)**: no `Permissions-Policy` header is set. This header restricts access to browser features (camera, microphone, geolocation, etc.) that this app doesn't use anyway, so the practical risk is minimal, but adding a restrictive default (e.g. `camera=(), microphone=(), geolocation=()`) costs nothing and is a cheap defense-in-depth addition for a future pass. Not implemented here — would be a server-side config change, out of scope for a right-click-only change.

**Not a gap, a deliberate layering (already documented)**: `Strict-Transport-Security` is intentionally not set by `server/local.js` itself — HSTS only makes sense once TLS termination is in place, which this app deliberately delegates to the reverse proxy layer (`DeploymentChecklist.md`'s Reverse Proxy section). Setting it here without a guaranteed HTTPS front-end would be actively harmful (locking browsers into HTTPS-only for a host that might not have a cert yet). Correct as designed.

## CSP — full policy reviewed

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;
img-src 'self' data: blob: https://prod.spline.design https://app.spline.design;
media-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net;
connect-src 'self' https://prod.spline.design https://unpkg.com; worker-src 'self' blob:;
frame-ancestors 'none';
```
`frame-ancestors 'none'` independently reinforces `X-Frame-Options: DENY` (clickjacking defense, redundant-by-design for older-browser coverage). `'unsafe-inline'`/`'unsafe-eval'` on `script-src` are looser than an ideal CSP (a pre-existing, already-known tradeoff — this app has extensive inline `<script>` blocks and no build step to hash/nonce them) but this is **completely unrelated to right-click**: the CSP governs what scripts/styles/connections the *page* is allowed to load, not what the mouse can do. Enabling the context menu doesn't relax, tighten, or otherwise touch this policy.

## Compression / Caching

**Finding (Low, informational, pre-existing, unrelated to security)**: no `compression()` (gzip/brotli) middleware is applied — the ~2.4MB HTML file is served uncompressed on every request. This is a bandwidth/performance consideration (see `PerformanceReview.md`, Phase 7), not a security one, and entirely orthogonal to this change. `Cache-Control: no-cache, no-store, must-revalidate` is explicitly set on the main HTML response — correct and intentional, since the served page has already had license secrets stripped per-request and must never be served stale from a shared cache.

## Environment variables / Secret management

Unaffected — covered exhaustively in `docs/deployment/EnvironmentSetup.md` and `GitReadinessReport.md` from the prior engagement (mandatory `JWT_SECRET`/`SMTP_*`, `ADMIN_KEY` recommendation, `.gitignore` coverage, confirmed no secrets ever committed). Nothing in this change touches `server/.env`, `server/mailer.js`, or any config-loading code.

## Logging / Log rotation

Unaffected — `server/logger.js`'s structured console-based logging is untouched. No log-rotation mechanism exists today (an already-known gap, tracked since `OperationalReadinessPlan.md` in the original architecture-review engagement) — unrelated to this change.

## Monitoring / Health checks

Unaffected — `GET /health` (DB connectivity, migration-failure count, `adminKeyIsDefault` flag) is untouched by this change; it doesn't read or report anything about client-side UI restrictions.

## Backups / Restore testing

Unaffected — `server/scripts/backup-verify.js` and the backup schedule guidance in `DeploymentChecklist.md` are unrelated to client-side JS.

## Deployment process

Unaffected — no build step, no new dependency, no new env var, no new migration introduced by this change (contrast with the licensing-feature and deployment-readiness engagements, which did introduce all of those and were reviewed accordingly in their own reports). This is the simplest possible category of change from a deployment-process perspective: one file, no schema, no config, no restart-required-for-correctness beyond the normal "redeploy the updated HTML."

## Verdict

No DevOps/production-readiness regression from this change. Two pre-existing, Low-severity, already-partially-known gaps are restated here for completeness (missing `Permissions-Policy`, no response compression) — neither is security-critical, neither is affected by, nor a cause of, enabling the context menu. Proceeding to Phase 7.
