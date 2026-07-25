# Orphaned Data Audit — Full Table Sweep

**Read-only. Every query below is a `SELECT`; no data was modified.**

Method: for every table with a foreign-key-shaped relationship to `tenants` or `users`, checked for rows whose referenced parent doesn't exist, using `WHERE NOT EXISTS (...)` — the same pattern used throughout this engagement's other migrations, applied here for detection rather than insertion.

## Inventory

| Table | Total rows | Orphaned rows | Detail |
|---|---|---|---|
| `tenant_data` | 7 | **1** (`tenant_id = 6`) | See `RootCauseAnalysis.md` |
| `user_sessions` | 6 | **6** (all of them) | See below — every current session row happens to be orphaned |
| `users` | 2 | 0 | Clean |
| `cloud_backups` | 0 | 0 | Table is empty |

## `user_sessions` — full detail

All 6 rows currently in the table are orphaned, referencing tenant/user IDs that no longer exist:

| session_id (truncated) | tenant_id | user_id | login_time | status |
|---|---|---|---|---|
| `7bfa905e...` | 13 | 9 | 2026-07-18 20:37:18 | active |
| `832cddd0...` | 14 | 10 | 2026-07-18 20:47:11 | active |
| `76ba82db...` | 15 | 11 | 2026-07-18 20:48:02 | active |
| `8e6bffb3...` | 22 | 18 | 2026-07-18 20:57:34 | active |
| `9fb762c1...` | 25 | 21 | 2026-07-18 20:58:47 | active |
| `75d04ece...` | 28 | 24 | 2026-07-18 21:15:36 | active |

Every one of these timestamps falls within this review's own Wave 1 development and testing window (2026-07-18 20:37–21:15). Each corresponds to a disposable test tenant created via `POST /api/auth/register` during that work and later cleaned up via direct `sqlite3` CLI `DELETE` statements against `tenants`/`users`/`tenant_data` — the session row was missed in some of those manual cleanups, for the identical foreign-key-enforcement reason documented in `RootCauseAnalysis.md`. None of these are real tenant or customer sessions; all 6 tenant IDs referenced (13, 14, 15, 22, 25, 28) are confirmed absent from the current `tenants` table.

**Why all 6 current rows are orphaned and none are legitimate**: this database currently has zero real logged-in web sessions — the 6 real tenants (`Dada Mobile`, `Vision Communication`, etc.) predate Wave 1 (session tracking didn't exist when they were set up) and haven't logged in since Wave 1 shipped, so they have no session rows at all yet. Every session row that exists is therefore from this review's own testing.

## Exposure assessment (not a modification — analysis only)

- **Access tokens**: 15-minute JWTs, all long expired by the time of this audit. Not replayable regardless of the session row's status.
- **Refresh tokens**: only their SHA-256 hash is stored (`refresh_token_hash`), never the raw token, in the database — consistent with the design in `SessionArchitecture.md`. The raw values existed only in this review's own ephemeral shell-command variables during testing, with the caveat that a few raw values were echoed into this session's own tool-output logs while testing (visible only within this conversation's transcript, not externally accessible) — noted for completeness, not because it constitutes a real exposure.
- **Practical risk today**: negligible. Deleting these rows removes even the theoretical concern at zero cost, since nothing legitimate references them.

## What is confirmed clean

- No orphaned `users` rows (every user's `tenant_id` resolves to a real tenant).
- No orphaned `cloud_backups` (table is empty — nothing has ever been pushed to it in this environment).
- No `audit_log`/`security_audit_log` table exists yet to audit (not yet built — planned, separate work).
- The 6 real tenants and their data (`tenant_id` 1, 2, 3, 4, 5, 9) are entirely unaffected by anything in this audit — none of them appear in any orphan list above.

## Recommended action

See `RecommendedRemediation.md` for the proposed cleanup migration. **Not executed as part of this task** — Task 1 was explicitly scoped read-only, and a data-modifying cleanup is a separate, gated action requiring its own dry-run/approval cycle, matching the pattern already established for the `tenant_data` backfill.
