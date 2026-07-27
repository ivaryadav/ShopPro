# Troubleshooting

## Won't start

**`Error: Missing required platform env var(s): PLATFORM_JWT_SECRET`**
`.env` is missing or doesn't set `PLATFORM_JWT_SECRET`. Copy `.env.example` to `.env` and set it — see [INSTALL.md](./INSTALL.md).

**`EADDRINUSE` / "address already in use"**
Another process is already bound to `PLATFORM_PORT` (default `4100`). Find it: `lsof -iTCP:4100 -sTCP:LISTEN`. Either stop that process or set a different `PLATFORM_PORT` in `.env`.

**`Cannot find module 'better-sqlite3'` or a native-binding load error**
The prebuilt native binary doesn't match your platform/architecture/Node version. Run `npm rebuild better-sqlite3` inside `platform/`, or delete `node_modules` and `npm install` again on the target machine (don't copy `node_modules` between machines with different OS/architecture).

## Login / MFA

**"This account requires MFA" and you've lost your device**
Use one of the one-time recovery codes shown when you first enrolled. If those are gone too: there is no admin-initiated "disable MFA for another platform user" action anywhere in the product — `POST /auth/mfa/disable` is self-service only (it operates on the caller's own account, which is exactly the account that's locked out). Another admin resetting this account's password (**Platform Users** → **Reset Password**) does **not** restore access either, since MFA is enforced independently of the password. The only real recovery path today is direct database access (below) — a deliberate gap, not an oversight: a support-ticket-style MFA bypass for the highest-privilege accounts on a platform that controls every customer's data is exactly the kind of backdoor this system was built to not have. Treat losing both the device and the recovery codes as seriously as losing the only key to the building.

**Account locked: "temporarily locked due to repeated failed login attempts"**
Expected behavior after the configured threshold (Security Settings → Password Policy, default 5 failures / 15 minutes) — wait out `lockout_duration_minutes`, or have another admin unlock it: **Platform Users** → find the account → **Unlock**.

**Direct database recovery (last resort)**
Stop Z-SUPERADMIN first — never edit the database while the process holds it open.
```bash
sudo systemctl stop zsuperadmin
# Clear a login lockout:
sqlite3 platform.db "UPDATE platform_users SET locked_until = NULL WHERE email = 'you@company.com';"
# Force-disable MFA (only when the device AND recovery codes are both lost):
sqlite3 platform.db "UPDATE platform_users SET totp_enabled = 0, totp_secret = NULL, totp_enrolled_at = NULL WHERE email = 'you@company.com';"
sudo systemctl start zsuperadmin
```
The account will be prompted to re-enroll MFA on next login if its role requires it (`OWNER`/`SUPER_ADMIN` do).

## ShopERP adapter shows "not configured" / organizations missing

Check `platform/.env` has both `SHOPERP_BASE_URL` and `SHOPERP_ADMIN_PASSWORD` set, and that the ShopERP instance at that URL is actually running and reachable from the machine Z-SUPERADMIN runs on. **Operations → System Health** shows `services: [{slug: "shoperp", configured, reachable}]` — `configured:false` means the env vars aren't set; `configured:true, reachable:false` means they're set but the connection failed (wrong URL, ShopERP down, network/firewall issue, or the password no longer matches ShopERP's real admin password).

## Webhook creation rejected: "Webhook URLs may not point at localhost, private, or link-local network addresses"

This is intentional SSRF protection added in the v1.0 stabilization pass — a webhook endpoint pointing at internal infrastructure (loopback, RFC1918 ranges, `169.254.169.254` cloud metadata) would let anyone with `manage_products` use the platform's own outbound network access against your infrastructure. Point the webhook at a real external URL. (The one legitimate exception — the automated test suite's own local sink server — is handled internally via `PLATFORM_ALLOW_PRIVATE_WEBHOOKS`, which should never be set in a real `.env`.)

## Maintenance sync between Z-SUPERADMIN and ShopERP looks stale

**Operations → System Health** or **Maintenance Center → Overview** shows sync status per product. A stale/failed sync means: check the Platform API Key ShopERP is using (`ZSUPERADMIN_API_KEY` in ShopERP's own `server/.env`) hasn't been revoked or expired, `ZSUPERADMIN_BASE_URL` on ShopERP's side points at the right host/port, and both processes are actually running. ShopERP keeps enforcing its last-known-good policy while sync is down — this is a monitoring/staleness signal, not an active-incident signal on its own.

## A scheduled job shows `lastStatus: "failure"`

**Operations → Scheduled Jobs** → click the job → its `lastError` field has the real exception message. Common causes: the ShopERP adapter unreachable (affects any job that touches adapter-backed data), an SMTP send failure inside `renewal-reminder` (logged, doesn't fail the whole job — see its own retry-next-run behavior), or a webhook endpoint that's down (affects `webhook-retry`, which just re-schedules and doesn't itself "fail" from one bad delivery). A job's own retry logic (2 retries, 2s apart, per `jobRunnerService`) already ran before it's marked failed — a failure here means it genuinely didn't recover on its own.

## `npm test` fails locally but the code seems right

Confirm you're in `platform/`, not `server/` — they are two entirely separate test suites with separate `package.json`s. `npm run lint` first catches syntax errors (including in the inline `superadmin.html` script) faster than running the full suite.

## Still stuck

Check `docs/Architecture.md` for how a specific subsystem is supposed to work, or `CHANGELOG.md` for which phase introduced it and its original design reasoning.
