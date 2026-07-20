# Orphan Cleanup — Rollback SQL

Two independent rollback options, matching the pattern already established and used for the `tenant_data` backfill's rollback.

## Option A — Restore exact row content (targeted, no downtime)

Every value below was captured directly from the live database during the Task 1 audit — this is not a template to be filled in later, it's the actual content that would be deleted, ready to re-insert if the cleanup is executed and later needs undoing.

```sql
BEGIN TRANSACTION;

-- Restore the orphaned tenant_data row (tenant_id = 6)
INSERT INTO tenant_data (tenant_id, data, version, updated_at, updated_by)
VALUES (6, '{}', 1, '2026-07-15 10:06:13', NULL);

-- Restore the 6 orphaned user_sessions rows
INSERT INTO user_sessions
  (session_id, tenant_id, user_id, jwt_id, device_id, login_time, last_activity,
   current_page, status, refresh_token_hash, ip_address, browser, os, created_at,
   prev_refresh_token_hash, refresh_rotated_at)
VALUES
  ('7bfa905e63e4bcc0d12f6b36f9a86531200bea879d7075ab', 13, 9,
   '249b739d7a1b97ab8461b2b7', NULL, '2026-07-18 20:37:18', '2026-07-18 20:37:18',
   NULL, 'active', 'fc0e27bc41c0daaf35320fd7aab2f6eb79a21f5a5ed0bcb83261f0e829c39ae4',
   '127.0.0.1', 'Unknown', 'Unknown', '2026-07-18 20:37:18', NULL, NULL),
  ('832cddd0405b19e8b43bbf5a0ccb91952656afbdc4291a42', 14, 10,
   '90318ccb5063c0cc9f47aeab', NULL, '2026-07-18 20:47:11', '2026-07-18 20:47:11',
   NULL, 'active', '6c5aa5148116e571f8b825a3e48034f55dbb6cb8940be99d4f654bd6e08fc39b',
   '127.0.0.1', 'Unknown', 'Unknown', '2026-07-18 20:47:11', NULL, NULL),
  ('76ba82dbbe7e86d52aa3609d6efa9cb84d6a59ec28f011db', 15, 11,
   '773843955a46db87bd5c9b22', NULL, '2026-07-18 20:48:02', '2026-07-18 20:48:03',
   NULL, 'active', 'c71a63c1b783cd24c5fcaaf3a1fb7861a89374f9aec2e06bd82d5097d3a2c22d',
   '127.0.0.1', 'Unknown', 'Unknown', '2026-07-18 20:48:02', NULL, NULL),
  ('8e6bffb38ddc0f7b6784e9d57b29b2a1e2d754cf933d2ec1', 22, 18,
   'f28acc89e33be0baa8183a28', NULL, '2026-07-18 20:57:34', '2026-07-18 20:57:34',
   NULL, 'active', '2c08b9fe8b057c35b8d7d7e6178cae6b44a05ae220b07df1f5cdca26c32158db',
   '127.0.0.1', 'Unknown', 'Unknown', '2026-07-18 20:57:34', NULL, NULL),
  ('9fb762c1b0542cf0c13c94b9b2afae5f86b262cc99a1188d', 25, 21,
   '0a9638e964a7d713a2e7acb7', NULL, '2026-07-18 20:58:47', '2026-07-18 20:58:47',
   NULL, 'active', '8f0e37efbeefab052bec46469ba04b382eaec02843baedffb413b9a95bdcd22a',
   '127.0.0.1', 'Unknown', 'Unknown', '2026-07-18 20:58:47', NULL, NULL),
  ('75d04ece88ec6cbfd721c81a15a3edf795b296190e53865d', 28, 24,
   'c26354fe71b838027a6e5b62', NULL, '2026-07-18 21:15:36', '2026-07-18 21:15:36',
   NULL, 'active', '62ed79f5ce7d3735b151c3161af50d2ad4b235351f11c9070290eed90d27e442',
   '127.0.0.1', 'Unknown', 'Unknown', '2026-07-18 21:15:36', NULL, NULL);

COMMIT;
```

**Important caveat, stated plainly**: restoring these rows brings back *orphans* — none of these `tenant_id`s (6, 13, 14, 15, 22, 25, 28) correspond to a real tenant, before or after this rollback. This rollback exists to satisfy "every change must have a rollback," and is correct in the narrow sense of "undo the deletion exactly" — but running it doesn't create any new risk either (the rows are exactly as inert restored as they were before deletion, per `RootCauseAnalysis.md` §7). If the actual goal after a rollback is "get back to a completely clean state," Option B is simpler.

## Option B — Restore from backup

```bash
pkill -f "node local.js"
cp server/shoperpro.db server/shoperpro.db.pre-rollback-safety-copy   # optional
cp <pre-cleanup-backup-path> server/shoperpro.db
rm -f server/shoperpro.db-wal server/shoperpro.db-shm
node server/local.js
```
Requires the backup taken immediately before cleanup execution (per `OrphanCleanupPlan.md` §"If approved") — not yet taken, since nothing has been executed. Would restore the database to its exact pre-cleanup state, not just these 7 rows.

## Which to use

Option A if only this specific cleanup needs undoing and the server should stay up throughout (no restart needed — plain `INSERT` statements against the running database). Option B if a full, exact point-in-time restore is preferred, or if something unexpected happened that this document doesn't anticipate.

## Verifying a rollback took effect

```sql
SELECT tenant_id FROM tenant_data WHERE tenant_id NOT IN (SELECT id FROM tenants);
-- expect: 6

SELECT tenant_id FROM user_sessions WHERE tenant_id NOT IN (SELECT id FROM tenants);
-- expect: 13, 14, 15, 22, 25, 28
```
