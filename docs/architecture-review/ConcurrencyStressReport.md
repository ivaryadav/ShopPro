# Concurrency Stress Report

Status: **Complete. 40/40 assertions passing across all 4 levels**, after finding and fixing one real issue in the test design itself (not the underlying system — detailed below, since it's a genuinely useful finding about the rate limiter's interaction with sustained testing, not swept under the rug).

## What was tested, at each of 2 / 5 / 10 / 20 simulated concurrent actors

1. **Concurrent saves** — N devices of the *same* tenant all `PUT /api/data` at the exact same moment (`Promise.all`, true concurrency, not sequential).
2. **Refresh token races** — N tabs racing to refresh the *same* refresh token simultaneously.
3. **Tenant isolation under load** — N *different*, independent tenants all saving concurrently, checked for any cross-contamination.

## Results

| Level | Concurrent saves | Refresh races | Tenant isolation |
|---|---|---|---|
| n=2 | ✅ 1 wins, 1 gets 409 | ✅ 1 real rotation, 1 grace-hit, both usable | ✅ zero leakage |
| n=5 | ✅ 1 wins, 4 get 409 | ✅ 1 real rotation, 4 grace-hits, all usable | ✅ zero leakage |
| n=10 | ✅ 1 wins, 9 get 409 | ✅ 1 real rotation, 9 grace-hits, all usable | ✅ zero leakage |
| n=20 | ✅ 1 wins, 19 get 409 | ✅ 1 real rotation, 19 grace-hits, all usable | ✅ zero leakage |

**Every level, every category: exactly the expected outcome.** No lost updates, no double-wins, no data corruption, no cross-tenant leakage, no spurious logouts — at any tested scale.

## A real finding, from building this test (not hidden)

The first version of this test shared one server instance across all four concurrency levels sequentially. At n=20, the refresh-race check failed — 8 "rotations" observed instead of 1. Investigated directly (instrumented an isolated n=20 run in a scratch script) and confirmed the actual session/rotation logic was correct in isolation — exactly 1 real rotation every time. The failure was the test's own design: `/api/auth/refresh` carries a rate limit of 30 requests / 5 minutes (a real, intentional production safeguard against refresh-token brute-forcing). Running all four levels against one shared server accumulates their refresh calls (2+5+10+20 = 37), which exceeds that limit partway through the n=20 batch — some requests got `429 Too Many Requests`, and the test's own counting logic (`refreshToken !== null`) miscounted those as "rotations" since the field was simply absent from a 429 body, not explicitly `null`.

Fixed two things:
1. **The test**: each concurrency level now gets its own fresh isolated server (Task 2's harness makes this cheap), so no level's request budget interferes with another's — also a more realistic model, since each level represents an independent scenario, not a continuation of the last.
2. **The assertion logic**: now checks `status === 200 && typeof refreshToken === 'string'` instead of `!== null`, so a future rate-limit or error response can never again be silently miscounted as a successful rotation.

This is exactly the kind of thing extended concurrency testing is *for* — it didn't find a flaw in the session architecture, but it did find a flaw in how the test itself was structured, and a real, working rate limit that a sufficiently sustained legitimate burst could actually hit. That's worth knowing: if a real shop ever legitimately fires more than 30 refreshes in 5 minutes (a lot of simultaneous tab activity), they'd see the same `429` a stress test would. At 15-minute access token lifetimes, hitting that in practice would require roughly 30+ simultaneous device/tab refresh attempts inside one 5-minute window — high but not impossible for a very large shop with many staff terminals; worth keeping in mind, not urgent to change.

## Method note on tenant creation at this scale

License keys are deterministic per (plan, day) — see `Wave01-EdgeCaseReport.md` EC-9 — so registering 20+ distinct tenants through the real `/api/auth/register` + key-issuance flow in one test run isn't possible (only 6 plans exist, so only 6 genuinely distinct auto-generated keys per day). This test creates its tenants directly against the isolated database (via `server/sessions.js`'s own `createSession()`, the same code path a real login uses) rather than through the HTTP registration endpoint — appropriate here since this test isn't validating licensing (that's `wave0`/`wave1`'s job, and they correctly do go through the real flow), only load behavior of the save/session machinery.

## Not covered by this test (scope note, not a gap in the work done)

- **True OS-level parallelism** — everything here runs through one Node process's event loop; `Promise.all` produces genuinely concurrent *requests* arriving at the server, but Node itself is single-threaded and `better-sqlite3` is synchronous, so the server processes them one at a time internally by construction (this is a correctness *feature* for SQLite, not a limitation of the test — see `ArchitectureReview.md §10` on why a real multi-process/horizontally-scaled deployment is a separate, larger conversation).
- **Sustained load over time** (e.g., minutes/hours of continuous traffic, memory/connection leak detection) — this tests correctness under burst concurrency, not endurance. A longer-running soak test is a reasonable future addition if warranted.
