# routes/auth/

Login, logout, token refresh, session listing/revocation, and (web-hosted mode) admin authentication. Populated starting Phase 2 (Auth & Tenant Core) — ported from `server/local.js`'s existing, tested auth handlers and `server/sessions.js`, rebuilt against the repository layer instead of raw `better-sqlite3` calls.
