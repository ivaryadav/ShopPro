# Wave 1 — Session Architecture

Status: **Implemented**. Addresses `RiskAssessment.md` R-2, R-4 and `SecurityReview.md` F-1, F-10.

## Why

Before this wave, the server was fully stateless about sessions: one JWT, one shared secret, 7-day expiry, no record of who was logged in from where, no way to revoke a single device. A stolen token stayed valid for up to 7 days with zero recourse short of rotating the secret and logging out *everyone*. `SessionArchitecture.md`'s proposal in the earlier review is what's implemented here.

## Schema

```sql
CREATE TABLE user_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT UNIQUE NOT NULL,   -- opaque random 48-hex-char id, embedded in the JWT as `sid`
  tenant_id           INTEGER NOT NULL,
  user_id             INTEGER NOT NULL,
  jwt_id              TEXT,                   -- current access token's jti, rotates on refresh
  device_id           TEXT,                   -- nullable, unused until Wave 2 (Trusted Devices)
  login_time          TEXT DEFAULT (datetime('now')),
  last_activity        TEXT DEFAULT (datetime('now')),
  current_page        TEXT,                   -- unused for display until Wave 3 (Presence); populated by heartbeat now
  status               TEXT NOT NULL DEFAULT 'active',  -- active | revoked | expired
  refresh_token_hash  TEXT,                   -- SHA-256 of the refresh token; raw token never stored
  ip_address          TEXT,
  browser             TEXT,
  os                  TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);
```
Indexed on `session_id`, `(tenant_id, user_id)`, and `refresh_token_hash`. `server/sessions.js` owns all reads/writes to this table — `server/local.js` never queries it directly except for the one ownership check in the revoke endpoint.

## Token design

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, signed with `JWT_SECRET` | Opaque random (32 bytes, hex) |
| Lifetime | 15 minutes | 30 days, **rotates on every use** |
| Carries | `userId, tenantId, role, shopName, sid (session_id), jti` | Nothing — it's a bearer credential, looked up by its hash |
| Stored client-side | `sessionStorage` (tab-scoped, as before) | `localStorage` (survives tab close / restart — the one storage-location expansion this wave makes, justified by the 30-day requirement; see the note in `_api.refreshToken()`, `app/ShopERP_Pro_v8.html`) |
| Checked by | `requireAuth`: signature + expiry + **session row is `active`** | `POST /api/auth/refresh`: hash lookup + `active` status |

**Refresh rotation**: every call to `/api/auth/refresh` issues a brand-new access token *and* a brand-new refresh token, and immediately invalidates the one just used (its hash is overwritten in the row). A stolen-but-unused refresh token becomes worthless the moment the real owner refreshes; presenting an already-rotated token is rejected outright rather than silently issuing another pair — verified in `server/test/wave1-sessions.test.js` ("reusing an already-rotated refresh token is rejected").

**Why session-backed, not just a shorter JWT**: a shorter-lived JWT alone would reduce the *window* of a stolen token but still couldn't be revoked mid-flight. The session row is what makes `POST /api/auth/sessions/:id/revoke` and `POST /api/auth/logout` actually work — a revoked session's access token is rejected by `requireAuth` immediately, even though the JWT itself is still cryptographically valid and unexpired. Verified directly: `server/test/wave1-sessions.test.js` mints a valid token, revokes its session, and confirms the very next authenticated request with that same token gets `401`.

## Endpoints added

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/auth/refresh` | none (refresh token in body) | Exchange a refresh token for a new access+refresh pair |
| `POST /api/auth/logout` | requireAuth | Revoke the session tied to the presented token |
| `POST /api/auth/heartbeat` | requireAuth | Update `last_activity` (+ optional `current_page`) |
| `GET /api/auth/sessions` | requireAuth, owner only | List the caller's tenant's active sessions |
| `POST /api/auth/sessions/:sessionId/revoke` | requireAuth, owner only | Force-logout a specific session — ownership-checked against the caller's own `tenant_id`, returns `404` (not `403`) for a cross-tenant attempt so a session ID from another shop can't even be confirmed to exist |

`login` and `register` are modified in place (not new endpoints) to call `sessions.createSession()` instead of the old standalone `makeToken()`; their response shape is unchanged except for the addition of a `refreshToken` field alongside the existing `token` field, so every existing client call site that reads `res.token` keeps working without modification.

## Client changes

- `_api` gained `refreshToken()/setRefreshToken()/clearRefreshToken()` and a `_tryRefresh()` that dedupes concurrent refresh attempts (real risk now that access tokens expire every 15 minutes and several in-flight requests could 401 around the same moment).
- `_api.get()` and `_api.put()` now attempt one silent refresh-and-retry before falling back to today's "session expired, show login" behavior.
- **`_api.post()` was deliberately left unchanged** — every existing caller (`login`, `register`, `renew-license`, `verify-license`) reads `res.error` from a normal JSON body for legitimate 401/409 business responses ("wrong PIN", "key already registered"), not session-expiry signals. Routing `post()` through the same interception broke login's own error handling during this wave's testing (a wrong-PIN 401 would have been swallowed into an incorrect "session expired" redirect) — caught and reverted before the change ever reached the live server. Documented as a deliberate asymmetry, not an oversight.
- A new invisible heartbeat (`_initSessionHeartbeat()`, `app/ShopERP_Pro_v8.html`) posts every 60s while the app is open in web mode — no UI, just keeps `last_activity` meaningful on quiet screens and lays the groundwork for Wave 3 to read the same `current_page` signal over a WebSocket instead of polling.
- `wbSwitchAccount()` — the genuine "sign out of this shop" action — now calls `/api/auth/logout` (best-effort, non-blocking) before clearing local tokens. **`doLogout()` was deliberately left untouched**: it's the "switch which local staff PIN is active" gesture (`showUserSelectScreen()`), a different and pre-existing workflow that must keep the underlying session alive — confirmed by reading its call sites before touching anything, per Rule #2.

## Electron / desktop mode

**Entirely unaffected.** `server/sessions.js` is a server-only module; nothing in `app/ShopERP_Pro_v8.html`'s desktop-only code paths (machine-locked activation, local PIN check) references it, and the client's session/refresh-token additions are all gated behind `SHOPERPRO_API_URL` being set, which Electron never sets. Confirmed: `main.js`/`preload.js` were not touched by this wave (file mtimes unchanged).
