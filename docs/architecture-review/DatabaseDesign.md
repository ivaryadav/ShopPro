# Database Design — SaaS Licensing Tables

Status: **Implemented**, all additive. See LicensingMigrationPlan.md for the deploy/rollback procedure and `server/local.js` for the exact `db.exec()`/`runMigration()` calls (same pattern as the existing Wave 0/1 schema changes — `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`, run inline at every boot, no versioned migration files).

## New tables

```sql
CREATE TABLE subscription_plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,        -- 'TRIAL' | 'BASIC' | 'PREMIUM'
  label         TEXT    NOT NULL,
  device_limit  INTEGER NOT NULL,
  trial_days    INTEGER,                        -- 14 for TRIAL, NULL otherwise
  is_active     INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    DEFAULT (datetime('now'))
);
-- Seeded every boot (idempotent INSERT OR IGNORE):
--   TRIAL   / 2 devices / 14-day trial_days
--   BASIC   / 2 devices / NULL
--   PREMIUM / 5 devices / NULL

CREATE TABLE tenant_licenses (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id                INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  status                   TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                              CHECK (status IN ('PENDING_APPROVAL','ACTIVE','READ_ONLY','SUSPENDED','ARCHIVED')),
  plan_code                TEXT NOT NULL DEFAULT 'TRIAL' REFERENCES subscription_plans(code),
  requested_plan_code      TEXT,                -- customer's original Step-2 request, kept as history even after admin changes plan_code
  billing_cycle            TEXT,                -- 'trial'|'monthly'|'halfyearly'|'yearly'|'lifetime'
  device_limit             INTEGER NOT NULL DEFAULT 2,
  license_key              TEXT,                -- plaintext SHOP-XXXX-XXXX-XXXX — see "Why plaintext" below
  requested_devices_bucket TEXT,                -- '1-2'|'3-5'|'5+', informational only, never enforced
  requested_modules        TEXT NOT NULL DEFAULT '[]',  -- JSON array, capture-only, never enforced
  starts_at                TEXT,
  expires_at               TEXT,                -- NULL = never (lifetime)
  read_only_since          TEXT,                -- drives the 30-day READ_ONLY -> SUSPENDED sweep timer
  suspended_since          TEXT,                -- drives the 365-day SUSPENDED -> ARCHIVED sweep timer
  last_verified_at         TEXT,                -- offline-grace anchor, updated on every GET /api/license/status
  offline_grace_days       INTEGER NOT NULL DEFAULT 15,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tenant_licenses_key ON tenant_licenses(license_key) WHERE license_key IS NOT NULL;
CREATE INDEX idx_tenant_licenses_status ON tenant_licenses(status);

CREATE TABLE license_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,   -- REGISTERED|EMAIL_VERIFIED|APPROVED|REJECTED|PLAN_ASSIGNED|TRIAL_STARTED|
                                  -- KEY_GENERATED|KEY_REGENERATED|EXTENDED|STATUS_CHANGED|DEVICE_REMOVED|
                                  -- DEVICES_RESET|DEVICE_LIMIT_CHANGED|SESSIONS_KILLED|NOTE_ADDED|CALL_LOGGED|BACKFILLED
  from_status  TEXT,
  to_status    TEXT,
  detail       TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL DEFAULT 'system',  -- 'system' | 'admin'
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_license_history_tenant ON license_history(tenant_id, created_at);

CREATE TABLE trusted_devices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      TEXT NOT NULL,   -- client's generateBrowserMachineId() fingerprint
  device_name    TEXT,
  browser        TEXT,
  os             TEXT,
  first_login_at TEXT DEFAULT (datetime('now')),
  last_login_at  TEXT DEFAULT (datetime('now')),
  is_active      INTEGER NOT NULL DEFAULT 1,   -- soft-remove only, never hard-deleted (audit trail)
  created_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, device_id)
);
CREATE INDEX idx_trusted_devices_tenant ON trusted_devices(tenant_id);
CREATE INDEX idx_trusted_devices_user ON trusted_devices(user_id);
```

## New columns on existing tables

```sql
ALTER TABLE tenants ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN gst_number TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verify_token_hash TEXT;
ALTER TABLE users ADD COLUMN email_verify_expires TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
```
`users.email` already existed and was simply unused by the legacy register endpoint — no new column needed for it.

## Legacy columns are frozen, not migrated

`tenants.status`, `tenants.suspend_reason`, `tenants.license_key_hash`, `tenants.license_expiry`, `tenants.license_plan` are **never written by any new code** — `requireActive`, the legacy `/api/auth/register`, `/api/auth/verify-license`, `/api/admin/tenant/status`, and `/api/admin/web-users` all keep reading and writing them exactly as before. This is a deliberate design choice, not an oversight: it guarantees zero regression risk for any tenant or client build that predates this feature and never migrates onto the new flow.

## Backfill for pre-existing tenants

Runs automatically **every boot** (idempotent `WHERE NOT EXISTS` anti-join), not as a one-off manual SQL file like the 2026-07-19 backfill precedent — that one fixed a historical bug affecting some rows; this one is a universal consequence of shipping the feature at all, needed by every tenant that existed before this code landed.

```sql
INSERT INTO tenant_licenses (tenant_id, status, plan_code, billing_cycle, device_limit, expires_at, last_verified_at)
SELECT t.id,
  CASE t.status WHEN 'paused' THEN 'SUSPENDED' WHEN 'terminated' THEN 'ARCHIVED' ELSE 'ACTIVE' END,
  'BASIC',
  CASE WHEN t.license_plan IN ('monthly','halfyearly','yearly','lifetime') THEN t.license_plan ELSE 'monthly' END,
  5,   -- see reasoning below — deliberately not BASIC's own default of 2
  t.license_expiry,
  datetime('now')
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM tenant_licenses tl WHERE tl.tenant_id = t.id);
```
Then, in JS, every newly-backfilled row gets a freshly-generated `SHOP-XXXX-XXXX-XXXX` key (the old `license_key_hash` is a different, non-reversible 16-char/4-group format and can't be reused) and a `BACKFILLED` `license_history` entry.

| Legacy value | New value | Why |
|---|---|---|
| `status='active'` | `ACTIVE` | Direct mapping |
| `status='paused'` | `SUSPENDED` | Closest equivalent in the new 5-state enum |
| `status='terminated'` | `ARCHIVED` | "Soft, never delete" fits a terminated legacy account |
| `license_plan` (any of monthly/halfyearly/yearly/lifetime) | same value as `billing_cycle` | Carried over directly |
| `license_plan` (anything else, or unset) | `'monthly'` | Safe fallback — never leaves `billing_cycle` invalid |
| *(no legacy device concept)* | `device_limit = 5` | **Not** BASIC's own default of 2 — real per-tenant device usage is unknown at backfill time; defaulting low risks locking an existing, paying shop out of its own second or third device on day one. Admin can adjust anytime via the device-limit endpoint. |

## Why `license_key` is stored in plaintext

Unlike the legacy `license_key_hash` (a one-way hash, because that key *is* a cryptographic credential in the offline-desktop system), the new hosted key has no verification role — authentication is still mobile+PIN, unchanged. The key exists purely so admin/support can look up or hand a customer their reference code, which requires reading it back. Every endpoint that returns it (`generate-license`, the tenant-licenses dashboard) is already `X-Admin-Key`-gated, so this doesn't introduce a new exposure surface.

## Verification

`server/test/migration-idempotency.test.js` was extended (not duplicated) to assert all 4 new tables and the 3 seeded plans survive 3 consecutive boots against the same DB file with zero duplication. `server/test/license-backfill-regression.test.js` independently verifies the backfill's correctness and idempotency against a DB seeded with only legacy-shape tenants (26 assertions), and that every legacy endpoint continues to function unmodified against those same tenants.
