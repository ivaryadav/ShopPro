# Branching Strategy

## Branches

- **`main`** — always deployable, the canonical current release. Protected: no direct commits, only merges from `release/*` or `hotfix/*`.
- **`develop`** — integration branch for the next release. Protected: no direct commits, only merges from `feature/*` or `refactor/*`.
- **`feature/<name>`** — new functionality. Branches from `develop`, merges back to `develop`.
- **`refactor/<name>`** — internal restructuring, no behavior change. Branches from `develop`, merges back to `develop`. (This project's Phase 1-9 enterprise reconstruction, per `docs/adr/0001-enterprise-reconstruction.md`, uses this prefix.)
- **`release/<version>`** — release stabilization: version bump, changelog, final regression pass, no new features. Branches from `develop`, merges to both `main` (tagged) and back to `develop`.
- **`hotfix/<name>`** — urgent fix for a production defect that cannot wait for the next `develop`-based release. Branches from `main`, merges to both `main` (tagged as a patch release) and back to `develop`.

## Why this structure

The project's own history (see `docs/independent-audit/ProductionInvestigation.md`) surfaced a concrete cost of *not* having this: development happened on a branch (`master`) that was never GitHub's configured default branch, while the actual default (`main`) sat frozen at an unrelated single initial commit. Anything that deployed or cloned "the default branch" without knowing to explicitly ask for `master` would have gotten the wrong, non-functional code. A named, enforced strategy with branch protection removes this entire class of mistake — there is no longer an ambiguous "which branch is real" question.

## Resolution of the historical `main` vs `master` divergence

As of the commit that introduced this document:

- `main` and `master` previously diverged completely — `main` held a single "clean initial commit" (an early project snapshot: old `main.js`/`preload.js` using `node-machine-id`, an early `renderer/index.html` draft later superseded by `app/ShopERP_Pro_v8.html`), while all 79 commits of actual development happened on `master`.
- `main` has been brought up to date via a single merge commit (`--allow-unrelated-histories`) that resolved the 5 files present on both branches (`.gitignore`, `main.js`, `package.json`, `package-lock.json`, `preload.js`) in favor of `master`'s current, developed content — verified byte-identical to `master` before merging. Files unique to the original `main` commit were preserved, not deleted, consistent with not discarding legacy history.
- This was a **normal, non-force push** — `main`'s ref advanced via a genuine merge commit with both prior histories as ancestors. No history was rewritten.
- `develop` was created from this same consolidated commit.
- `master` was **not deleted**. It remains in place, pointing at the commit it was already on, as a deprecated alias during the transition — GitHub's default branch (`origin/HEAD`) already points to `main`, and `main` now has the same content, so the "wrong default branch" risk is resolved without needing to change any GitHub repository setting (which would require API/`gh` access this environment doesn't currently have). `master` can be deleted in a later phase once nothing references it and branch protection on `main`/`develop` is confirmed working.

## What still needs manual, one-time setup on GitHub

These require repository-admin access this environment does not have (no `gh` CLI, no API token) — listed here so they're a concrete, trackable follow-up rather than silently skipped:

1. Enable branch protection on `main` and `develop` (require PR review, require status checks to pass, disallow force-push).
2. Confirm `origin/HEAD` still correctly resolves to `main` (it should, unchanged by this work) after protection rules are enabled.
3. Decide and execute when to delete `master` (recommend: after one full release cycle has gone through `develop` → `release/*` → `main` cleanly).
