# Contributing to ShopERP Pro

This project is undergoing a phased enterprise reconstruction (see `docs/adr/0001-enterprise-reconstruction.md`). This document covers the practical day-to-day workflow; the reasoning behind it lives in the ADRs under `docs/adr/`.

## Branching strategy

Full detail: `docs/architecture/BranchingStrategy.md`. Summary:

| Branch | Purpose | Direct commits allowed? |
|---|---|---|
| `main` | Always deployable. The canonical, current release. | **No** — only via merged `release/*` or `hotfix/*` PRs. |
| `develop` | Integration branch for the next release. | **No** — only via merged `feature/*` or `refactor/*` PRs. |
| `feature/*` | New functionality. Branch from `develop`, merge back to `develop`. | Yes, on the feature branch itself. |
| `refactor/*` | Internal restructuring with no behavior change (e.g. this project's Phase 1-9 enterprise reconstruction work). Branch from `develop`, merge back to `develop`. | Yes, on the branch itself. |
| `release/*` | Release preparation (version bump, changelog, final regression). Branch from `develop`, merge to both `main` and back to `develop`. | Yes, on the branch itself. |
| `hotfix/*` | Urgent production fix. Branch from `main`, merge to both `main` and `develop`. | Yes, on the branch itself. |

**Never commit directly to `main` or `develop`.** Always work on a named branch and open a pull request.

## Before opening a pull request

1. `cd server && npm install && npm run lint && npm test` — must pass with zero failures.
2. If your change adds or modifies a database migration, run the migration validation step (`docs/database/`) and include a tested rollback.
3. If your change makes an architectural decision — a new dependency, a new layer, a data-model change, anything that would be expensive to reverse later — add an ADR under `docs/adr/` first (see `docs/adr/README.md`). Don't make that decision silently inside a PR description.
4. Fill out `.github/PULL_REQUEST_TEMPLATE.md` completely.

## Commit messages

Conventional-commit style, matching this project's existing history: `feat(...)`, `fix(...)`, `refactor(...)`, `docs(...)`, `test(...)`, `chore(...)`, `security(...)`. Explain *why*, not just *what* — the diff already shows what changed.

## Versioning

Semantic Versioning (`docs/architecture/Versioning.md`). Every release from `release/*` includes release notes, rollback notes, and — if the schema changed — the migration version reached.

## Code quality expectations

- JSDoc on every new exported function/module.
- No `console.log` outside the centralized logger (`server/src/logging/`, once wired in — see the relevant phase).
- No SQL outside the repository layer.
- No business logic in repositories; no HTTP/request concerns in services.
- No dead code, no commented-out code, no magic numbers.

## Reporting a security issue

See `SECURITY.md` — do not open a public issue.
