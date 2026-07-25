# CI Review (Phase 1) — Not Expanded Yet

Reviewing the existing pipeline for Phase 7 (CI/CD) readiness, per this phase's explicit "review only, do not expand the pipeline yet" scope. No changes were made to `.github/workflows/ci.yml` as part of this phase.

## What exists today

`.github/workflows/ci.yml`: on every push and PR, checks out the repo, sets up Node 20, installs `server/`'s dependencies, then runs (in sequence): the syntax-check lint (`server/scripts/lint.js`), and each `server/test/*.test.js` file individually via its own npm script (unit, integration, migration, concurrency, security, migration-safety, security-phase2, operational, and the full family of license/auth/devops tests — 21 files total as of this phase).

This is a real, working, single-job pipeline — not a stub. It has genuinely caught real problems in prior engagements (this project's own history shows CI-driven fixes).

## Gaps relative to the target Phase 7 pipeline (Install → Lint → Typecheck → Test → Build → Migration validation → Artifact → Release)

| Target stage | Current state |
|---|---|
| Install | Present (`npm install` for `server/`). Root (`package.json`, Electron) dependencies are never installed in CI at all — nothing currently verifies the desktop app's own `npm install` succeeds. |
| Lint | Present, but only the narrow syntax-check sweep (`server/scripts/lint.js`) — no ESLint or equivalent style/quality linting exists anywhere in this project. |
| Typecheck | **Absent.** No TypeScript, no JSDoc-based `tsc --checkJs` step, nothing. This phase's new `server/src/` code is fully JSDoc-annotated specifically so a future typecheck step has something to check against without a rewrite. |
| Test | Present for `server/test/` (SQLite/`local.js`). **Not yet extended** to `server/src/tests/` (this phase's new suite, run via `npm run test:src` — deliberately not added to CI yet, since `server/src/` has no real business logic to protect until Phase 2). No test of the root Electron app at all. |
| Build | **Absent.** `electron-builder` (`npm run build-win`/`build-mac`/`build-linux`) is never invoked in CI — nothing verifies the desktop installer actually builds. |
| Migration validation | Exists only as `server/scripts/validate-migrations.js`, run manually/on-demand, not wired into CI. This phase's new `server/src/scripts/migrate.js status`/`up` isn't in CI either (correctly — no MariaDB service container exists in the pipeline yet, and shouldn't until Phase 2 has real migrations to validate). |
| Artifact | **Absent.** No build output (installer, or a versioned server bundle) is archived by CI. |
| Release | **Absent.** No automation for tagging, generating release notes, or publishing a GitHub Release — every release to date (including `v1.0.0`) was done by hand, and even then, creating the actual GitHub Release object could not be automated in past sessions because no `gh` CLI/token was available (`docs/independent-audit/ProductionLaunchReport.md`). |

## Why this isn't being fixed now

Expanding CI to cover `server/src/`, a MariaDB service container, migration validation, builds, and artifacts only makes sense once there's real code and a real database schema for those stages to exercise — doing it now would mean either running against the still-empty scaffolding (testing nothing) or against `local.js`'s existing SQLite path a second time (duplicating, not improving, coverage). Phase 7 (per `docs/adr/0001-enterprise-reconstruction.md`'s roadmap) is where this table gets closed out for real, once Phases 2-6 have given it something meaningful to run.

## What Phase 7 will need to add, concretely

- A `mariadb` service container in the GitHub Actions job (standard `services:` block), so `npm run migrate:up` / `test:src:database`'s real integration path (currently honest-skips in this environment — see `server/src/tests/database.test.js`) actually runs in CI.
- `npm run test:src` added to the pipeline once `server/src/` has real logic worth protecting (Phase 2 onward).
- A typecheck step (`tsc --checkJs --allowJs` against `server/src/`, using the JSDoc annotations this phase already established) once there's enough of `server/src/` for it to be worth the CI minutes.
- `electron-builder` invoked for at least one platform, with the output archived as a CI artifact.
- A release job gated on a `release/*` branch or a tag push, generating and (once credentials are available in the CI environment — unlike this interactive session) publishing GitHub Release notes automatically.
