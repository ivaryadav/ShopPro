<!--
Drafted release notes for the v1.0.0 GitHub Release. The tag and branch are
already pushed to origin (https://github.com/ivaryadav/ShopPro.git). This
file's content is meant to be pasted directly into GitHub's "Draft a new
release" form for tag v1.0.0 (Releases -> Draft a new release -> choose
existing tag v1.0.0) since `gh` CLI is not available in this environment to
create it automatically. Everything below the horizontal rule is the actual
release body; this comment block is not part of it.
-->

**Release title:** ShopERP Pro v1.0.0

---

First production release of ShopERP Pro — ERP for Indian mobile-repair and mobile-phone shops, in both an offline single-machine desktop mode and a self-service, multi-tenant web/hosted (SaaS) mode.

## Highlights

- **SaaS Licensing & Subscriptions** — a full trial → basic → premium subscription lifecycle (`PENDING_APPROVAL → ACTIVE → READ_ONLY → SUSPENDED → ARCHIVED`), with automatic expiry-to-read-only, read-only-to-suspended, and suspended-to-archived transitions on a scheduled sweep.
- **Registration Workflow** — self-service shop signup with no license key required upfront; an admin reviews and approves (or rejects) each registration.
- **Email Verification** — signup requires a verified email address before a registration can be approved, via a secure, time-limited, single-use token.
- **Admin Approval** — a dedicated admin queue for reviewing, approving, rejecting, and assigning plans to new registrations, plus a full tenant-license dashboard for managing every shop's subscription (extend, suspend, reactivate, kill sessions, view audit history).
- **Trusted Devices** — per-plan device limits with auto-trust on first login under the limit, and admin controls to remove a device or reset a tenant's device list.
- **Subscription Lifecycle** — device-limit enforcement, offline-grace handling for the desktop product, and a full audit trail (`license_history`) of every status change, plan assignment, and admin action against a tenant.
- **Responsive Desktop + Tablet UI** — layout verified across desktop and tablet breakpoints.
- **Security Hardening** — bcrypt migration for admin authentication (from a legacy single-round SHA-256 comparison, with automatic, transparent upgrade on next login), removal of a hardcoded Super Admin Key backdoor, prevention of user-enumeration on login, and DevOps hardening (`Permissions-Policy` header, response compression).
- **Independent Security Audit** — a from-scratch, adversarial Release Approval Board review (architecture, security, code, database, API, UI, DevOps, and test-coverage audits — see `docs/independent-audit/`) that re-derived every finding directly from source rather than trusting prior reports, found one Critical authorization gap, and confirmed it fixed and regression-tested before this release.
- **Production Deployment** — a full deployment-readiness pass: hardened `.gitignore`, environment-variable documentation, database migration/rollback safety verification, and a deployment checklist for a reverse-proxy-fronted Node/SQLite deployment.

## What's fixed since the release candidate

An independent audit found that terminating or pausing a tenant through the legacy admin action didn't fully lock that tenant out of the product — two endpoints (listing users, adding staff) checked a different status column than the one the legacy action updated. This is fixed: there is now a single authoritative status source every protected endpoint gates on, kept in sync automatically, with a dedicated regression test that reproduces the exact scenario and is confirmed to fail against the pre-fix code and pass against the fix.

## Known limitations

- **No accessibility support** — the application has no ARIA attributes and minimal image alt-text coverage. Functional for sighted, mouse/touch users; not usable with a screen reader today.
- **CORS defaults to allow-all origins** if the `ALLOWED_ORIGINS` environment variable is left unset in a hosted deployment. Low practical risk today (the app authenticates via Bearer tokens, never cookies), but operators should set this explicitly in production.
- **No automated backup schedule** ships with the product — a backup-verification script exists, but scheduling actual backups (cron/systemd timer) is a deployment-time operator responsibility, documented in `docs/deployment/DeploymentChecklist.md`.
- **The offline desktop product's license check is client-side by design** — this mode has no server to keep a secret from the machine it runs on; a user with local access to their own installation can always self-modify their own local license state. This is an accepted, long-standing property of that specific product mode, not a defect in the hosted SaaS mode.
- A legacy admin credential fallback (a fixed default hash, used only if an operator never sets a custom admin password) still exists for backward compatibility; it is no longer exposed to unauthenticated callers, but operators should still set a custom `ADMIN_KEY` in production.

## Residual risk

- `nodemailer` (used for verification emails) has disclosed upstream CVEs in the currently-pinned version; a fix requires a breaking major-version upgrade, deferred to a follow-up release rather than introduced untested immediately before this tag.
- The Content-Security-Policy permits `'unsafe-inline'`/`'unsafe-eval'` for scripts, since the application ships as a single HTML file with no build/bundling step to hash or nonce inline scripts — a real, accepted tradeoff, not an oversight.
- The cloud-backup bridge endpoints authorize via a single shared admin credential rather than per-tenant ownership — a known limitation of a legacy backup feature, self-documented in the code as a candidate for a future per-tenant token model.

This release does not claim zero vulnerabilities — see `docs/independent-audit/ReleaseApproval.md` for the complete, itemized independent assessment (Critical/High/Medium/Low findings, what was fixed, and what remains open by informed choice).

## Future roadmap

- Retrofit accessibility (ARIA, keyboard navigation, alt text) across the UI.
- Tighten CORS to a required allowlist in hosted deployments; harden the cloud-backup bridge to per-tenant tokens.
- Upgrade `nodemailer` past its current CVEs.
- Set up automated, monitored backups as a standard part of the deployment checklist rather than an optional follow-up step.
- Consider fully unifying the two tenant-status representations (legacy `tenants.status` and the newer `tenant_licenses.status`) now that they're kept in sync, rather than maintaining two columns indefinitely.

## Full documentation

- `docs/architecture-review/` — SaaS licensing/registration architecture
- `docs/deployment/` — production deployment guide and checklist
- `docs/production-hardening/` — security hardening detail (Issues 1-4)
- `docs/independent-audit/` — the independent Release Approval Board's full audit, the one Critical finding it raised, and its resolution
