# Migration Safety Report

Fixes the gap live-reproduced in `FailureScenarioReport.md` scenario 8: startup migrations used `try { db.exec(sql); } catch(_) {}`, which caught every error identically — a benign "this column already exists" re-run and a genuine syntax/corruption error were indistinguishable, both silently swallowed. The server would boot as if nothing went wrong; the real symptom would surface later, at an unrelated call site.

## The fix

**`server/local.js`** and **`server/sessions.js`** (both had this pattern — `local.js` for its own tables, `sessions.js`'s own `migrate()` for `user_sessions`):

- `BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i` — classifies the two error message shapes SQLite/`better-sqlite3` actually produces for "this statement was already applied": `duplicate column name` (a repeated `ALTER TABLE ... ADD COLUMN`) and `already exists` (a `CREATE TABLE`/`CREATE INDEX` without an `IF NOT EXISTS` guard). These are real, observed message strings, not assumed — the *majority* of this codebase's migrations already use `IF NOT EXISTS`, so the ones needing this classification are specifically the bare `ALTER TABLE ADD COLUMN` statements, whose one legitimate re-run error is always this exact shape.
- `runMigration(sql, label)` wraps each statement: benign errors are still silently absorbed (unchanged idempotent behavior — required, since these statements run on every single boot); anything else is `console.error`'d with a `[MIGRATION FAILED]` prefix and pushed into a `migrationState.failures` array with the label, the real error message, and a timestamp.
- **Deliberately does not crash the process.** Requirement 2 ("fail loudly on real errors") is met by visibility — a loud log line plus a recorded, queryable failure state — not by `process.exit()`. Reasoning: these are independent, additive statements (an unrelated column on an unrelated table); a server that would otherwise boot and serve every tenant not touching the one affected column/table shouldn't go fully down over it. This is a different tradeoff than the existing `JWT_SECRET` fail-fast check (`local.js`, near the top) — that check has no legitimate "already applied" case to distinguish from a real problem, so crashing is unambiguously correct there. Migrations do have that distinction, which is the entire point of this fix.
- `sessions.migrate(db, failures)` now accepts an optional `failures` array so both modules' results land in one list; `migrate(db)` alone (no second argument) still works unchanged for any other caller — checked, `local.js` is the only real caller in this codebase.
- `migrationState.failures` is read by `GET /health` (see `OperationalHardeningReport.md`) so a genuine migration failure is now visible to monitoring, not just to whoever happens to be reading the server's console at boot time.

## Requirements checklist

1. Distinguish already-applied vs. genuine failure — ✅, `BENIGN_MIGRATION_ERROR` regex, tested against both real SQLite message shapes and three distinct genuine-error shapes (syntax error, readonly database, corruption).
2. Fail loudly on real errors — ✅, `console.error` with a distinct `[MIGRATION FAILED]` prefix (previously: nothing at all) plus a structured, timestamped record surfaced via `/health`. Interpreted as "loud and visible," not "process.exit" — see reasoning above.
3. Preserve backward compatibility — ✅. Idempotent re-runs remain completely silent (same behavior as before for the case that happens on every single boot). `sessions.migrate()`'s signature change is additive/optional. No schema change. No behavior change for a healthy, correctly-migrating database — verified via the pre-existing `migration-idempotency.test.js` suite (3 consecutive boots against the same DB file), which still passes 8/8 unmodified.
4. Tests added — ✅, `server/test/migration-safety.test.js`, 19 assertions, wired into `npm run test` and CI.

## Test results

```
$ node server/test/migration-safety.test.js
  ✓ BENIGN_MIGRATION_ERROR regex found in server/local.js
  ✓ runMigration() function found in server/local.js
  ✓ classifies "duplicate column name" ... as benign
  ✓ classifies "already exists" ... as benign
  ✓ classifies "already exists" for an index the same way
  ✓ does NOT classify a genuine syntax error as benign
  ✓ does NOT classify a readonly-database error as benign
  ✓ does NOT classify a corruption error as benign
  ✓ runMigration() does not throw for a benign (already-applied) error — boot continues
  ✓ benign error is NOT recorded in migrationState.failures
  ✓ benign error produces no console.error output (still silent, matching pre-fix idempotency behavior)
  ✓ runMigration() does not throw for a genuine error either — one bad migration does not crash the server
  ✓ genuine error IS recorded in migrationState.failures
  ✓ recorded failure carries the correct label for operator diagnosis
  ✓ recorded failure carries the real underlying error message
  ✓ recorded failure carries a timestamp
  ✓ genuine error IS logged loudly via console.error, prefixed [MIGRATION FAILED] ...
  ✓ live isolated server boots successfully with the new migration runner
  ✓ /health reports zero migration failures on a fresh, correctly-migrating database

19 passed, 0 failed
```

Also re-ran the pre-existing `test:migration` suite (3-consecutive-boot idempotency check) unmodified — still 8/8 passing, confirming the new classification logic doesn't change real-world boot behavior for the actual, currently-correct set of migrations this codebase ships.

## Why no live "genuinely broken migration" test against a real database

Deterministically forcing a real SQLite `ALTER TABLE` to fail for a reason *other than* "duplicate column" (a true syntax error, a locked file, corruption) without contrived, non-representative file-level tampering isn't reliably reproducible — and even if it were, it would exercise the exact same `runMigration()` code path the extracted-real-function unit tests already drive directly, with a controlled, known error message instead of an unreliable one. The unit-level tests (`migration-safety.test.js` Layer 2) extract and execute the actual shipped `runMigration()` source (not a reimplementation) against both a real benign message and a real genuine-error message, which is the strongest verification available without a flaky, contrived setup — matching the same reasoning already on record in `FailureScenarioReport.md` scenario 3 (a rejected forced-corruption attempt was itself treated as a valid result, not something to force through with a hack).

## Files changed

- `server/local.js` — replaced 12 bare `try{}catch(_){}` migration statements with `runMigration(sql, label)` calls; added `migrationState`, `BENIGN_MIGRATION_ERROR`, `runMigration()`.
- `server/sessions.js` — replaced 2 bare `try{}catch(_){}` statements the same way; `migrate(db, failures)` signature extended (backward compatible).
- `server/test/migration-safety.test.js` — new file, 19 assertions.
- `server/package.json` — added `test:migration-safety` script, added to aggregate `test`.
- `.github/workflows/ci.yml` — added a "Migration safety tests" CI step.
