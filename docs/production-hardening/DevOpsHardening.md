# DevOps Hardening — Issue 4

Status: **Implemented.** Both gaps flagged in the prior right-click-focused engagement (`docs/right-click-review/DevOpsReview.md`) are now closed.

## Permissions-Policy header

Added alongside the existing security headers in `server/local.js`:
```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()
```
This app never requests camera, microphone, geolocation, payment, USB, or motion-sensor access anywhere — a fully locked-down default costs nothing functionally and closes off a class of feature-hijack via any future injected or embedded content. `interest-cohort=()` additionally opts out of Google's FLoC/Topics tracking cohort assignment, a standard inclusion with no relevance to this app's own functionality either way.

## Response compression

Added `compression` (gzip/brotli negotiation) as a new Express middleware, applied globally, right after the security-headers middleware and before the JSON body parser. The main HTML response (~2.4MB uncompressed) is now served gzip-compressed to any client that accepts it — a substantial bandwidth reduction with zero functional change; JSON API responses pass through the same middleware transparently and are unaffected in content, only optionally smaller in transit.

## Verification — no CSP or header regression

Every pre-existing security header was re-checked byte-for-byte after this change:

| Header | Before | After |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | `nosniff` (unchanged) |
| `X-Frame-Options` | `DENY` | `DENY` (unchanged) |
| `X-XSS-Protection` | `1; mode=block` | `1; mode=block` (unchanged) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | `strict-origin-when-cross-origin` (unchanged) |
| `Content-Security-Policy` | full policy (see below) | **byte-identical**, not touched |
| `Permissions-Policy` | *(absent)* | **new**, as above |

The CSP string itself — `default-src`, `script-src` (including the `unpkg.com` allowlist), `style-src`, `img-src` (including the `spline.design` allowlist), `connect-src`, `worker-src`, and `frame-ancestors 'none'` — was not edited at all; compression is purely a transport-encoding concern (how bytes travel over the wire) and has no relationship to what a browser is permitted to load or execute, so there was never a mechanism by which it could regress the CSP.

## Dependency note (found incidentally, not part of Issue 4's scope)

Adding the `compression` package triggered a fresh `npm audit`, which surfaced **3 pre-existing vulnerabilities unrelated to `compression` itself** (confirmed via `npm ls`):
- `body-parser` (Low) — a transitive dependency of `express`, already present before this change.
- `brace-expansion` (High) — a transitive dependency of `nodemon`, a **devDependency only**; it never runs in production.
- `nodemailer` (High, several CVEs) — already present from the earlier SaaS-licensing engagement.

`compression@1.8.1` itself has zero known vulnerabilities. None of these three are fixed here — they're outside the 4 listed issues for this hardening pass, and the available `nodemailer` fix is a breaking major-version upgrade, which is not something to introduce silently right before tagging a release. **Carried forward explicitly as a residual-risk item in `ProductionReleaseApproval.md`**, not swept under the rug.

## Verification

New regression test: `server/test/devops-hardening.test.js` (19 assertions) — confirms the `Permissions-Policy` header's exact directives, every pre-existing security header is unchanged, the full CSP string is unchanged, gzip compression activates only when the client accepts it, and — critically — that the compressed response decompresses back to byte-identical content and that JSON API responses still parse correctly through the same middleware.
