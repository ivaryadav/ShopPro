# Registration Flow — Self-Service Signup (Phase 1) & Admin Approval (Phase 2)

Status: **Implemented**. See LicenseArchitecture.md for the surrounding state machine this feeds into.

## The wizard (client)

`app/ShopERP_Pro_v8.html`'s `#pss-panel-register` — a 4-step wizard reusing the exact step-toggle pattern the existing `pss-lic-step1/2/3` "My Existing Shop" wizard already uses, gated behind `pssOpenPanel('register')` → `pssRegStep(1)`.

| Step | Fields | Required? |
|---|---|---|
| 1 | Shop Name, Owner Name, Mobile, Email, PIN | All required. Address, GST — optional |
| 2 | Plan request: Trial / Basic / Premium | Radio, defaults to Trial |
| 3 | Expected devices: 1–2 / 3–5 / More than 5 | Radio, defaults to 1–2 — **informational only**, see below |
| 4 | Modules: Billing / Inventory / Repair / WhatsApp / Reports | Checkboxes, all checked by default — **capture-only**, see below |

Client-side validation (`pssRegValidateStep1()`) mirrors the existing register/login validation exactly: mobile ≥10 digits, PIN 4–6 digits, a basic email regex. Submission (`pssSubmitSignup()`) posts to `POST /api/auth/signup` and, on success, shows a pending-confirmation panel (`#pss-reg-pending`) instead of auto-login — there is nothing to log into yet.

**Two decisions already confirmed with the product owner, not re-litigated here:**
1. Expected-devices is informational for admin sizing — the *enforced* `device_limit` comes from the assigned plan (TRIAL/BASIC=2, PREMIUM=5), admin can override per-tenant.
2. Requested modules are captured for admin visibility only. The app ships every module to every tenant regardless of plan — real per-module feature gating would touch dozens of screens for a benefit not asked for at this phase (spec priority #1, Simplicity; revisit under priority #7, Future Scalability, if ever needed).

## `POST /api/auth/signup` (server)

New endpoint in `server/local.js`, **not** a modification of the legacy `POST /api/auth/register` — that endpoint (requires a license key upfront) is left completely untouched, so any already-published client build that still calls it keeps working unmodified.

Request:
```json
{
  "shopName": "...", "ownerName": "...", "mobile": "9876543210", "email": "...", "pin": "1234",
  "address": "optional", "gst": "optional",
  "requestedPlan": "TRIAL|BASIC|PREMIUM", "requestedDevicesBucket": "1-2|3-5|5+",
  "requestedModules": ["Billing", "Repair", ...]
}
```

Server-side, in order:
1. Validate required fields, mobile format, PIN format, email format (400 on failure — same messages/regexes as the legacy register endpoint).
2. Reject if the mobile is already registered (409) — checked against `users.mobile`, same uniqueness the legacy endpoint already enforces.
3. Resolve `requestedPlan` against `subscription_plans` (defaults to `TRIAL` if omitted or unrecognized).
4. Insert `tenants` (+ `address`/`gst_number`), an owner `users` row (with a 24h email-verify token, hashed — see below), an empty `tenant_data` row (`'{}'`, identical shape to a fresh legacy registration), and a `tenant_licenses` row (`status='PENDING_APPROVAL'`, `requested_plan_code`, `requested_devices_bucket`, `requested_modules` as a JSON array).
5. Log a `REGISTERED` event to `license_history`.
6. Send the verification email (`server/mailer.js`) — failure here is logged but does **not** fail the signup; SMTP is degradable, registration is not.
7. Respond `201 {message, tenantId, status:'PENDING_APPROVAL'}`. **No JWT is issued** — unlike the legacy register endpoint, there's nothing to authenticate into yet.

Verified: `server/test/license-registration.test.js` (22 assertions — validation, successful signup, duplicate-mobile rejection, default-plan fallback, exact DB row shapes for every table touched).

## Email verification (Step 5)

No email infrastructure existed anywhere in this codebase before this feature — see `server/mailer.js` (nodemailer wrapper, `SMTP_HOST/PORT/USER/PASS/FROM` mandatory at boot).

- `crypto.randomBytes(32).toString('hex')` generated at signup, stored as its SHA-256 hash on `users.email_verify_token_hash` with a 24h `users.email_verify_expires`, plaintext embedded once in the emailed link, never persisted in plaintext.
- `GET /api/auth/verify-email?token=...` — public, returns a small static HTML confirmation page (it's a link opened from an email client, not an SPA fetch call). Validates hash + expiry; on success, sets `email_verified_at`, clears the token fields (so it can't be replayed), logs `EMAIL_VERIFIED`.
- `POST /api/auth/resend-verification {mobile}` — rate-limited (3/10min), issues a brand-new token. Deliberately gives an **identical generic response** whether the mobile exists, is already verified, or is genuinely pending — no user enumeration.

Verified: `server/test/license-email-verification.test.js` (16 assertions — invalid/expired/replayed tokens, successful verification, resend behavior including the no-enumeration property).

**Important, and enforced server-side, not just documented:** `POST /api/admin/registrations/:id/approve` refuses to approve a registration whose owner hasn't verified their email yet (`400`). This is a hard precondition, not merely advisory copy in the admin UI.

## Admin approval (Phase 2)

`GET /api/admin/registrations` — the queue, `X-Admin-Key`-gated like every other admin endpoint. Returns every `PENDING_APPROVAL` tenant with shop/owner/mobile/email/requested-plan/requested-devices/requested-modules/registration-date/email-verified-flag — every field Phase 2 asks the dashboard to show.

Admin actions (all under `/api/admin/tenant-licenses/:tenantId/*` except the two below, which are approval-specific):

| Action | Endpoint | Semantics |
|---|---|---|
| Approve | `POST /api/admin/registrations/:id/approve` | Requires `email_verified_at` set. If nothing was pre-configured (no `assign-plan`/`start-trial`/`generate-license` called first), **auto-defaults to a 14-day TRIAL** so Approve is always safe to click standalone. Also auto-generates a license key if one doesn't exist yet. Sets `status='ACTIVE'`, logs `APPROVED`. |
| Reject | `POST /api/admin/registrations/:id/reject {reason}` | No dedicated `REJECTED` state exists (fixed 5-status enum) — reuses `ARCHIVED`, whose "soft, never delete" semantics fit a rejected signup. Logs `REJECTED` with the reason. |
| Call Customer | client-side only | A `wa.me`/`tel:` link built from the stored mobile — no server endpoint needed for the link itself. `POST .../call-note {note}` separately logs a `CALL_LOGGED` history event, distinct from a plain note. |
| Assign Plan | `POST .../assign-plan {planCode, billingCycle, deviceLimitOverride?}` | Sets plan/cycle/device_limit/expiry explicitly. Doesn't change status — can be called before *or* after Approve. |
| Start Trial | `POST .../start-trial` | Shortcut for `assign-plan(TRIAL, 'trial')`. |
| Generate License | `POST .../generate-license {regenerate?}` | `409` if a key already exists and `regenerate` isn't `true`. |
| Add Notes | `POST .../notes {note}` | Free-text, logged as `NOTE_ADDED`. |

Verified: `server/test/license-admin-approval.test.js` (32 assertions across two isolated servers — approve-before-verification rejection, auto-trial defaulting, double-approve rejection, reject→ARCHIVED with data retained, assign-plan/device-limit-override, generate/regenerate-license format+uniqueness, start-trial shortcut).

## Rate limiting

`POST /api/auth/signup`: 5 requests / 10 minutes per IP+path — same posture as the legacy `register` endpoint. `resend-verification`: 3/10min. Both isolated-server test files split their signup calls across multiple `startTestServer()` instances specifically to stay under this limit within a single test run, rather than loosening the limit for testing's sake.
