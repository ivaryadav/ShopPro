# Operational Hardening Report

Implements `OperationalReadinessPlan.md` §1 (health monitoring) exactly as scoped there: additive fields to `GET /health`, no architecture change, no new dependency, no new endpoint.

## What changed

`server/local.js`'s `/health` route, previously a static `{status:'ok', mode:'sqlite-local', time}` reachable iff the process is alive (checking nothing), now returns:

```json
{
  "status": "ok",
  "mode": "sqlite-local",
  "time": "2026-07-20T07:09:26.774Z",
  "db": "ok",
  "migrationFailures": 0,
  "startup": {
    "jwtSecretConfigured": true,
    "adminKeyIsDefault": false
  }
}
```
(real output, captured from a live isolated boot — see below)

- **`db`**: `'ok'` or `'error'`, from a live `db.prepare('SELECT 1').get()` executed on every `/health` call, wrapped in try/catch.
- **`migrationFailures`**: count from `migrationState.failures` (the array `MigrationSafetyReport.md`'s fix now populates) — a number, not the full error detail, deliberately (see "What was deliberately left out" below).
- **`startup.jwtSecretConfigured`**: always `true` when this route is reachable at all — an unset `JWT_SECRET` calls `process.exit(1)` before the route table is even built (existing behavior, unchanged). Reported anyway so the `startup` block is self-contained rather than silently omitting a field a caller might expect.
- **`startup.adminKeyIsDefault`**: `!process.env.ADMIN_KEY`, checked *after* this file's own `.env`-loading logic runs — so it correctly reflects the real final configuration (a `server/.env` with `ADMIN_KEY` set counts as configured), not just the raw shell environment. This is the exact gap `OperationalReadinessPlan.md` §2 flagged as arguably higher-risk than the already-fixed `JWT_SECRET` gap: an operator who never sets `ADMIN_KEY` gets a working server with a fixed, publicly-knowable admin key hash, silently.
- **`status`**: `'ok'` only if both `db === 'ok'` and `migrationFailures === 0`; `'degraded'` otherwise. Deliberately does not factor in `adminKeyIsDefault` — that's a configuration-hardening signal, not an operational-health signal, and conflating them would make a perfectly healthy, correctly-serving default-config deployment falsely report as unhealthy.

No existing field (`status`/`mode`/`time`) was renamed or removed — a caller reading only those three sees identical shape and behavior to before.

## Live verification

Booted a real isolated server (`testServer.js`) and called the real endpoint — not asserted from reading the code:
```
$ GET /health
{
  "status": "ok", "mode": "sqlite-local", "time": "...",
  "db": "ok", "migrationFailures": 0,
  "startup": { "jwtSecretConfigured": true, "adminKeyIsDefault": false }
}
```
Also spawned a second isolated instance with `ADMIN_KEY` unset in its process environment, to check the `adminKeyIsDefault` path — it came back `false` anyway, because this project's real `server/.env` file has `ADMIN_KEY` set (confirmed: `grep -c ADMIN_KEY server/.env` → 2 matches) and the `.env`-loading logic correctly picked it up before `/health`'s check ran. This is the **correct** behavior, not a bug in the test: it accurately reports that *this specific deployment* is not using the hardcoded default, which is genuinely true. There's no way to observe the `true` branch without either removing the real `.env` file (not done — that file is this deployment's actual configuration, not a fixture) or unit-testing the boolean expression in isolation, which is unnecessary here — `!process.env.ADMIN_KEY` is a one-line negation of the exact same expression the pre-existing `ADMIN_KEY` constant's own fallback already depends on (`local.js` line 62), so there's no logic gap between them to worry about.

## An honest limitation, found by testing rather than assumed

Before finalizing on `db.prepare('SELECT 1').get()` (the exact check `OperationalReadinessPlan.md` §1 proposed), tested what it actually catches:

| Scenario | `SELECT 1` | `SELECT COUNT(*) FROM <table>` |
|---|---|---|
| Genuinely closed connection (`db.close()` called) | **Throws** — caught, `db:'error'` | (not separately tested — would also throw, this is the realistic in-process failure mode) |
| Underlying file deleted while the connection's fd stays open (POSIX semantics: the fd keeps working until closed) | Does not throw | Does not throw — tested, identical |
| On-disk bytes corrupted directly while the connection stays open | Does not throw | Does not throw — tested, identical |

The two rows that don't throw aren't a weakness specific to choosing `SELECT 1` — a real table-scanning query was tested side-by-side and behaved identically, because an already-open SQLite connection can keep serving from OS-level file-descriptor/page-cache state that no longer reflects what's actually on disk anymore. Catching *that* class of failure reliably needs a periodic `PRAGMA integrity_check` (a full scan), which `OperationalReadinessPlan.md` §6 already recommends as a **startup-time** check, not a per-request one (too expensive to run on every health poll) — unchanged by this task, still a recommendation, not implemented, correctly out of this task's "no architecture changes" scope.

**What this check reliably does catch**: a genuinely closed/broken connection object, and — the far more common real-world case this project has actually hit — a boot-time DB-open failure (`FailureScenarioReport.md` scenario 2: bad `DB_PATH`, unwritable directory), since `/health` simply wouldn't be reachable at all if `new Database(DB_PATH)` threw at startup (unchanged, pre-existing fail-fast behavior). The value this check adds is real but narrower than "detects all database corruption" — stated plainly rather than oversold.

## What was deliberately left out

- **Full migration failure details in the response body**: `migrationFailures` is a count, not the array of `{label, error, at}` records. The full detail is already logged loudly to the server console (`MigrationSafetyReport.md`'s fix) — exposing raw internal error messages on an unauthenticated public endpoint would be a new, if minor, information-disclosure surface of exactly the shape `SecurityHardeningReview.md` S-9 already flagged as low-severity but worth avoiding. An operator who sees `migrationFailures > 0` knows to check the server console, where the real detail already lives.
- **`PRAGMA integrity_check` on every request** — too expensive per-request; remains a startup-only recommendation (`OperationalReadinessPlan.md` §6), unchanged.
- **Any new endpoint, auth requirement, or response-shape breaking change** — none of Task 5's three requirements needed one, and adding one would violate "no architecture changes."

## Files changed

- `server/local.js` — `/health` route only, ~25 lines (was 3).
