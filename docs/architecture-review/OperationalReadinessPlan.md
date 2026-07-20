# Operational Readiness Plan

Recommendations only, per this task's scope ("no implementation unless risk is LOW"). Current state for each area verified directly against source, not assumed.

## 1. Health monitoring

**Current state**: `GET /health` (`server/local.js:253-255`) returns a static `{status:'ok', mode:'sqlite-local', time}` — it does not check anything, it's reachable if and only if the Express process is alive and listening. No dependency check (DB connectivity), no metrics, no readiness-vs-liveness distinction.

**Gap**: a genuinely stuck or DB-locked server (see `FailureScenarioReport.md`'s "DB unavailable" scenario) would still report `{status:'ok'}` on `/health` while every real request fails.

**Recommendation**: extend `/health` to run a trivial `db.prepare('SELECT 1').get()` and report `{status:'ok'|'degraded', db: 'ok'|'error', ...}`. This is genuinely low-risk (read-only, additive field, doesn't change the response shape anyone currently depends on) — flagging it as implementable now if wanted, but not done unprompted in this pass since the task's primary instruction is "generate recommendations."

## 2. Startup validation

**Current state**: `JWT_SECRET` is validated and fails loudly if missing (this engagement's own earlier work). Nothing else is validated at startup — not `ADMIN_KEY` (silently falls back to a hardcoded default if unset, per `server/local.js`'s existing fallback), not whether `DB_PATH`'s directory is writable, not port availability beyond Node's own `EADDRINUSE` crash.

**Gap**: an operator who forgets to set `ADMIN_KEY` gets a working server with a *known, hardcoded* admin password hash — silently. This is arguably a bigger real-world risk than the `JWT_SECRET` gap that was already fixed, since a hardcoded admin key is a fixed target, not a randomized one.

**Recommendation**: warn loudly (not necessarily fail — `ADMIN_KEY` unset is a legitimate default for local single-shop use) if `ADMIN_KEY` is using the hardcoded fallback, matching the pattern already used for the `DB_PATH` non-default warning. Verify `DB_PATH`'s parent directory exists and is writable before calling `new Database(DB_PATH)`, with a clear error instead of whatever `better-sqlite3`'s own error message says.

## 3. Backup verification

**Current state**: `sqlite3 <db> ".backup <copy>"` is used, manually, by this engagement's own migration work, verified each time via `PRAGMA integrity_check`. **No automated, scheduled server-side backup exists at all** — confirmed via `grep -n "setInterval"` across `local.js`: only the rate-limit-bucket cleanup (5 min) and session cleanup (30 min) intervals exist. Nothing backs up `shoperpro.db` automatically. (The *client's* `initAutoBackupTimer()` in `app/ShopERP_Pro_v8.html` is a separate, browser-side, per-shop-owner feature — it downloads a backup file to the user's own machine, unrelated to server-side database backup.)

**Gap**: if the server's disk fails, or the file is corrupted, or someone runs a destructive command against `shoperpro.db` directly, there is no automatic recent backup to restore from — only whatever an operator happened to take manually.

**Recommendation**: a scheduled job (e.g., daily) that runs `.backup` to a rotating set of dated files, with old backups pruned after N days. This is a genuinely new operational capability, not a "fix" — flagging as the most valuable single addition in this whole plan, but explicitly **not implemented here**, since "new scheduled job" is a bigger surface than "risk is LOW" comfortably covers on its own judgment, and deserves its own explicit go-ahead given it involves disk I/O and retention policy decisions (how many days, where to store them, disk space assumptions).

## 4. Structured logging

**Current state**: `console.log`/`console.error` with human-readable strings throughout `server/local.js` — no JSON structuring, no log levels, no request IDs, no correlation between a request and its resulting log lines.

**Gap**: at real operational scale, grepping free-text console output is the only way to investigate an incident. Fine for a single shop's own server, painful for anything larger.

**Recommendation**: not urgent at the product's current realistic scale (flagged the same way in the original `ProductionReadinessReview.md`). If pursued, the lowest-risk path is wrapping the existing `console.log`/`console.error` call sites with a thin structured-log helper (timestamp, level, message, optional metadata object) rather than introducing a logging framework dependency — consistent with this project's established no-new-dependency posture for infrastructure code (`server/scripts/lint.js`, the rate limiter, and the session-cleanup job all follow this same "write it directly" pattern rather than pulling in a package).

## 5. Alerting strategy

**Current state**: none. A crashed process, a failed migration, a full disk — nothing notifies anyone. The only signal is the process no longer responding.

**Gap**: real, but the appropriate response depends entirely on how this is actually operated (a single shop's own PC vs. a hosted multi-tenant deployment someone is on-call for) — a decision this document shouldn't make unilaterally.

**Recommendation**: for the realistic current deployment model (a shop's own always-on PC), a simple approach — a systemd/launchd service definition with automatic restart-on-crash, plus the structured logs from #4 feeding into whatever the operator already watches — covers most of the practical risk without introducing a new monitoring stack. Full alerting (PagerDuty-style) is disproportionate to this product's current scale and not recommended until there's a genuine on-call operation to alert.

## 6. Corruption detection

**Current state**: `PRAGMA integrity_check` is used manually, by this engagement, immediately after taking a backup, during migrations. It is not run automatically at any point — not at startup, not periodically.

**Gap**: silent corruption (disk-level bit rot, an interrupted write during a power loss) wouldn't be noticed until something visibly breaks.

**Recommendation**: run `PRAGMA integrity_check` once at server startup (cheap for a database this size — confirmed: the current `shoperpro.db` is well under a size where this would meaningfully delay boot) and log the result. This is genuinely low-risk (read-only pragma, additive) — flagging as implementable now if wanted, not done unprompted here for the same reason as #1.

## 7. Recovery procedures

**Current state**: this engagement has produced real, tested, specific rollback documentation for every change it made (`RollbackPlan.md`, `RollbackInstructions.md`, `OrphanCleanupRollback.md`) — genuinely proven, not just written, since the backfill migration actually exercised backup→execute→verify. What doesn't exist is a *general-purpose* runbook — "the server won't start," "a tenant reports missing data," "the disk is full" — independent of any specific migration.

**Recommendation**: a short `server/RUNBOOK.md` covering the handful of most-likely operational scenarios (server won't start → check `.env`/`JWT_SECRET`; suspected data issue → how to take a diagnostic backup before touching anything; how to roll back to yesterday's backup) — mostly assembling and generalizing what this engagement has already independently proven works, into one reference document. Not written here — a real (if small) piece of documentation work, not a "fix."

## 8. Migration validation

**Current state**: migrations run inside `try{}catch{}` per-statement (so an "already exists"-type error on a re-run is silently swallowed, which is the intended idempotency mechanism) — but there's no *positive* verification after boot that the schema actually ended up in the expected shape. `migration-idempotency.test.js` (this engagement's own work) verifies this in a test context, but nothing checks it automatically on a real production boot.

**Recommendation**: a lightweight post-migration assertion at startup — confirm the expected tables and a sample of expected columns exist, log a clear error (not necessarily fail startup) if not. Low-risk, read-only. Not implemented here.

## 9. Database integrity checks

Overlaps with #6 (corruption detection) at the mechanism level (`PRAGMA integrity_check`) and #8 (schema shape) at the "does the DB look right" level. No additional recommendation beyond those two — listing them together here would just be double-counting the same underlying check.

## Summary — what's genuinely low-risk enough to implement without further discussion, if you want it done now

Per this task's own "no implementation unless risk is LOW" allowance:
- #1: `/health` DB connectivity check (additive field, read-only)
- #6: startup `PRAGMA integrity_check`, logged (read-only, cheap)
- #8: startup schema-shape assertion, logged (read-only)

Everything else (#3 automated backups, #4 structured logging, #5 alerting, #7 runbook) is either a genuinely new capability (not a hardening tweak) or a documentation task better done deliberately than folded into this review. **None of the above has been implemented in this pass** — all are recommendations, per the task's primary instruction.
