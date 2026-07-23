# Licensing System — Migration & Deploy Plan

Status: **Ready to deploy**. Note: the requested filename `MigrationPlan.md` already exists in this directory (the Wave 0/1 session-architecture rollout doc) — reusing it would destroy prior documentation, so this feature's deploy plan uses a distinct name instead.

## Pre-deploy checklist

1. **SMTP is now boot-mandatory.** `server/mailer.js` requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` in `server/.env` — **the server will refuse to boot at all without them**, on every `server/local.js` deployment, even ones not yet using the new self-service registration flow. This is the same fail-loudly posture as the existing mandatory `JWT_SECRET` check. Placeholder values are already present in `server/.env` for local dev continuity; replace them with real credentials before relying on Step 5 verification emails actually sending.
2. **`npm install` in `server/`** — adds the new `nodemailer` dependency (`^6.9.14`).
3. No new required env vars beyond SMTP — `LICENSE_SWEEP_INTERVAL_MS` is optional (defaults to 15 minutes; only test files override it to fast-forward transitions).
4. No breaking change to any existing endpoint's request/response shape. `GET /api/license/status`'s new `license` field is additive; every previously-existing top-level field (`status`, `reason`, `licenseExpiry`, `licensePlan`) is untouched.

## Deploy sequence

1. Deploy the updated `server/` code (new tables/columns/endpoints are all created automatically at boot — no manual migration step to run).
2. First boot after deploy:
   - Creates `subscription_plans`, `tenant_licenses`, `license_history`, `trusted_devices`.
   - Seeds the 3 plans (idempotent).
   - Backfills a `tenant_licenses` row for every pre-existing tenant (see DatabaseDesign.md for the exact mapping) — expect one `BACKFILLED` `license_history` row per existing tenant.
   - If SMTP env vars are missing, the process exits immediately with a `[FATAL]` message naming exactly which vars are missing — this is intentional, not a bug, and must be resolved before the deploy is considered live.
3. Deploy the updated `app/ShopERP_Pro_v8.html` — served directly by `server/local.js`'s `/` route (`fs.readFileSync` on every request, no build step, no restart needed to pick up a new file).
4. Verify via `GET /health` — `migrationFailures` should read `0`.
5. Spot-check the backfill: `GET /api/admin/tenant-licenses` should list every pre-existing tenant with a real `status`/`planCode`/`licenseKey`, not empty.

## Backfill verification query

Run directly against the deployed SQLite file (read-only, safe at any time):
```sql
SELECT t.id, t.shop_name, t.status AS legacy_status, tl.status AS new_status, tl.license_key, tl.device_limit
FROM tenants t LEFT JOIN tenant_licenses tl ON tl.tenant_id = t.id
WHERE tl.tenant_id IS NULL;
-- Should return ZERO rows after the first boot. Any row here means a tenant
-- exists without a tenant_licenses row — investigate before relying on the
-- new admin dashboard or license-status gating for that tenant (it fails
-- open, not closed, so this is a visibility gap, not an outage).
```

## Rollback

Because every change here is additive (new tables, new nullable/defaulted columns, no `DROP`/`ALTER ... DROP COLUMN` anywhere), rolling back to the previous `server/local.js` build is safe with **no schema rollback required**:
- The new tables simply go unread by the old code — they aren't referenced by any pre-existing endpoint.
- The new `tenants.address`/`gst_number` columns and `users.email_verify_*` columns are additive and default-valued; old code that doesn't know about them just doesn't select/insert them.
- No data is destroyed by rolling back. Any tenant that had progressed through the new registration/approval flow keeps its `tenant_licenses` row (simply unused again until the new code is redeployed) and — critically — its `tenant_data` is completely unaffected either way, per Rule #1.

If a genuine rollback of the *database file itself* is ever needed (not just the code), follow the same convention already established by the 2026-07-19 backfill's rollback file: snapshot before any one-off manual data operation, target exact row IDs rather than a heuristic re-scan. No such manual data operation is needed for this deploy — the backfill is designed to be safe to leave in place indefinitely, even if this feature were later reverted.

## Operational notes

- The license-transition sweep (`runLicenseTransitionSweep`) runs every 15 minutes by default. At 50–500 tenants, this is a handful of indexed `UPDATE ... WHERE status = ? AND ... < datetime('now', ...)` queries — negligible load.
- SMTP outages degrade gracefully: `transporter.verify()` failing at boot is logged, not fatal (an unreachable mail relay shouldn't take down the POS server for tenants not currently registering). A `sendVerificationEmail()` failure during signup is likewise logged and the signup still succeeds — the customer can use "Resend Verification Email" once SMTP is fixed.
- No new admin credential system — every new admin endpoint reuses the existing `X-Admin-Key` mechanism.
