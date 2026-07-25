# Cloud Backup Domain — Implementation (RC1 Sprint 3)

Migrates ONLY the Cloud Backup domain from `server/local.js` into `server/src/`: Backup creation, restore, deletion, and metadata listing (repository-only). Explicitly does not touch Inventory, Sales, Repairs, Expenses, Authentication, Administration, Licensing, the frontend, database architecture (beyond the one additive migration below), Reporting, or Analytics.

This sprint delivers TWO distinct, unrelated capabilities, both named "backup" in this codebase — they must not be conflated:

- **Part A — the `/api/cloud/*` HTTP domain**: a per-license-key, single-slot sync bridge for the OFFLINE DESKTOP product, ported into the layered architecture.
- **Part B — `databaseBackupService.js` + `backupVerify.js`**: an on-demand MariaDB operational backup/verify CLI tool, the MariaDB-native analog of the pre-existing `server/scripts/backup-verify.js` (which backs up the SQLite file). Not exposed over HTTP — an operator/deploy-script tool, same as its SQLite counterpart.

## Part A — Cloud Backup HTTP domain

### Layers (ADR-0005)

```
routes/cloudBackup/index.js               →  POST /api/cloud/backup, GET /api/cloud/restore/:keyHash, DELETE /api/cloud/backup/:keyHash
controllers/cloudBackupController.js      →  Request/response only
services/cloudBackupService.js            →  Business rules (deliberately minimal — see below)
repositories/cloudBackupRepository.js     →  Persistence only
database/migrations/005_cloud_backup_domain.sql(+.rollback.sql)  →  1 new table (cloud_backups)
```

### A structurally different table: no `tenant_id`

`cloud_backups` is keyed purely by `key_hash` (`local.js:186-195`) — a hash of the OFFLINE DESKTOP product's license key (ADR-0003). It has no `tenant_id` column at all, unlike every other domain migrated in this engagement. This is preserved exactly, not retrofitted with tenant scoping that never existed in `local.js`.

This table is nonetheless legitimately in scope for the MariaDB migration (ADR-0002, "one database"): it is genuine **server-side** data living in `local.js`'s own database, reached over a real HTTP API. ADR-0003's offline-desktop exclusion applies to the desktop app's own **client-side** data model (localStorage) — not to server tables the desktop happens to call into over the network.

### What's implemented (matches `local.js:1751-1784` exactly)

- `POST /api/cloud/backup` — upsert. Requires `keyHash` and `data`; `shopName` is optional (defaults to `''` at the repository/SQL layer, same as `local.js`). Calling this twice for the same `keyHash` **overwrites** the first backup — there is no history, one backup slot per license key. This is `local.js`'s real, deliberate design, preserved exactly, not a bug.
- `GET /api/cloud/restore/:keyHash` — returns `{data, shopName, backedUpAt}`. Throws `NotFoundError` (404) if no backup exists for that key hash.
- `DELETE /api/cloud/backup/:keyHash` — **unconditional** delete, no prior existence check. Always succeeds (`{ok:true}`), even for a `keyHash` with no row. Matches `local.js:1781-1784` exactly, preserved as-is, not "fixed" with a 404.
- `listBackups()` (repository/service only, `cloudBackupRepository.listAll()`) — **no local.js equivalent, no new public route.** `local.js` never looks up more than one `key_hash` at a time; this exists for admin visibility/testing only, resolving the mission's ambiguous "Backup listing" line item without inventing a new public endpoint (see "Judgment calls" below).

### Validation — deliberately minimal, matching `local.js` exactly

`local.js` does not checksum, encrypt, version, or otherwise validate the `data` blob's content server-side — the client is expected to encrypt before sending. `cloudBackupService.js` preserves this exactly: presence checks only (`keyHash` and `data` required). No checksumming/encryption/versioning was added — doing so would be inventing new behavior, not preserving existing behavior.

### Gating — reused, not modified

Mounted at `/api/cloud`, gated by Sprint 2's existing `requireAdminSession` middleware, **imported unmodified** — matching `local.js`'s real behavior where `/api/cloud/*` is gated by the identical `requireAdminKey` mechanism as Administration's own routes. Zero lines changed in `requireAdminSession.js` or `adminAuthService.js`.

### `TEXT` → `LONGTEXT` — a structural type promotion, not a behavior change

SQLite's `TEXT` column has no practical size limit; MariaDB's `TEXT` is capped at 65,535 bytes, which would silently truncate a real shop-data backup blob. `cloud_backups.data` is declared `LONGTEXT` (up to 4GB) in migration 005 — the same kind of structural type promotion this engagement has made before (e.g. earlier migrations' `TEXT`→`TIMESTAMP` promotions), not a new capability.

### Security review

- **Authorization / gating**: `requireAdminSession`, unmodified, same as Administration.
- **Tenant isolation / backup ownership**: this table has no tenant concept — isolation is purely by `key_hash`, an unguessable hash of a real license key. Verified via integration testing (`cloudBackupCore.integration.test.js`) that one `key_hash`'s data is never returned under another's lookup.
- **Directory traversal / filename sanitization / safe restore paths**: **structurally not applicable.** `local.js`'s real implementation has zero file-system interaction for this domain — `data` is a JSON/string blob stored in a database column, not a file. These checklist items assume a file-based backup system; documented here as N/A rather than inventing file handling to make them apply.
- **Input validation**: presence checks only, matching `local.js` (see above).
- **Rate limiting — a known, deliberately preserved gap.** `local.js` has no rate limit on any of these 3 endpoints, unlike Phase 6's fix for the Operations routes. This sprint's mission is parity-preservation, not security-hardening, so this gap is preserved as-is and flagged here, not silently fixed.

## Part B — MariaDB operational backup/verify tool

`server/src/services/databaseBackupService.js` + `server/src/scripts/backupVerify.js` are the MariaDB-native analog of the pre-existing `server/scripts/backup-verify.js` (which backs up the SQLite file via `better-sqlite3`'s `.backup()` + `PRAGMA integrity_check`). Same methodology, applied to the new database engine:

1. **`createBackup({outDir})`** — runs `mysqldump --single-transaction --routines --triggers <database>` and writes the output to a timestamped `.sql` file.
2. **`verifyBackup(dumpPath)`** — restores the dump into a freshly-created **scratch database** (never the real one — "Never overwrite production data without verification"), then:
   - Compares the restored table set against the LIVE database's table set (**missing-table detection** — see "Real bug found" below).
   - Runs `CHECK TABLE` on every restored table.
   - Compares per-table row counts between the live database and the restored scratch copy.
   - Drops the scratch database in a `finally` block, whether verification passed or failed.

Same exit-code contract as `backup-verify.js`: `0` = verified good, `1` = any failure (dump failure, restore failure, missing tables, `CHECK TABLE` failure, or a row-count mismatch).

**On-demand only, not a scheduled job** — matching `local.js`/`backup-verify.js`'s own reality: no scheduled-backup capability exists in either the SQLite or the MariaDB version of this system, so none was invented here (mission: "Scheduled backup support (if already exists)" — it doesn't).

**Credential handling**: `mysqldump`/`mysql` are invoked with a temporary `--defaults-extra-file` options file (mode `0600`), never as CLI arguments (which would be visible via `ps` on a shared machine). The temp file is deleted in a `finally` block on every code path, including failure.

### Real bug found during real-database testing (data-safety-relevant)

Initial implementation compared restored tables only against themselves (per-table `CHECK TABLE` + row-count checks), never against the live database's full table set. A **truncated/corrupted dump** — the exact failure mode the mission's "Corruption detection" requirement targets — can restore a valid *prefix* of tables and then abort (the `mysql` client stops executing on the first parse error partway through the stream). Every table that DID make it into the scratch database passed its own individual checks, so `verifyBackup` reported `ok: true` even though several entire tables were silently missing from the restore — a silent pass on genuine corruption.

**Fixed** by adding an explicit live-vs-restored table-SET comparison (`missingTables`), verified with a real, deliberately-truncated dump against a real disposable MariaDB instance: the fix correctly flags `ok: false` and lists exactly which tables never made it into the restore. See `cloudBackupService.integration.test.js`'s sibling, `databaseBackupService.integration.test.js`, for the reproduction and regression test.

## Judgment calls (flagged, with reasoning)

1. **`listBackups()` has no new public route.** The mission's "Include" list names "Backup listing" without an "if already exists" qualifier, but `local.js` has no such endpoint. Resolved by implementing it repository/service-only — consistent with "No new features" / "Implement only existing functionality" taking precedence over an ambiguous line in a generic requirements template, and consistent with how prior sprints resolved analogous tensions.
2. **Directory-traversal/filename-sanitization/safe-restore-path security checks are documented as N/A**, not faked with invented file-handling code, since `local.js`'s real implementation never touches the filesystem for this domain.
3. **Rate limiting is preserved as a known gap**, not silently fixed — this sprint's mission is narrower (parity), not security-hardening.
4. **Part B's missing-table detection is a genuine, in-scope bug fix**, not scope creep: the mission explicitly requires "Verify backup integrity" and "Corruption detection" for the NEW MariaDB-native tool this sprint itself is building — fixing a defect in code written this sprint, before it ships, is squarely in scope.

## Explicitly NOT introduced

No checksumming/encryption/versioning added to the HTTP domain's `data` blob. No new public route beyond the 3 `local.js` already exposes. No scheduled-backup job. No retention-policy enforcement (`local.js` has none — one slot per key, overwritten forever — so none was added).

## Deployment status

Same as every prior phase/sprint: not deployed, not cut over. `server/src/app.js` now also mounts `/api/cloud`.
