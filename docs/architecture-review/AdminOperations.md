# Admin Operations — Registrations Queue & Tenant Licenses Dashboard (Phase 9)

Status: **Implemented**. Two new admin screens in the existing shared admin console (`app/ShopERP_Pro_v8.html`) — not the deprecated older duplicate screen set. Both are `X-Admin-Key`-gated (the same mechanism already used by every other `/api/admin/*` endpoint — no new admin-auth system was introduced) and only shown when `SHOPERPRO_API_URL` is set (web/hosted mode), matching how the existing "Web Users" nav item is gated.

## Registrations queue (`adm-registrations`)

`admPageRegistrations()` / `admLoadRegistrations()` — mirrors the existing `admPageWebUsers()`/`admLoadWebUsers()` fetch-and-render pairing exactly. Fetches `GET /api/admin/registrations`, renders one card per `PENDING_APPROVAL` tenant: shop name, owner, mobile, email, an email-verified badge, registration date, requested plan/devices/modules.

| Button | Calls | Notes |
|---|---|---|
| ✅ Approve | `POST /api/admin/registrations/:id/approve` | Refuses (400) until email is verified. Auto-defaults to a 14-day TRIAL if nothing was pre-assigned. |
| ✕ Reject | `POST /api/admin/registrations/:id/reject {reason}` | Reason entered via `_glassModal` (the existing pause/terminate confirmation-dialog pattern). Moves to `ARCHIVED`. |
| 💬 Call/WhatsApp | client-side `wa.me` link | No server call — just opens WhatsApp to the stored mobile. |
| 📞 Log Call | `POST .../call-note {note}` | Distinct `CALL_LOGGED` event from a plain note — this is the audit trail entry for "I called them." |
| Assign Plan | `POST .../assign-plan {planCode, billingCycle, deviceLimitOverride?}` | `_glassModal` with 3 fields. |
| Start Trial | `POST .../start-trial` | One-click shortcut, no dialog. |
| Generate Key | `POST .../generate-license {regenerate?}` | If a key already exists, a `confirm()` asks before regenerating. |
| Add Note | `POST .../notes {note}` | Free-text, logged as `NOTE_ADDED`. |

## Tenant licenses dashboard (`adm-tenant-licenses`)

`admPageTenantLicenses()` / `admLoadTenantLicenses()` — fetches `GET /api/admin/tenant-licenses`, one table row per tenant (all statuses, not just pending). Every Phase 9 field: shop name, plan, status (color-coded), expiry date, days remaining, devices used/limit, requested modules, last login, registration date.

| Button | Calls | Notes |
|---|---|---|
| Extend | `POST .../extend {days}` | `_glassModal`, defaults to 30 days. See RenewalFlow.md for the exact date-math. |
| Suspend / Reactivate | `POST .../suspend {reason}` or `.../reactivate` | The button shown depends on current status — Suspend for `ACTIVE`/`PENDING_APPROVAL`, Reactivate for `SUSPENDED`/`READ_ONLY`/`ARCHIVED`. Suspend kills all sessions immediately. |
| Kill Sessions | `POST .../kill-sessions` | Independent of any status change — for "I think this device was stolen" without actually suspending the subscription. |
| Devices | `GET .../devices` in a modal | See below. |
| History | `GET .../history` in a modal | Full `license_history` timeline, newest first. |
| Note | `POST .../notes {note}` | Same as the registrations-queue action. |

### Devices modal

A lightweight custom modal (`_customModalShell()` — same overlay/click-outside-to-close convention as the existing `_glassModal()`, but built for freeform/variable-length content rather than a fixed field+action shape). Lists every device with its user, browser, OS, last login, and a Remove button (soft-remove, `is_active=0` — never hard-deleted). Also has an inline device-limit input (`POST .../devices/limit {deviceLimit}`) and a Reset All button (`POST .../devices/reset-all`, confirmed via a native `confirm()` since it's a blast-radius action affecting every device at once).

### History modal

Every `license_history` row for the tenant: event type, from→to status transition (if any), free-text detail, actor (`system` or `admin`), timestamp. This is the literal implementation of Phase 9's "View Audit History" — nothing is summarized or filtered, every event type listed in DatabaseDesign.md's `event_type` glossary can appear here.

## `event_type` glossary (`license_history.event_type`)

| Event | Logged by |
|---|---|
| `REGISTERED` | `POST /api/auth/signup` |
| `EMAIL_VERIFIED` | `GET /api/auth/verify-email` |
| `APPROVED` | `POST /api/admin/registrations/:id/approve` |
| `REJECTED` | `POST /api/admin/registrations/:id/reject` |
| `PLAN_ASSIGNED` | `POST /api/admin/tenant-licenses/:id/assign-plan` |
| `TRIAL_STARTED` | `POST /api/admin/tenant-licenses/:id/start-trial` |
| `KEY_GENERATED` / `KEY_REGENERATED` | `POST /api/admin/tenant-licenses/:id/generate-license` |
| `EXTENDED` | `POST /api/admin/tenant-licenses/:id/extend` |
| `STATUS_CHANGED` | The sweep (automatic expiry/suspend/archive transitions) and manual `suspend`/`reactivate` |
| `DEVICE_REMOVED` | `POST /api/admin/tenant-licenses/:id/devices/:rowId/remove` |
| `DEVICES_RESET` | `POST /api/admin/tenant-licenses/:id/devices/reset-all` |
| `DEVICE_LIMIT_CHANGED` | `POST /api/admin/tenant-licenses/:id/devices/limit` |
| `SESSIONS_KILLED` | `POST /api/admin/tenant-licenses/:id/kill-sessions` |
| `NOTE_ADDED` | `POST /api/admin/tenant-licenses/:id/notes` |
| `CALL_LOGGED` | `POST /api/admin/tenant-licenses/:id/call-note` |
| `BACKFILLED` | The automatic backfill of pre-existing tenants at first boot after this feature shipped (see DatabaseDesign.md) |

## Endpoint reference

```
GET  /api/admin/registrations
POST /api/admin/registrations/:tenantId/approve
POST /api/admin/registrations/:tenantId/reject          { reason }
GET  /api/admin/tenant-licenses
GET  /api/admin/tenant-licenses/:tenantId/history
POST /api/admin/tenant-licenses/:tenantId/assign-plan    { planCode, billingCycle, deviceLimitOverride? }
POST /api/admin/tenant-licenses/:tenantId/start-trial
POST /api/admin/tenant-licenses/:tenantId/generate-license  { regenerate? }
POST /api/admin/tenant-licenses/:tenantId/extend         { days } | { newExpiresAt }
POST /api/admin/tenant-licenses/:tenantId/suspend        { reason }
POST /api/admin/tenant-licenses/:tenantId/reactivate
POST /api/admin/tenant-licenses/:tenantId/kill-sessions
POST /api/admin/tenant-licenses/:tenantId/notes          { note }
POST /api/admin/tenant-licenses/:tenantId/call-note      { note }
GET  /api/admin/tenant-licenses/:tenantId/devices
POST /api/admin/tenant-licenses/:tenantId/devices/:rowId/remove
POST /api/admin/tenant-licenses/:tenantId/devices/reset-all
POST /api/admin/tenant-licenses/:tenantId/devices/limit  { deviceLimit }
```

All are `requireAdminKey`-gated (timing-safe `X-Admin-Key` header comparison, same as every pre-existing admin endpoint). Verified across `server/test/license-admin-approval.test.js`, `license-devices.test.js`, and `license-suspension.test.js`.
