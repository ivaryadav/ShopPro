# CI Validation Report

## The finding that changes what "would GitHub Actions succeed" actually means

Before running anything, checked what git would actually push. **Nothing from this entire engagement has ever been committed** — confirmed via `git ls-files`, which returns zero matches for `.github/`, `server/sessions.js`, `server/logger.js`, `server/test/`, `server/scripts/`, `server/migrations/`, or `docs/`. `git status --short` shows all of it as untracked (`??`) or modified-but-unstaged. The repository's actual `HEAD` (`0ba59b2`, "security: web/hosted licensing now matches desktop machine-lock architecture") predates every wave of work this engagement has done — Wave 0 concurrency, Wave 1 sessions, the backfill migration, the orphan cleanup, both security hardening passes, both operational hardening passes, and `.github/workflows/ci.yml` itself.

**This means, literally**: if `git push` were run right now with no prior `git add`/`git commit`, **nothing would change on the remote** — there's nothing new to push. GitHub Actions cannot evaluate a workflow file that was never committed, against code that was never committed, on a branch nobody has updated. "Verify that GitHub Actions would succeed" therefore has two honest, separate answers:

1. **Would the code, once committed and pushed, pass this exact CI pipeline?** — Yes, verified below, rigorously.
2. **Would GitHub Actions run at all today?** — No. There is no commit for it to run against. This is the actual, single largest blocker to ever observing a real CI run (the item every prior review in this engagement has flagged as outstanding) — and it's more fundamental than "nobody has pushed yet": nothing has even been committed yet.

Neither committing nor pushing was done as part of this task — both are the kind of state-changing, hard-to-reverse-in-spirit action (a commit is reversible, but represents a real decision point) this engagement's standing rules reserve for your explicit go-ahead, and this task's own instruction is explicitly "push nothing."

## Clean-room simulation

To answer question 1 rigorously — not by re-running tests in this same directory with its already-installed `node_modules`, which wouldn't catch a dependency resolution problem — copied the entire current working tree (all uncommitted changes included, since that's what a future commit would actually contain) into a fresh temporary directory, **excluding** `node_modules` and `.git`, then ran a genuinely fresh `npm install` there before executing every CI step.

```
$ rsync -a --exclude='node_modules' --exclude='.git' ... <source> <clean-room>/
$ cd <clean-room>/server && npm install --no-audit --no-fund
  npm warn deprecated prebuild-install@7.1.3: No longer maintained...
  added 164 packages in 1s
```
One deprecation warning (a transitive dependency of `better-sqlite3`, not this project's own code) — not an error, doesn't fail the install, unchanged from the environment this project has always run in.

## Every CI step, run in the clean room, in the exact order `.github/workflows/ci.yml` specifies

| Step | Command | Result | Wall time |
|---|---|---|---|
| Install | `npm install --no-audit --no-fund` | ✅ 164 packages | 1.467s |
| Lint | `npm run lint` | ✅ 18 files + 3 inline script blocks | 0.734s |
| Unit | `npm run test:unit` | ✅ **16/16** | 0.475s |
| Integration | `npm run test:integration` | ✅ **27/27** | 0.830s |
| Migration | `npm run test:migration` | ✅ **8/8** | 1.575s |
| Concurrency | `npm run test:concurrency` | ✅ **40/40** | 3.991s |
| Security (S-1/S-2) | `npm run test:security` | ✅ **28/28** | 0.386s |
| Migration safety | `npm run test:migration-safety` | ✅ **19/19** | 0.390s |
| Security phase 2 (S-7/S-9/S-10) | `npm run test:security-phase2` | ✅ **14/14** | 0.401s |
| Operational hardening phase 2 | `npm run test:operational` | ✅ **17/17** | 0.863s |

**169/169 test assertions passing, 0 failed. Lint clean.** Also ran the aggregate `npm test` (what a contributor would run locally, and what `ci.yml`'s steps collectively compose into) end-to-end in the same clean room: **exit code 0**, 8.438s total.

Cross-checked every `name:`/`run:` pair in the clean room's own copy of `.github/workflows/ci.yml` against the steps actually executed above — exact match, same order, nothing skipped, nothing added that isn't really in the workflow file.

## "Build" and "migrations" — mapped to what this project actually has

This task's instruction named 5 things to simulate: clean checkout, install, build, tests, migrations.
- **Clean checkout**: done, via the fresh `rsync` copy (git-history-equivalent for the purpose of testing "does the current code work from nothing," since — per the finding above — there is no actual git history to check out that includes this work).
- **Install**: done, real `npm install` against no pre-existing `node_modules`.
- **Build**: `ci.yml` has no build step, and this project has none to add — the server is plain Node (no bundler/transpiler), the client is a single static HTML file loaded directly (no build step), and `electron-builder`'s `build-win`/`build-mac`/`build-linux` scripts (root `package.json`) package platform-specific desktop installers, which is unrelated to `ci.yml`'s actual tested pipeline and isn't something a Linux CI runner would do for Windows/Mac targets anyway. Not fabricating a build step `ci.yml` doesn't have — this table reports against the real workflow file, not an idealized one.
- **Tests**: all 8 CI test steps, above.
- **Migrations**: the "Migration tests — idempotency" and "Migration safety tests" steps, both above, plus `validate-migrations.js` (this task's own new command) run standalone against the clean room's fresh isolated test databases as part of `test:operational`.

## What this report does and does not establish

**Does establish**: the code, exactly as it currently sits in the working tree, installs cleanly from nothing and passes every test this project has, in an isolated environment with no dependency on anything already present in the development directory.

**Does not establish**: that GitHub Actions' own hosted runner environment (a different OS image, different pre-installed toolchain, different network path to the npm registry) behaves identically — that has never been checked, for the reason given at the top of this report, and remains explicitly out of this task's scope ("push nothing").

## Recommendation

The path to actually closing "no CI run has ever been observed" — the single most-repeated open item across every review this engagement has produced — is, in order: `git add`, `git commit`, then `git push`. All three are your decision.
