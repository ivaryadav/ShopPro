# Versioning

Semantic Versioning (`MAJOR.MINOR.PATCH`), applied consistently across the root `package.json` (Electron desktop app), `server/package.json` (backend), and git tags — all three must always agree. (A prior inconsistency between these three — root `package.json` at `8.0.1` against the tag and `server/package.json` at `1.0.0` — was found and corrected during v1.0.0's release verification; see `docs/independent-audit/ProductionLaunchReport.md`.)

- **MAJOR** (`v1.0.0` → `v2.0.0`) — breaking changes: incompatible API changes, a database engine change (as in the ongoing MariaDB migration, `docs/adr/0002-mariadb-canonical-database.md`), or removal of a supported feature.
- **MINOR** (`v1.0.0` → `v1.1.0`) — new, backward-compatible functionality.
- **PATCH** (`v1.0.0` → `v1.0.1`) — backward-compatible bug fixes only, typically shipped via `hotfix/*`.

## Release requirements

Every tagged release must have, under `docs/releases/`:

1. **Release Notes** — what changed, in customer/operator language (see `docs/independent-audit/GitHubReleaseNotes_v1.0.0.md` for the format this follows).
2. **Rollback Notes** — the exact steps and prior tag to revert to if the release needs to be undone (see `docs/independent-audit/ProductionLaunchChecklist.md`'s Rollback procedure for the v1.0.0 precedent).
3. **Migration Notes** — which database migrations this release introduces, and whether they're reversible.
4. **Database Version** — the last applied migration's version/checksum after this release (see `docs/database/`).

## Current version state

- `v1.0.0` — tagged, released, both `package.json` files and the tag agree. SQLite-backed (`server/local.js`).
- `v2.0.0` (in development, on `develop`/`refactor/*` branches) — the enterprise reconstruction described in `docs/adr/0001-enterprise-reconstruction.md`. Will not be tagged until all 9 phases of that reconstruction are complete and independently verified, per that ADR.
