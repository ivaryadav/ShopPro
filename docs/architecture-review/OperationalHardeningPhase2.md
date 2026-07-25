# Operational Hardening — Phase 2

Implements the 4 items this task named, each mapped to an existing `OperationalReadinessPlan.md` recommendation. No monitoring system was built (no scheduler, no alerting integration) — every item here is either a boot-time check or an on-demand command, per this task's explicit "do NOT implement monitoring systems" instruction.

## 1. Startup validation checks

`server/local.js`, two additions right after the existing `ADMIN_KEY` declaration:

- **`ADMIN_KEY` unset → warn loudly, don't fail.** Implements `OperationalReadinessPlan.md` §2 exactly as scoped there — unset is a legitimate default for local single-shop use, so this doesn't `process.exit()` (unlike the existing `JWT_SECRET` check, which fails hard for a different reason: an unset `JWT_SECRET` silently breaks every session on restart, a correctness bug, not a posture choice). This is boot-time visibility for an operator who never polls `GET /health` — `/health`'s `startup.adminKeyIsDefault` (from the prior task) already surfaces the same fact, but only to whoever thinks to check it.
- **`DB_PATH`'s parent directory must exist and be writable before `new Database(DB_PATH)`.** `FailureScenarioReport.md` scenario 2 already confirmed the server fails closed here (no partial-boot state) — this only replaces `better-sqlite3`'s own raw error with a specific, operator-actionable one naming the actual directory and the configured `DB_PATH`.

**Live-verified**: spawned a real process with `DB_PATH` pointed at a nonexistent directory — exits code 1 with `[FATAL] Cannot write to the database directory: /nonexistent-dir-.../` (not `better-sqlite3`'s generic message). A normal, writable `DB_PATH` boots identically to before (regression-tested).

## 2. Backup verification command

New: `server/scripts/backup-verify.js` (`npm run backup:verify -- --path <db> --out <dir>`).

Formalizes the exact `sqlite3 <db> ".backup <copy>"` + `PRAGMA integrity_check` sequence this engagement has run by hand at every prior migration and cleanup (`BackfillExecutionReport.md`, `OrphanCleanupExecutionReport.md`) into a reusable, scriptable command — using `better-sqlite3`'s own `db.backup()` API (confirmed: returns a real `Promise`, empirically verified, not assumed) rather than shelling out to the `sqlite3` CLI, so it doesn't depend on that binary being present in a given deploy environment. WAL-aware by construction (same reasoning as `OrphanCleanupExecutionReport.md`'s methodology note about why a raw `cp` isn't equivalent).

**What it deliberately is not**: a scheduler. It runs once, when invoked, and exits — `OperationalReadinessPlan.md` §3's "automated, scheduled backup with retention pruning" remains a distinct, larger recommendation, not implemented here. This script is the reusable building block such a scheduler would eventually call.

**Live-verified**: ran against a real (disposable) database with actual data — produced a backup file, confirmed the data is genuinely present in the copy (not an empty/corrupt file), confirmed `PRAGMA integrity_check` passes independently on the copy, exit code 0. Ran against a nonexistent source path — exit code 1, clear error, no crash.

## 3. Structured logging

New: `server/logger.js` — `info`/`warn`/`error`, each emitting one JSON line (`{time, level, message, meta?}`) to `console.log` (info) or `console.error` (warn/error). No new dependency, matching `OperationalReadinessPlan.md` §4's explicit recommendation ("the lowest-risk path is wrapping the existing console.log/console.error call sites... rather than introducing a logging framework dependency").

**Scope, stated plainly**: applied to the operationally significant lines this and the prior hardening task specifically added or already touch — the two new startup checks above, the migration-failure logging (`runMigration()`, from `MigrationSafetyReport.md`), and `/health`'s DB-connectivity-check failure. **Not** retrofitted across the ~30 other pre-existing `console.log`/`console.error` call sites in `server/local.js` (registration confirmations, license operations, etc.) — that would be a much larger surface change than "minimal improvements" calls for, and matches `OperationalReadinessPlan.md`'s own framing that full structured logging "is not urgent at the product's current realistic scale."

`migration-safety.test.js`'s extraction-based unit test (which drives the real `runMigration()` source in isolation) was updated to inject a fake `logger` instead of a fake `console`, since that function's real dependency changed — still 19/19 passing, still proving the same benign-vs-genuine classification behavior.

## 4. Migration validation command

New: `server/scripts/validate-migrations.js` (`npm run validate:migrations -- --path <db>`).

Implements `OperationalReadinessPlan.md` §8 ("a lightweight post-migration assertion — confirm the expected tables and a sample of expected columns exist") as a standalone command rather than baked into every boot — deliberately: running it on every server start would start drifting into "monitoring system" territory (this task's own exclusion), and a hand-maintained expected-schema list checked automatically on every single boot risks becoming a nuisance false-positive source the moment a legitimate new migration is added without updating this script in lockstep. As an on-demand/deploy-time command instead, it's a deliberate, opt-in check — "does this database actually look migrated" — usable after any deploy or in CI.

Checks 5 tables and 46 columns total (every table/column this codebase's actual migrations create, captured directly from `PRAGMA table_info` against the real production schema — not guessed). On failure, lists every specific missing table/column by name, not a generic "schema invalid."

**Live-verified**: passed against real production `shoperpro.db` (5 tables, 46 columns, all present) and a fresh, correctly-migrated isolated test database. Failed correctly — and specifically — against a deliberately incomplete database (1 table, 2 columns): reported exactly `missing table: users`, `missing table: tenant_data`, `missing table: cloud_backups`, `missing table: user_sessions`, and all 7 missing `tenants` columns, exit code 1.

## Regression tests

`server/test/operational-hardening-phase2.test.js`, 17 assertions, all passing — covers the logger's output shape, the startup DB_PATH check's exit code and message (plus a regression check that a valid path still boots normally), both scripts' success and failure paths against real disposable databases (never `server/shoperpro.db`).

Full suite re-run after all changes: **169/169 assertions passing** across 8 test files, lint clean (new files `logger.js`, `scripts/backup-verify.js`, `scripts/validate-migrations.js`, `test/operational-hardening-phase2.test.js` all picked up automatically by the existing lint sweep). Wired into `npm run test` and `.github/workflows/ci.yml` (new step: "Operational hardening tests — phase 2").

## Files changed

- `server/local.js` — startup validation checks, `logger` require, migration-failure/`\health` logging switched to structured logger.
- `server/logger.js` — new.
- `server/scripts/backup-verify.js` — new.
- `server/scripts/validate-migrations.js` — new.
- `server/test/operational-hardening-phase2.test.js` — new, 17 assertions.
- `server/test/migration-safety.test.js` — updated (fake `console` → fake `logger` in the extraction harness, matching `runMigration()`'s real dependency change).
- `server/package.json` — added `test:operational`, `backup:verify`, `validate:migrations`; added `test:operational` to aggregate `test`.
- `.github/workflows/ci.yml` — added "Operational hardening tests — phase 2" step.
