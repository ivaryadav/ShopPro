# ShopERP Pro — Dependency Map

Scope: `app/ShopERP_Pro_v8.html` (537 functions), `server/local.js` (7 functions + 20 routes), `server/license.js` (6 functions), `main.js`, `preload.js`. Cross-referenced against `docs/` is not assumed to exist elsewhere — this is the first architecture documentation for the project.

Method note: this map is built on a verified, complete function inventory (100% of the 537 client-side functions cross-checked against the source, zero missed) produced earlier this engagement, plus full reads of both server files and targeted re-verification of every claim below (tenant isolation, JWT config, concurrency control, audit log coverage, localStorage usage) against the current source in this pass. It is not a fresh blind re-read of all 16,045 lines — it is that inventory plus this pass's targeted verification, which is the more reliable way to re-confirm a codebase this size without drifting from what's actually on disk.

---

## 1. Screen → Function → Data → API chains

### Auth / Login (Desktop)
```
User-select screen
  → selectUserForLogin() → loginPinPress()/loginPinDel() → loginPinSubmit()
  → _verifyPin(user, entered)  [SHA-256(machineId::salt::pin), local hash compare]
  → startApp(user)
  → DB.users[]  (localStorage, DB_KEY)
  → no server call — fully offline
```

### Auth / Login (Web/Hosted)
```
Portal screen → pssOpenPanel('login') → pssLogin()
  → POST /api/auth/login  { mobile, pin }
  → server: bcrypt.compareSync(pin, users.password_hash)
  → JWT issued (7d expiry, no refresh) → sessionStorage['shoperpro_token']
  → GET /api/data → tenant_data.data → DB (client)
  → _syncLicenseFromServer(res) → DB.settings.{licenseExpiry,licensePlan}
  → continueBootApp() → showUserSelectScreen()
```

### Licensing (Desktop, machine-locked)
```
Settings → renewLicense() / new-install → doActivation()
  → getAppMachineId() → generateBrowserMachineId() | Electron fingerprint
  → validateKey(key, machineId)  [client-side crypto engine, app/*.html:3172]
  → DB.settings.{licenseKey,licenseExpiry,licenseExpiryMs,licensePlan,licenseMachineId}
  → no server call
```

### Licensing (Web/Hosted)
```
Registration: pssRegister() → POST /api/auth/register {licenseKey,...}
  → server: license.decodeKey(key, WEB_LICENSE_MID)  [server/license.js:79]
  → tenants.license_key_hash / license_expiry / license_plan
Renewal: renewLicense() → POST /api/auth/renew-license
  → same decodeKey() path, UPDATE tenants
Enforcement: every /api/data, /api/data/users call
  → requireAuth → requireActive  [server/local.js:134]
  → checks tenants.status AND tenants.license_expiry on every request
Admin issuance: admDoGenerate() → POST /api/admin/generate-key (requireAdminKey)
  → license.generateKey() → tenants (via subsequent register/renew)
```

### PIN flow
```
Setup (first run):  beginSetupPin() → setupPinPress()/Del() → setupPinConfirm()
  → _hashPin(pin) → DB.users[].pin (hash only)
Verify (login):      loginPinSubmit() → _verifyPin() → auto-upgrades legacy plaintext PIN to hash on first correct match
Forgot PIN:          showForgotPin() → doForgotPinVerify()
  → owner: validateKeyForReset(key, machineId) [365-day lookback] OR match to stored DB.settings.licenseKey
  → staff: routed to "ask the owner" (no self-service reset)
  → doForgotPinSave() → new _hashPin()
Web PIN reset (admin):  admResetWebPin() → POST /api/admin/reset-user-pin (requireAdminKey)
  → bcrypt.hashSync → users.password_hash
```

### Portal flow (entry point for everything)
```
bootApp() → _migrateLegacySAK() → continueBootApp()
  ├─ ADMIN_DB.customers match by shopName → local pause/terminate check (desktop bookkeeping)
  ├─ DB.settings.activated? → else showScreen('activation-screen')
  ├─ isSuperAdmin()? → bypass to startApp()
  ├─ DB.settings.licenseExpiry vs today → showExpiredScreen(daysAgo) or DB._expiryWarning
  ├─ DB.settings.setupDone? → else beginSetupPin()
  └─ showUserSelectScreen()
showPortalSelect() → selectPortal() → { pssClickExisting | pssClickNew | pssAdminLogin | pssClickDemo }
```

### Admin panel flow
See `ArchitectureReview.md §7` for the full two-store split. Short version:
```
pssAdminLogin() [password hash check, client-side ADMIN_PWD_HASH]
  → pageSuperAdmin() → showAdminPage(page)
  → ADMIN_DB.customers (local bookkeeping, localStorage)  ←── most admin screens
  → tenants / users tables (server, real)                 ←── only Web Users + pause/terminate/restore
```

### Data save/load (every screen that mutates DB)
```
Any mutating action (addProduct, saveJob, saveCustomer, addExpense, ...)
  → mutates in-memory DB object directly
  → saveDB()
      Electron / offline:  localStorage.setItem(DB_KEY, JSON.stringify(DB))
      Web/hosted:           (same local write, PLUS a periodic/on-save PUT /api/data — see RiskAssessment.md R-1 for the write-path gap this implies)
  → PUT /api/data { data: DB }  → tenant_data.data (whole-blob overwrite, no version check)
```

---

## 2. DB table → consumers

| Table / store | Written by | Read by |
|---|---|---|
| `tenants` | register, renew-license, admin generate-key (indirectly), admin/tenant/status | requireActive (every request), verify-license, login, license/status, admin/tenants, admin/web-users |
| `users` (server) | register, add-staff, admin/reset-user-pin, admin/toggle-user | login, admin/web-users |
| `tenant_data` | PUT /api/data (whole-blob) | GET /api/data |
| `cloud_backups` | POST /api/cloud/backup | GET /api/cloud/restore/:keyHash |
| `DB` (client, localStorage `DB_KEY`) | almost every client function in the 13 app modules | almost every render function; `saveDB()`/`loadDB()` are the only two functions that touch localStorage directly |
| `ADMIN_DB` (client, localStorage, Ravi's own browser) | `saveAdminDB()`, all `adm*` mutation functions | all `adm*` render functions |

---

## 3. Circular dependencies, hidden side effects, and race conditions found

1. **`continueBootApp()` ↔ `ADMIN_DB`** — the main app's boot sequence reads `ADMIN_DB.customers` (line ~6359) to check pause/terminate, matched by `shopName` string. This couples the customer-facing boot path to the *admin's own local bookkeeping list in that browser* — in a real multi-device web deployment, a shop's browser has no `ADMIN_DB` of its own (it's per-browser localStorage), so this branch silently no-ops for every hosted customer. Not circular in the graph-theory sense, but a hidden cross-module coupling that only does anything in the single-machine desktop world it was designed for.
2. **`saveDB()` has no caller-side await/lock** — every mutating function calls `saveDB()` synchronously and moves on. In web/hosted mode, if `saveDB()`'s server sync and a second device's sync race, whichever `PUT /api/data` lands last wins, silently. See `RiskAssessment.md R-1`.
3. **`GET /api/data` returns `updatedAt` that nothing ever uses.** (`server/local.js:552` vs `:560-570`) — the field exists, is computed, and is discarded by every current caller. This is exactly the hook a conflict-detection scheme would attach to; right now it's dead weight that *looks* like protection but isn't.
4. **`isSuperAdmin()` bypasses `continueBootApp()`'s license/expiry checks entirely** (line ~6387, checked before the expiry branch) — correct by design (Ravi needs to get in even on an expired demo unit), but it means any code path that reaches `startApp()` before this check runs would also bypass it; worth keeping in mind for the trusted-device work in Phase 3A, which will add new entry points into the login sequence.
5. **Rate limiter state and PIN-lockout state are both in-memory-only** (`_rateBuckets` Map in `server/local.js`; the client's `_getLockState`/`_setLockState` persist to localStorage, so *that* one does survive refresh, but not a server restart in the hosted case since it's client-held). A server restart silently resets all server-side rate-limit counters — not a correctness bug, but relevant to Phase 3B's "brute force protection" ask.

---

## 4. What's already solid (worth preserving as-is per your Rule #4)

- Tenant isolation is structurally sound: every server query scopes by `req.user.tenantId`, sourced only from the verified JWT, never from request body or params. Confirmed by grepping every use of `tenantId` in `server/local.js` — zero exceptions found.
- JWT is Bearer-token-in-header, not cookie-based → CSRF is not a meaningful attack surface here today.
- Token lives in `sessionStorage`, not `localStorage` — cleared on tab close, smaller persistence footprint than the alternative.
- PIN hashing uses a machine-bound salt client-side and bcrypt server-side — no plaintext PIN storage found anywhere in either file.
- The license secret (`MASTER_SECRET`) no longer reaches any browser (fixed earlier this engagement, verified live).
