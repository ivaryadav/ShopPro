# Renewal Flow (Phase 10)

Status: **Implemented**. See LicenseArchitecture.md for the surrounding state machine.

## The rule

> "Renewal must: Update expiry date. Nothing else. No data restore. No migration. Customer logs in and continues exactly where they left off."

This is cheap and safe by construction: license status/expiry lives entirely in `tenant_licenses`, completely separate from `tenant_data` (the JSON blob holding inventory/sales/repairs/customers/etc.). Renewal touches only the former. There is no restore step because there was never a data-loss step to restore from — expiry and suspension only ever gate access, never mutate or archive the underlying data.

## `POST /api/admin/tenant-licenses/:tenantId/extend`

```json
{ "days": 30 }
```
or
```json
{ "newExpiresAt": "2026-09-01T00:00:00.000Z" }
```

Behavior:
- **Guard clauses** — refuses with `400` if the tenant is `PENDING_APPROVAL` (must Approve first — a registration isn't a subscription yet) or `ARCHIVED` (must Reactivate first — an explicit, separate action, since a 365-day-lapsed account escaping expiry silently via a routine renewal call would be a surprising side effect).
- **Extending from the current expiry, not from today** — if `expires_at` is still in the future (early renewal), the new expiry is `current_expires_at + days`. If it's already past (expired/READ_ONLY/SUSPENDED), the new expiry is `now + days`. A shop renewing 5 days early doesn't lose those 5 days.
- **Reactivation is automatic** — if the tenant was `READ_ONLY` or `SUSPENDED`, `extend` sets `status='ACTIVE'` and clears `read_only_since`/`suspended_since` in the same call. The response's `reactivated: true/false` field tells the admin UI whether this happened.
- Logs `EXTENDED` to `license_history` with the old/new status and the resulting `expires_at`.
- **Touches nothing else** — no write to `tenant_data`, `users`, or `trusted_devices`. Verified directly: `server/test/license-renewal.test.js` asserts `tenant_data`'s `data` column and `version` number are byte-identical before and after an extend call.

## Worked example

A BASIC/monthly tenant, approved on day 0 (`expires_at` = day 30):

| Day | Event | `status` | `expires_at` |
|---|---|---|---|
| 0 | Approved | `ACTIVE` | day 30 |
| 25 | Owner enters an invoice, saves data (`version` 1→2) | `ACTIVE` | day 30 |
| 30 | Sweep fires (expiry passed) | `READ_ONLY` (`read_only_since`=day 30) | day 30 |
| 35 | Owner logs in, views the day-25 invoice fine, tries to add a new one — blocked (403, "your subscription has expired... contact your administrator") | `READ_ONLY` | day 30 |
| 40 | Admin calls `extend {days: 30}` | `ACTIVE` (`read_only_since` cleared) | day 70 (40 + 30, *not* 30 + 30 — the expired old date isn't used as the base) |
| 41 | Owner logs in — same data, same `version`, same invoice from day 25, picks up exactly where they left off | `ACTIVE` | day 70 |

If instead the shop had renewed *early*, on day 20 (`expires_at` still day 30, not yet `READ_ONLY`): the base used is the *current* `expires_at` (day 30), since it's still in the future — `extend {days: 30}` → new `expires_at` = day 30 + 30 = **day 60**, not day 20 + 30 = day 50. `reactivated: false`, since the tenant was never blocked.

## What doesn't change on renewal

- `tenant_data.data` — untouched.
- `tenant_data.version` — untouched (renewal makes no write to this table at all).
- `users` — untouched; the owner's PIN, mobile, and role are exactly as before.
- `trusted_devices` — untouched; devices trusted before expiry remain trusted after renewal, no re-trust step required.
- `requested_plan_code`, `requested_modules`, `requested_devices_bucket` — the customer's *original* Step 1–4 signup answers are preserved as history even through a renewal that changes the actual `plan_code`/`billing_cycle` via a separate `assign-plan` call.

## Relationship to `assign-plan`

`extend` only ever changes `expires_at` (+ status if reactivating) — it does not change `plan_code`, `billing_cycle`, or `device_limit`. Changing what plan a tenant is *on* (e.g. upgrading BASIC→PREMIUM at renewal time) is a separate admin action, `assign-plan`, documented in AdminOperations.md. This keeps the two concerns — "how long" vs. "what tier" — independently callable, matching how a real support conversation usually goes ("renew me for another year" vs. "actually, upgrade me to Premium too").

## Verification

`server/test/license-renewal.test.js` (20 assertions): extend restores ACTIVE from READ_ONLY, clears the timer columns, computes the correct base date for both the expired and early-renewal cases, rejects PENDING_APPROVAL/ARCHIVED tenants, accepts an explicit `newExpiresAt`, and — the central claim — confirms `tenant_data` is byte-identical before and after, with the shop's actual saved data (a repair job entry) intact and editable again immediately after renewal.
