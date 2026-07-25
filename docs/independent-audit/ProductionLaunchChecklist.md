# Production Launch Checklist — v1.0.0

This checklist covers what this release-management session actually verified and pushed (a source-code release to GitHub). It does **not** cover deploying that code to a specific live server — no live production host was provisioned or configured in this session, so several items below are operator action items for whichever machine actually runs this release, not facts this session can state. Filling those in with a plausible-looking placeholder would be worse than leaving them explicit — see `docs/deployment/DeploymentChecklist.md` for the step-by-step guide to complete them.

| Item | Value |
|---|---|
| **Version** | v1.0.0 |
| **Git commit** | `523546bbe0d866e94fc3a24c45c3343cfc39868d` |
| **Git tag** | `v1.0.0` (annotated, pushed to `origin`) |
| **Repository** | `https://github.com/ivaryadav/ShopPro.git` |
| **Branch pushed** | `master` (the project's actual development branch — a separate, unrelated single-commit `main` branch also exists on the remote; see note below) |
| **Rollback version** | `v1.0.0-rc1` (previous tag, `d634f25`) — see Rollback procedure below |
| **Production URL** | **Not applicable this session** — no live production host was deployed to. Fill in once the operator completes `docs/deployment/DeploymentChecklist.md` against a real server. |
| **Deployment date/time** | **Not applicable this session** — this is a source-release date, not a live-deployment date. Record the actual go-live timestamp here once a real server is running this tag. |
| **Backup verification** | `server/scripts/backup-verify.js` exists and can verify a backup file's integrity, but **no automated backup schedule ships with the product** — this is a known, previously-disclosed gap (`docs/deployment/DeploymentChecklist.md`'s Backups section). Confirm a real cron/systemd backup job is running against the actual production `DB_PATH` before treating any customer data as safe. |
| **Monitoring status** | `GET /health` (below) is the only built-in monitoring surface — no external APM/metrics integration ships with the product. Point an uptime monitor (or your orchestrator's liveness/readiness probe) at it. |
| **SMTP status** | **Mandatory at boot** — `server/local.js` fails to start if `SMTP_HOST/PORT/USER/PASS/FROM` are unset (this is intentional; verification-email delivery depends on it). Confirmed structurally via test suite; **actual delivery to a real inbox with production SMTP credentials was flagged in `docs/deployment/DeploymentChecklist.md` as something to test manually before relying on it** — do that before onboarding a first real customer. |
| **Health endpoint** | `GET /health` — returns `{status, mode, time, db, migrationFailures, startup:{jwtSecretConfigured}}`. `status` is `"ok"` only if the database is reachable and no migration failures occurred; otherwise `"degraded"`. (As of this release, it no longer reports whether the admin key is at its default value — that was a real information-disclosure gap fixed as part of this release; see `FinalBlockerResolution.md`.) |
| **Log location** | Plain structured JSON lines to stdout/stderr (`server/logger.js`) — there is no fixed log file path in the codebase. Where those lines end up (a file, `journalctl`, `docker logs`, a log-aggregation service) depends entirely on how the operator runs the process; confirm this is captured and retained before go-live. |
| **Support contact** | +91 94511 00556 (WhatsApp/call) — the contact baked into the application's own error messages and support screens for customers to reach the product owner. |

## Rollback procedure

If a regression is discovered in production after deploying `v1.0.0`:
1. Stop the running `server/local.js` process.
2. `git checkout v1.0.0-rc1` (or the last known-good tag) in the deployment directory.
3. `cd server && npm install` (dependencies may differ between tags).
4. Restart the process against the **same** `DB_PATH` — every schema change in this codebase's history is additive-only (new tables/columns, never destructive), so a rollback to an older code version against a newer database is safe by construction (confirmed in `docs/deployment/MigrationSafetyReport.md`; not independently re-verified again in this session, since no schema changed between `v1.0.0-rc1` and `v1.0.0`).
5. Restore from the most recent verified backup only if data corruption (not just a code regression) is suspected — do not restore an older backup for a pure code rollback, since that would discard legitimate customer activity.

## Note on the `main` branch

Fetching from `origin` during this release surfaced a `main` branch consisting of a single, unrelated "clean initial commit" — none of this project's actual development history is on it. `master` is unambiguously the project's real, active branch (every commit in this project's history lives there) and is what this release was built from and pushed to. `main` was left untouched; reconciling or deleting it was outside this release's scope and was not requested.

## Outstanding operator actions before real customer onboarding

1. Provision the actual production host and complete `docs/deployment/DeploymentChecklist.md` end to end (this session verified the code is ready to deploy; it did not perform an infrastructure deployment).
2. Schedule automated backups (Medium residual risk, disclosed in `ReleaseApproval.md`).
3. Send one real test registration through the wizard with production SMTP credentials to confirm actual email delivery.
4. Set `ALLOWED_ORIGINS` explicitly in the production environment (residual risk, disclosed in `IndependentSecurityReview.md` §9).
5. Set a custom `ADMIN_KEY` (do not run production on the default fallback hash).
