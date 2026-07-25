## Summary

<!-- What does this change do, and why? One or two sentences. -->

## Type of change

- [ ] `feature/` — new functionality
- [ ] `refactor/` — internal change, no behavior change
- [ ] `hotfix/` — urgent fix targeting `main` directly
- [ ] `release/` — release preparation (version bump, changelog, release notes)
- [ ] `docs` — documentation only

## Checklist

- [ ] Targets the correct branch (`develop` for features/refactors, `main` only for hotfixes/releases — see `docs/architecture/BranchingStrategy.md`)
- [ ] No direct commits to `main` or `develop` — this is a PR, not a push
- [ ] Lint passes (`npm run lint` in `server/`)
- [ ] Full test suite passes (`npm test` in `server/`)
- [ ] Migration tests pass, if this PR adds/changes a migration (`docs/database/`)
- [ ] No secrets, `.env` files, or credentials included in the diff
- [ ] Documentation updated if this PR changes architecture, API contracts, or deployment steps
- [ ] An ADR was added under `docs/adr/` if this PR makes an architectural decision (see `docs/adr/README.md` for when one is required)
- [ ] `CHANGELOG.md` updated if this PR is user-facing

## Database changes

- [ ] No schema change
- [ ] Schema change — migration file(s): `_______________`
- [ ] Migration has a tested rollback

## Risk / rollback

<!-- What's the blast radius if this is wrong? How would it be rolled back? -->

## Related issues / ADRs

<!-- Link any related GitHub issues or docs/adr/ files. -->
