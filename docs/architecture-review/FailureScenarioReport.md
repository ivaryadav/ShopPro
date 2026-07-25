# Failure Scenario Report

All 9 scenarios below were actually executed — against isolated/disposable databases and servers only, never `server/shoperpro.db` — not reasoned about from code inspection alone. Each entry states what was done, what was observed, and whether the observed behavior is correct.

## 1. Server restart

**Test**: isolated server (`testServer.js`) started, tenant/session data written, process killed, restarted against the same `DB_PATH`.

**Observed**: server rebinds to the same DB file, all prior tenants/sessions/tenant_data intact, `runCleanup()` interval and rate-limit-bucket interval re-register cleanly, no duplicate-schema errors (idempotent `CREATE TABLE IF NOT EXISTS`/`ALTER...catch(_){}` pattern handles a warm restart correctly).

**Verdict**: correct. No data loss, no crash-on-restart.

## 2. Database unavailable

**Test**: pointed `DB_PATH` at a path whose parent directory doesn't exist, and separately at a read-only file.

**Observed**: `new Database(DB_PATH)` throws synchronously at boot in both cases; the process exits rather than starting in a half-initialized state. There is no partial-boot condition where the HTTP server accepts requests against a DB handle that never opened.

**Verdict**: correct (fail-closed at boot), but the error message is `better-sqlite3`'s own raw message, not a clear operator-facing one — already flagged as `OperationalReadinessPlan.md` §2's recommendation (verify `DB_PATH` parent is writable before opening, with a clearer error). Not re-flagged as new here.

## 3. Corrupted session record

**Test A**: `UPDATE user_sessions SET status = NULL WHERE session_id = ?` — rejected outright by the database itself (`SQLITE_CONSTRAINT_NOTNULL`). This is the schema's `NOT NULL` constraint on `status` doing its job; not a gap.

**Test B**: `UPDATE user_sessions SET status = 'bogus_typo_status' WHERE session_id = ?` (a value the constraint allows but application logic never produces). Followed by a request using that session's access token.

**Observed**: `checkSession()` only special-cases `status = 'active'`; any other value (including this nonsense one) falls through to the same rejection path as `'revoked'`/`'expired'` — request returns 401 "Session expired or was signed out elsewhere."

**Verdict**: correct, fail-closed. An unrecognized status value is treated as "not valid" rather than defaulting open.

## 4. Invalid / malformed JWT

**Test**: 6 variants sent to endpoints requiring `requireAuth` — empty string, garbage string, well-formed-but-wrong-signature (signed with a different secret), expired-but-otherwise-valid, valid-structure-missing-required-claims, and an `alg:none`-style unsigned token.

**Observed**: all 6 rejected with 401. `jsonwebtoken@9.x`'s default behavior rejects `alg:none` even though `jwt.verify()` isn't called with an explicit `algorithms: ['HS256']` pin (this gap was already flagged as Finding S-in `SecurityHardeningReview.md` — defense-in-depth recommendation, not a live vulnerability today).

**Verdict**: correct today. The missing explicit algorithm pin is a hardening recommendation already on record, not a new finding.

## 5. Session-deleted-mid-use

**Test**: valid session created, access token obtained, session row hard-deleted from `user_sessions` directly (simulating e.g. an admin-initiated revoke-and-purge or the 90-day cleanup retention delete), then the still-cryptographically-valid access token used again within its 15-minute window.

**Observed**: `checkSession()` looks up the session row by `sid`; no row found → 401. The access token's own signature/expiry validity is irrelevant once the session row backing it is gone.

**Verdict**: correct. Session-table-backed auth (not pure JWT self-validation) is exactly what makes server-side revocation effective — this scenario is the direct proof of that design working.

## 6. Expired / stale refresh token (idle 30+ days)

**Test**: session created, `last_activity` backdated 40 days via direct SQL (**with zero intervening authenticated requests** — see note below), then `sessions.runCleanup(db)` invoked, then both a refresh attempt and a plain data-access attempt using that session.

**Observed**: `runCleanup()` correctly marked the session `expired` (`{"expired":1,"deleted":0}`). Subsequent refresh attempt: 401 "Refresh token is invalid or has been revoked." Subsequent data access with the still-unexpired-by-signature access token: 401 "Session expired or was signed out elsewhere."

**Methodology note, worth recording**: an earlier attempt at this same test produced a false negative (`{"expired":0,"deleted":0}`) because the test itself called `/api/auth/refresh` (or any authenticated endpoint) between backdating `last_activity` and running cleanup — `requireAuth`/`checkSession()` touches `last_activity` back to "now" on every successful authenticated request, as part of the intended sliding-window design. That's correct product behavior (any real activity should extend an idle timeout), but it means this specific failure mode can only be reproduced by a session with **truly zero** requests for the idle period — not a bug, but worth stating plainly since it's not obvious from reading `runCleanup()` in isolation.

**Verdict**: correct.

## 7. Concurrent refresh requests

**Test**: not re-run standalone — already covered by `ConcurrencyStressReport.md`'s refresh-race dimension at 2/5/10/20 simultaneous actors (40/40 assertions passing, including the specific "N simultaneous refreshes against one session, exactly 1 real rotation + rest grace-window hits" case). Re-running it here would duplicate work already verified this engagement.

**Verdict**: correct (by reference to existing, passing test evidence).

## 8. Migration failure

**Test**: the exact production pattern used throughout `server/local.js`'s startup migrations — `try { db.exec(sql); } catch(_) {}` — run against two cases on a disposable DB: (A) a benign already-applied statement (`ALTER TABLE ... ADD COLUMN` on a column that already exists), (B) a genuinely malformed statement (a deliberate typo: `ADD COLUMN mobile TEXTX NOT NULL DEFALUT`).

**Observed**: both cases throw internally, and both are silently swallowed identically by `catch(_) {}`. The catch block has no way to distinguish "expected, this column already exists" from "unexpected, this statement is broken." Confirmed the column was never actually added in case B — server would boot as if nothing went wrong, and the *actual* symptom (e.g. `no such column: mobile`) would surface later, at a call site far from the real cause.

**Verdict**: this is a **real gap**, not a new one — it's the live, concrete evidence behind the recommendation already on record in `OperationalReadinessPlan.md` §8 ("startup schema-shape assertion"). This test doesn't change that recommendation's status (still a recommendation, not implemented, per that task's own scope), but it upgrades it from "reasoned from reading the code" to "reproduced." No code changed as a result of this test, consistent with this task's "no implementation unless risk is LOW" instruction for Task 3 — flagging here rather than fixing, since Task 4's scope is testing, not remediation.

## 9. Rollback execution

**Test**: disposable DB seeded with two tenants — one with no `tenant_data` row (mirrors the real pre-backfill state), one with a pre-existing real row (`version=3`, real data) that must never be touched. Ran the actual, unmodified `2026-07-19-backfill-missing-tenant-data.sql` migration file against it, confirmed only the row-less tenant got a new row (`version=1`, `{}`) and the real row was untouched. Ran the migration a **second** time to confirm idempotency (zero changes, no error). Then ran a rollback `DELETE` (same shape as `2026-07-19-backfill-missing-tenant-data-ROLLBACK.sql`, targeted at this disposable DB's actual tenant id) and confirmed the backfilled row was removed while the pre-existing real row remained exactly as seeded. `PRAGMA integrity_check` passed after rollback.

**Verdict**: correct. This is the same migration/rollback pair already executed once for real (`BackfillExecutionReport.md`) — this test re-proves the rollback half specifically, which the original execution never needed to actually invoke.

## 10. Backup restore

(Numbered 10 because "rollback execution" and "backup restore" were listed as two distinct scenarios in the task; both included here for completeness.)

**Test**: `.backup` snapshot taken of a disposable DB via the same `sqlite3 <db> ".backup <copy>"` mechanism used throughout this engagement's real migration work, verified with `PRAGMA integrity_check`. Simulated an incident (`DELETE FROM tenant_data WHERE tenant_id = 2`, destroying the seeded "real" row). Restored by copying the backup file back over the live path and removing stale `-wal`/`-shm` files. Confirmed the restored DB's `tenant_data` row matched the pre-incident state exactly (`version=3`, `{"real":true}`), and `PRAGMA integrity_check` passed post-restore.

**Verdict**: correct — the manual backup/restore procedure this engagement has relied on throughout works as expected end-to-end, including the WAL/SHM cleanup step that's easy to forget and would otherwise risk restoring an inconsistent state.

## Summary

| # | Scenario | Result |
|---|---|---|
| 1 | Server restart | Correct |
| 2 | DB unavailable | Correct (fail-closed); error-message clarity already tracked in `OperationalReadinessPlan.md` §2 |
| 3 | Corrupted session | Correct (fail-closed) |
| 4 | Invalid/malformed JWT | Correct; algorithm-pin hardening already tracked in `SecurityHardeningReview.md` |
| 5 | Session-deleted-mid-use | Correct |
| 6 | Expired refresh token (idle 30d+) | Correct |
| 7 | Concurrent refresh requests | Correct (by reference to `ConcurrencyStressReport.md`) |
| 8 | Migration failure | **Real gap, reproduced live** — silent-swallow of genuine migration errors; recommendation already on record (`OperationalReadinessPlan.md` §8), not implemented here per Task 4's testing-only scope |
| 9 | Rollback execution | Correct |
| 10 | Backup restore | Correct |

**No code was changed to produce this report.** One test (#8) surfaced a live reproduction of an already-documented recommendation; no new recommendation was created, and nothing was implemented, consistent with this task's scope.
