# SaaS Licensing Architecture — Registration, Subscription & Device Control

Status: **Implemented**. Web/hosted mode only (`server/local.js` + the `pss-` client screens). The fully-offline Electron desktop machine-lock activation path (`server/license.js` + the corresponding block in `app/ShopERP_Pro_v8.html`) is completely untouched by everything below.

## Why

Before this feature, getting a shop onto the hosted product was entirely manual: a customer WhatsApps the developer, the developer generates a license key from the admin console, the customer types that key into a signup form. There was no trial, no self-service registration with admin review, no device-count enforcement, no distinction between "expired but viewable" and "fully locked out," and no email verification anywhere in the codebase. This system replaces that manual loop with registration → admin approval → subscription lifecycle, while keeping one rule absolute: **customer data is never deleted.** Expiry, suspension, and even long-term non-payment only ever flip a status column — inventory, invoices, repairs, settings, users, and reports are untouched by every transition described here.

## Two license systems, deliberately kept apart

| | Offline desktop (out of scope) | Web/hosted (this system) |
|---|---|---|
| Where | Electron, no server contact | `server/local.js`, SQLite |
| License key | Manually entered once, cryptographically machine-locked (`server/license.js`) | Auto-generated, `SHOP-XXXX-XXXX-XXXX`, purely a support/reference identifier |
| Auth | Local PIN only | Mobile + PIN, JWT + session table (Wave 1, unchanged) |
| Registration | Admin console generates a key from a WhatsApped Machine ID | Self-service wizard, no key needed at all |

The two never intersect. `server/license.js`'s FNV-hash key-derivation engine and its client-side twin in `app/ShopERP_Pro_v8.html` are read but never modified or reused here — a hosted license key has no cryptographic or credential role; it's generated with `crypto.randomBytes`, stored in plaintext, and exists so admin/support can reference an account by a human-readable code.

## Status state machine

Exactly 5 states, per spec ("avoid unnecessary complexity" — no dedicated `REJECTED` or `EMAIL_PENDING` state was added):

```
PENDING_APPROVAL ──approve──▶ ACTIVE ──expiry──▶ READ_ONLY ──30 days──▶ SUSPENDED ──365 days──▶ ARCHIVED
        │                        ▲                                          ▲
        └──────reject───────▶ ARCHIVED                          extend ─────┘ (also escapes READ_ONLY→ACTIVE)
                                                    admin suspend/reactivate also cross ACTIVE ⇄ SUSPENDED directly
```

| Status | Reads | Writes | Meaning |
|---|---|---|---|
| `PENDING_APPROVAL` | blocked | blocked | Signed up, awaiting admin approval (and, practically, email verification — see RegistrationFlow.md) |
| `ACTIVE` | allowed | allowed | Normal operation |
| `READ_ONLY` | allowed | **blocked** | Expired; "Allow: Login, View Data. Block: new invoices/inventory updates/repair updates/editing" |
| `SUSPENDED` | blocked | blocked | 30+ days in READ_ONLY, or manually suspended by admin; sessions are killed |
| `ARCHIVED` | blocked | blocked | 365+ days SUSPENDED (non-payment), or a rejected registration; data retained forever |

Enforced by two Express middlewares in `server/local.js`, both running *after* the existing `requireActive` (which still gates the legacy `tenants.status`/`license_expiry` columns, byte-for-byte unchanged):

```js
function requireLicenseRead(req, res, next) {
  const lic = getTenantLicense(req.user.tenantId);
  if (!lic) return next(); // fail-open: pre-feature tenant, no tenant_licenses row
  if (lic.status === 'PENDING_APPROVAL') return res.status(403).json({ error: '...', licenseStatus: lic.status });
  if (lic.status === 'SUSPENDED')        return res.status(403).json({ error: 'Subscription expired. Please contact administrator.', licenseStatus: lic.status });
  if (lic.status === 'ARCHIVED')         return res.status(403).json({ error: '...', licenseStatus: lic.status });
  next(); // ACTIVE and READ_ONLY may read
}
function requireLicenseWrite(req, res, next) {
  const lic = getTenantLicense(req.user.tenantId);
  if (!lic) return next();
  if (lic.status === 'READ_ONLY') return res.status(403).json({ error: '...disabled until you renew...', licenseStatus: lic.status });
  return requireLicenseRead(req, res, next);
}
```

Wired onto `PUT /api/data` and `POST /api/auth/add-staff` (write), `GET /api/data`, `GET /api/data/users`, `GET /api/auth/sessions` (read). Deliberately **not** wired onto `logout`, `sessions/:id/revoke`, the legacy `renew-license`, or `GET /api/license/status` — a suspended tenant must still be able to log out, and the legacy renewal path is how an old-model tenant escapes any block entirely, untouched.

## The sweep — automatic time-based transitions

No job scheduler exists in this codebase. `runLicenseTransitionSweep()` in `server/local.js` follows the exact same `setInterval` pattern already used for session cleanup (`_runSessionCleanup`), running once at boot and every `LICENSE_SWEEP_INTERVAL_MS` (default 15 minutes, env-overridable so tests can shrink it):

1. `ACTIVE` → `READ_ONLY` where `expires_at < now`.
2. `READ_ONLY` → `SUSPENDED` where `read_only_since < now - 30 days` — also calls `sessions.revokeAllTenantSessions(db, tenantId)`, a new export mirroring the existing per-user `revokeAllUserSessions` minus the user filter.
3. `SUSPENDED` → `ARCHIVED` where `suspended_since < now - 365 days`.

Every transition writes a `STATUS_CHANGED` row to `license_history`. See `server/test/license-state-machine.test.js` for the full chain verified end-to-end by backdating timestamps directly in the test's own SQLite handle.

## Device control (Phase 8)

`trusted_devices` tracks one row per `(tenant_id, user_id, device_id)`. `device_id` is the client's existing `generateBrowserMachineId()` browser fingerprint (already built for the offline desktop machine-lock, reused here — zero new crypto surface; the tradeoff is that clearing storage/incognito looks like a "new device"). `POST /api/auth/login` accepts an **optional** `deviceId`:

- Absent → byte-identical old behavior (old client builds unaffected).
- Present, known device → `last_login_at` touched, no PIN-beyond-PIN step (first-login-trusts-automatically already covers "subsequent logins just need PIN").
- Present, new device, under `tenant_licenses.device_limit` → auto-trusted.
- Present, new device, at limit → `403 {code:'DEVICE_LIMIT_REACHED'}` **before** a session is created.

Admin can view/remove/reset-all/increase-limit via `/api/admin/tenant-licenses/:id/devices*` (see AdminOperations.md). Removal is soft (`is_active=0`) — never hard-deleted, preserving an audit trail.

## Offline grace (Phase 7)

`tenant_licenses.last_verified_at` / `offline_grace_days` (default 15) are the anchor. `GET /api/license/status` is deliberately ungated by the license middlewares — its entire purpose is reporting status regardless of what that status is — and updates `last_verified_at = now()` via a single `UPDATE ... RETURNING *` on every successful call (an earlier SELECT-then-UPDATE version reported the *previous* call's timestamp instead of the current one, leaving a fresh tenant's very first check with no usable anchor; fixed and covered by `server/test/license-offline-grace.test.js`).

Client-side, `pssRefreshLicenseStatus()` (`app/ShopERP_Pro_v8.html`) runs at boot (guarded by `SHOPERPRO_API_URL`, so offline/local-WiFi/Electron installs are unaffected) and every 5 minutes after:

- Online: caches `lastVerifiedAt`/`offlineGraceDays`/`status`, branches on status.
- Offline (fetch throws/times out): falls back to the cached status if `now <= lastVerifiedAt + offlineGraceDays`; otherwise shows a dedicated "reconnect required" screen. A tenant that has *never* verified even once is always blocked — there is no bootstrap bypass.

This is the one piece with no automated browser test — the decision logic lives entirely client-side and this repo has no browser test runner (every other test talks to `local.js` over HTTP). `server/test/license-offline-grace.test.js` scopes itself honestly to the server contract (`lastVerifiedAt`/`offlineGraceDays` correctness); the client timer math is a manual-verification item, matching this repo's own existing practice for browser-only checks.

## Backfill for pre-existing tenants

Every tenant created before this feature shipped gets a `tenant_licenses` row automatically, every boot (idempotent `WHERE NOT EXISTS` anti-join in `local.js`) — not a one-off manual SQL file like the 2026-07-19 precedent, because this is universally required by shipping the feature at all, not a one-time historical bug fix. Full mapping and reasoning in DatabaseDesign.md.

## What deliberately isn't here

- No payment gateway, no microservices, no enterprise complexity — per the spec's own constraints.
- No feature/module gating — Step 4's module selection (Billing/Inventory/Repair/WhatsApp/Reports) is captured for admin visibility only; every module still ships to every tenant regardless of plan.
- The offline desktop machine-lock system is not merged, extended, or touched.
