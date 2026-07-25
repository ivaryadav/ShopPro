# CI Setup Report

Status: **Implemented and verified locally** (the exact commands GitHub Actions will run were executed directly, end to end — not just written and assumed correct).

## What was added

| File | Purpose |
|---|---|
| `.github/workflows/ci.yml` | Runs on every push and pull request |
| `server/scripts/lint.js` | Syntax-check sweep (see below for why this, not eslint) |
| `server/package.json` | New `lint`, `test:unit`, `test:integration`, `test:migration`, `test:concurrency`, `test` scripts |
| `server/test/migration-idempotency.test.js` | New — 3 consecutive boots against the same DB file, verifies no errors and no data loss |
| `server/test/concurrency-stress.test.js` | New — Task 4's extended concurrency tests (see `ConcurrencyStressReport.md`) |

## Pipeline stages, mapped to the requirement

| Required | Implemented as |
|---|---|
| Lint | `server/scripts/lint.js` — syntax-checks every server `.js` file plus every inline `<script>` block in the app HTML. **Not eslint**: no linter is configured anywhere in this project today, and adding one means adding its own config and style opinions, which wasn't asked for. This is deliberately the narrower thing — "does it parse" — which is exactly the class of error `node --check` caught by hand throughout this whole engagement's own work. Wiring that into CI so it can't be skipped by accident. |
| Unit tests | `wave0-concurrency.test.js` — optimistic concurrency on `/api/data` |
| Integration tests | `wave1-sessions.test.js` — full session lifecycle against a real running server |
| Migration tests | `migration-idempotency.test.js` — new, 3 consecutive boots, same file, verifies idempotency and zero data loss between boots |
| Security tests | Not a separate job — tenant isolation, cross-tenant authorization boundaries, and theft-detection-outside-the-grace-window are exercised as assertions inside the integration and concurrency suites (they're the same behavior a dedicated "security" pass would check; running it twice under two labels would just be theater). Noted directly in the workflow file's comments so this is a documented choice, not an oversight. |
| Concurrency tests | `concurrency-stress.test.js` — 2/5/10/20 simulated concurrent actors (Task 4) |

## Fail-on conditions

Every test file ends with `process.exit(failed > 0 ? 1 : 0)`. The workflow chains steps as separate GitHub Actions `steps`, each of which fails the job outright on a non-zero exit code — no step is allowed to fail silently or be skipped. `npm test` locally (and implicitly, the equivalent sequence of CI steps) chains with `&&`, so any failure stops the sequence immediately.

Specifically, per the requirement:
- **Regression** → any of the 4 test files failing fails its step, fails the job.
- **Migration failure** → `test:migration`'s step fails; also, `local.js` itself calls `process.exit(1)` on a genuinely fatal startup condition (e.g. missing `JWT_SECRET`), which the migration test's child-process wrapper (`testServer.js`/the inline spawn helper in `migration-idempotency.test.js`) surfaces as a rejected promise, failing that test.
- **Tenant isolation failure** → covered by `wave1-sessions.test.js`'s cross-tenant revoke check and `concurrency-stress.test.js`'s N-tenant isolation-under-load check; either failing fails its step.
- **Concurrency failure** → `test:concurrency`'s own step.

## Verification performed (not just "should work")

Ran the exact commands the CI workflow invokes, locally, in sequence:
```
npm run lint            → exit 0
npm run test:unit       → 16 passed, 0 failed
npm run test:integration → 27 passed, 0 failed
npm run test:migration  → 8 passed, 0 failed
npm run test:concurrency → 40 passed, 0 failed
```
All against isolated, disposable databases (Task 2) — confirmed production's `shoperpro.db` (6 tenants) was unchanged before and after this entire run.

## What CI does NOT yet cover

- **Electron build/launch verification** — this environment can't launch a real Electron GUI (documented earlier, `ELECTRON_RUN_AS_NODE=1` sandbox restriction), and neither can a headless GitHub Actions runner without additional setup (Xvfb, etc.). Not attempted here; a genuine gap if Electron-specific regressions are a concern, though nothing in this workflow's changes touches Electron code (`main.js`/`preload.js` are untouched by every task in this work order).
- **Deployment step** — this workflow only tests; it doesn't build or deploy anything. Not requested, not added.
