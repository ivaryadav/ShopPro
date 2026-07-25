# ShopERP Pro — Security Review

Each item below was checked against the actual source (file + line referenced where applicable), not assumed. Severity is rated for the product's realistic current deployment (a shop's own PC, or a small self-hosted server on a shop's WiFi) — a couple of items would rate higher for a genuinely multi-tenant SaaS at scale, and are noted as such.

---

## Findings

### F-1. `JWT_SECRET` falls back to a random per-boot value if unset — Low severity, Medium annoyance
`server/local.js:34`. Not exploitable — a fresh random secret each boot is *safer* than a shared default. But it means every server restart invalidates every session with no warning, which will read as a bug ("everyone got logged out for no reason") once sessions become something users rely on across a shift. **Recommend fixing before Phase 3B**: make `JWT_SECRET` required at startup (fail loudly with a clear message, matching the pattern already used for `stripLicenseSecrets()` failing loudly rather than silently degrading).

### F-2. No server-side, centralized audit log — Medium severity
Every audit event today (`_auditLog()`, `app/*.html`) writes into `DB.auditLog[]`, which is part of the same per-tenant JSON blob as business data. Consequences: (a) it's subject to the same last-write-wins overwrite as everything else — a security-relevant event can be silently lost if two devices save around the same time; (b) Ravi has zero cross-tenant visibility — there is no way to ask "show me every failed login across all shops in the last hour" because nothing server-side is being logged beyond ephemeral `console.log` lines (`server/local.js`, checked exhaustively — no persisted security event table exists today). This is the direct justification for Phase 3E's audit log expansion, and it should be a **server-side table**, not an extension of the client-side array.

### F-3. `PUT /api/data` has no conflict detection despite the data existing to support it — Medium severity (data-integrity, not confidentiality)
`GET /api/data` returns `updatedAt`; `PUT /api/data` computes and stores a fresh `updated_at` but never reads or compares the old one first (`server/local.js:548-575`). Two concurrent writers → silent data loss, no error, no warning to either user. Detailed in `DependencyMap.md §3` and `ArchitectureReview.md §8`. Rated Medium rather than High because it requires actual concurrent multi-device use to trigger, which is currently rare — but Phase 3A/D are specifically designed to make it common, which is why this belongs in the same implementation wave.

### F-4. Rate limiting is in-memory and per-process — Low severity at current scale
`server/local.js:157-172`. Resets on restart, doesn't survive a process crash-loop, and (by design, since this is a LAN-facing shop server) is IP-keyed, which is fine when every legitimate request comes from the same WiFi. If this server is ever exposed to the open internet rather than a shop's LAN, this becomes more relevant — worth a note rather than a fix, since the deployment model today is local/self-hosted.

### F-5. Tenant isolation — No finding (verified sound)
Every server query scoping by tenant uses `req.user.tenantId`, sourced only from the verified JWT. Exhaustively grepped every occurrence of `tenantId` in `server/local.js` (11 call sites) — zero take it from `req.body` or `req.params`. This is the one area I'd flag as **already meeting the bar for "thousands of shops"** as-is.

### F-6. CSRF — No finding (not applicable to this design)
Auth is Bearer-token-in-header, not cookie-based, and CORS is configured to require an explicit origin allowlist in production (`_allowedOrigins`, `server/local.js:178-189`; defaults open only when unconfigured, which matches the local-dev/local-LAN use case). A malicious page cannot forge an authenticated request without already having read access to the token, which is a token-theft (XSS) problem, not a CSRF one.

### F-7. XSS surface — Needs a dedicated pass, not fully audited here
The codebase consistently uses `escHtml()`/`esc()` when building `innerHTML` from user-entered strings (customer names, notes, etc.) in the places sampled during this review. A full XSS audit would mean checking all ~200+ `innerHTML =` assignments individually against their data sources — that's a real, bounded task but a separate one from this architecture review; flagging it as **not yet exhaustively verified** rather than either passing or failing it. Recommend as a fast-follow, not blocking Phase 3.

### F-8. Privilege escalation — No finding in the paths checked
Role checks (`_requireRole` client-side, `role !== 'owner'` server-side for `add-staff` and `renew-license`) are consistently present on the sensitive endpoints reviewed. The desktop-side `doImport()` hardening (capping imported user roles, stripping dangerous keys) was already addressed in a prior security pass per the existing commit history (`d46e598`) — confirmed still in place.

### F-9. PIN / credential storage — Sound, with one note
Bcrypt server-side, SHA-256(machineId::salt::pin) client-side, no plaintext PIN found in either localStorage or the SQLite schema. Note: the client-side hash's salt is a fixed string (`'::shoperpro::pin::v1'`) plus the machine ID, which is derivable — meaning a 4-6 digit PIN is theoretically brute-forceable offline by anyone with access to the raw `DB` blob *and* the ability to compute the same machine ID. This is a low-severity, expected characteristic of local-only PIN auth (the real security boundary for the desktop build is physical/OS-level device access, same as a phone's lock screen), not a regression to fix.

### F-10. Replay attacks — Partially mitigated
JWT `expiresIn: '7d'` limits the replay window but doesn't eliminate it — a captured token is valid for up to 7 days with no way to invalidate just that one token today (see F-1's session-table proposal, which directly closes this: revocation becomes possible without secret rotation).

---

## Expanded Audit Log — proposed event set (Phase 3E)

Server-side table, additive alongside the existing client-side `DB.auditLog[]` (which stays, for the desktop/offline case where there's no server to log to):

```
security_audit_log(
  id, tenant_id, user_id, event_type, detail, ip, device_id, session_id, created_at
)
```
Event types: `login`, `logout`, `login_failed`, `new_device`, `device_removed`, `device_revoked`, `license_verified`, `license_expired`, `session_killed`, `session_revoked_by_admin`, `pin_reset`, `pin_reset_requested`, `admin_action` (with `detail` carrying which action). Every one of these maps to an existing server code path (login/register/renew/reset-pin/toggle-user/tenant-status) that already has the data in hand — this is a matter of adding one `INSERT` per path, not new business logic.

---

## Summary

Two genuinely important issues were found and fixed **before** this review, in the licensing work earlier this engagement (secret exposed to every browser; no server-side key verification). Nothing at that severity remains. What's left is exactly what you'd expect from an app that grew from a single-shop desktop tool into a multi-tenant hosted service without yet building session/device/audit infrastructure to match — none of it is an active exploit today, all of it is real groundwork for the features requested in Phase 3.
