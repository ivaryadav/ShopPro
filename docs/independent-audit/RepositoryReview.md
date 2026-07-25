# Repository Review — Independent Release Approval Board

Scope: `master` branch, HEAD `55ce7bf`, tag `v1.0.0` (local, not yet pushed to `origin`). This review does not use any conclusion from prior `docs/architecture-review`, `docs/deployment`, `docs/right-click-review`, or `docs/production-hardening` reports as evidence — every claim below was re-derived directly from `git`.

## Commit history

`git log --oneline` shows 33 commits since project start, all on a single `master` branch — no feature branches, no merge commits, fully linear history. The most recent 23 commits (`0ba59b2`..`55ce7bf`) cover, in order: session-architecture rework, operational scripts, CI workflow, the full SaaS licensing/registration/subscription system, responsive/UX documentation, production-deployment prep, and the final security-hardening pass (backdoor removal, bcrypt migration, enumeration fix, DevOps headers). Commit messages are consistently descriptive and conventional-commit-styled (`feat:`, `fix:`, `security:`, `test:`, `docs:`, `chore:`, `ci:`).

**Verified anomaly, transparently self-disclosed by the developer**: this repo has a pre-commit hook (`.git/hooks/pre-commit`) that unconditionally bumps a version string in `app/ShopERP_Pro_v8.html` and re-stages the file on every commit, regardless of what the commit is actually about. This means several commits whose message describes a narrow change (e.g. `83cc5cd test(server): regression coverage...`) also carry an incidental version-string diff in `app/ShopERP_Pro_v8.html`, and one commit (`796dff2`) carries the entire pending `app.html` diff because it was the first commit to touch that file after several logical changes had accumulated unstaged. Confirmed directly:

```
git show --stat 55ce7bf
 app/ShopERP_Pro_v8.html  | 6 +--   (v8.53 -> v8.54, cosmetic only)
```

This is a real repo-hygiene wrinkle (it makes per-commit diffs for `app.html` noisier than they should be) but is not a correctness or security problem — confirmed the actual content diff in the `55ce7bf` case is a 2-line version bump, nothing else.

## Branches

Single branch: `master`. `remotes/origin/master` exists and (as of this review) is fully in sync with local `master` (`git rev-list --left-right --count origin/master...HEAD` → `0 0`) — the 23 unpublished commits reviewed here were pushed in the immediately preceding session.

## Tags

Three tags exist locally: `foundation-milestone-complete`, `v1.0.0-rc1`, `v1.0.0`. **None have been pushed to `origin`** (`git ls-remote --tags origin` returns empty). `v1.0.0` is annotated with a real message summarizing scope and linking to `ProductionReleaseApproval.md`. This is consistent with the stated intent ("stop after successful push," tag push deliberately held pending this independent review).

## Release notes

No GitHub Releases exist yet (no tags pushed). The `v1.0.0` and `v1.0.0-rc1` annotated tag messages function as de facto release notes today but have not been published as an actual GitHub Release.

## Repository hygiene

- `.gitignore` is thorough and correctly scoped: `node_modules/`, `dist/`, `build/`, `coverage/`, both `.env` and `.env.*` (with explicit `!.env.example`/`!.env.*.example` carve-outs), `server/.env*` (redundant but harmless double-coverage), all SQLite artifacts (`*.db`, `-shm`, `-wal`, `-journal`), `server/backups/`, `logs/`, `*.log`, `tmp/`, `*.tmp`, and macOS `._*`/`.DS_Store` noise.
- Verified `server/.env` (the real, populated env file) is **not tracked** — `git ls-files | grep -x server/.env` returns nothing, `git check-ignore -v server/.env` confirms it's excluded by `.gitignore:11`.
- Verified `server/.env.example` and `server/.env.local.example` (the only tracked env-related files) contain placeholder values only (`CHANGE_ME_...`, `changeme@example.com`) — no real credentials.
- Full-history secret scan: `git log -p --all | grep -iE "AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----|sk_live_|xox[baprs]-"` → zero matches across the entire history, not just the current diff.
- `.git` directory size is **361 MB**, dominated by `app/ShopERP_Pro_v8.html` — a 2.4 MB file that has been fully rewritten across dozens of commits (every commit that touches it stores a full new blob; Git does delta-compress these in packfiles, but the working history is nonetheless large for a project this size). Not a functional defect, but worth budgeting for — clone time and disk footprint will keep growing at roughly 2.4 MB per meaningfully-sized `app.html` change unless this file is eventually restructured (e.g., split into smaller assets) or history is periodically repacked.
- Two items remain deliberately untracked at the working-tree level: `.codex/` (unrelated local dev-tool config) and `ShopERP_Pro_Architecture_Reference.pdf` (a large reference document) — neither is staged, neither risks being committed accidentally, both are a prior, already-made decision, reconfirmed still true.
- Untracked macOS `._*` AppleDouble files litter `docs/` (byproduct of working from an external/network volume) — confirmed gitignored (`.gitignore:6`, `._*`) and NOT present in `git ls-files` (zero count). Filesystem noise only, zero repository impact.

## Versioning

Three independent version identifiers exist with no single source of truth linking them:
1. `app/ShopERP_Pro_v8.html`'s embedded `<meta name="shoperpro-version">` / `<title>` — currently `v8.54`, auto-incremented by the pre-commit hook on every commit that touches the file (i.e., its number reflects commit count, not semantic meaning).
2. `server/package.json`'s `"version"` field — `1.0.0`, static, not auto-bumped by anything, has never changed since the file was created.
3. The git tag — `v1.0.0`.

Nothing in the codebase maps "HTML build v8.54" to "release v1.0.0" — an operator debugging a production issue from a browser's reported `v8.54` has no automated way to know which git commit or release tag that corresponds to beyond manually correlating dates. This is a real, if minor, operational gap: **recommend recording the git commit SHA or tag name inside the HTML build itself** (e.g., a build-time-injected `data-build` attribute) so a support engineer looking at a live page in a browser can identify exactly what's deployed.

## Verdict for this phase

No secrets, no destructive history, no hidden branches, clean `.gitignore`, tags correctly held back pending approval. The pre-commit-hook version-bump side effect and the three-scheme versioning drift are real hygiene findings, carried into the final report, but neither blocks a release on their own.
