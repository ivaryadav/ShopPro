# ShopERP Pro v1.0.0

ERP for Indian mobile-repair and mobile-phone shops. Ships in two modes:

- **Offline Desktop** (Electron) — one shop, one PC, no internet required,
  license key tied to that machine.
- **Web / Hosted (SaaS)** — self-service registration, email verification,
  admin approval, and a subscription lifecycle (trial/basic/premium),
  served from `server/local.js` to any device on the shop's network or
  the internet.

Both modes share the same application (`app/ShopERP_Pro_v8.html`); the
Electron shell only changes how that page is delivered and licensed.

## Offline Desktop Mode

### Prerequisites
Install Node.js from https://nodejs.org (LTS version)

### Steps
1. Unzip this folder
2. Open terminal / command prompt in this folder
3. Run:
   npm install
4. Then run:
   npm start

ShopERP Pro will open as a standalone desktop window. On first run it will
ask for an activation key tied to that machine — contact your software
provider for one; there is no universal or demo key.

### Build Installer (optional)

To build a .exe installer for Windows:
   npm install
   npm run build-win

The installer will be in the dist/ folder.

To build for Mac:
   npm run build-mac

To build for Linux:
   npm run build-linux

## Web / Hosted Mode (SaaS)

See `server/DEPLOY.md` for the full deployment guide (Local WiFi server or
public hosting behind a reverse proxy) and `server/.env.local.example` for
the required environment variables. Quick local start:

   cd server
   npm install
   cp .env.local.example .env    # fill in JWT_SECRET, SMTP_*, etc.
   npm run start:local

Then open the server's URL in a browser and use "Register" to create a new
shop — self-service signup, email verification, and admin approval are all
built in. See `docs/architecture-review/RegistrationFlow.md` for the full
flow and `docs/architecture-review/LicenseArchitecture.md` for the
subscription lifecycle (trial, renewal, read-only, suspension).

## Documentation

- `docs/architecture-review/` — SaaS licensing/registration architecture
- `docs/deployment/` — production deployment checklist and environment setup
- `docs/production-hardening/` — security hardening (Issues 1-4) and final
  regression report
- `docs/independent-audit/` — independent Release Approval Board review,
  final blocker resolution, and the release decision

## Keyboard Shortcuts (Desktop mode)
Ctrl+R    Reload
Ctrl+0    Reset zoom
Ctrl++    Zoom in
Ctrl+-    Zoom out
F11       Full screen
Ctrl+Q    Quit
