# API — Identity & Tenant Core (Phase 2)

All paths match `server/local.js` exactly ("API compatibility preserved where possible"). Mounted by `server/src/app.js`, not by `local.js` — this is a parallel implementation, not yet cut over (`docs/architecture/Architecture.md`).

| Method | Path | Middleware chain | Notes |
|---|---|---|---|
| `POST` | `/api/auth/login` | `rateLimit(10, 5min)` | Mobile+PIN, optional `deviceId`. Anti-enumeration (`docs/security/Authentication.md`). |
| `POST` | `/api/auth/refresh` | `rateLimit(30, 5min)` | Rotates both tokens; grace window for multi-tab races. |
| `POST` | `/api/auth/logout` | `requireAuth` | Revokes the current session only. |
| `POST` | `/api/auth/heartbeat` | `requireAuth` | Updates `last_activity`/`current_page`. Legacy (no-`sid`) tokens get `{ok:true, legacy:true}`. |
| `GET` | `/api/auth/sessions` | `requireAuth, requireActive, requirePermission('sessions:view')` | Owner-only, matches `local.js:1069`. |
| `POST` | `/api/auth/sessions/:sessionId/revoke` | `requireAuth, requirePermission('sessions:revoke')` | Owner-only; 404 (not 403) if the session belongs to another tenant, matching `local.js:1078`'s deliberate choice not to confirm the ID exists. |
| `POST` | `/api/auth/add-staff` | `requireAuth, requireActive, requirePermission('staff:add')` | Owner-only. |
| `GET` | `/api/data/users` | `requireAuth, requireActive` | **No permission gate** — matches `local.js` exactly; path kept under `/api/data` for compatibility despite being Identity-domain data. |
| `GET` | `/health` | none | Reports DB connectivity (`checkDatabaseHealth`), not a static stub. |

## Response shapes

Every response field name matches `local.js`'s exact JSON shape — see each route's controller (`controllers/authController.js`, `sessionController.js`, `userController.js`) for the literal object returned. Errors always follow `errors/errorHandler.js`'s shape: `{ error: { code, message, details? } }` — this is new (Phase 1), `local.js` returns a flatter `{ error: string }`; a client written against `local.js` would need updating for this once/if this system is ever actually deployed behind the same client. Not a concern for Phase 2 itself, since nothing is cut over yet — flagged here for whichever future phase does the cutover.

## Not implemented in this phase

`POST /api/auth/register`, `POST /api/auth/signup`, `POST /api/auth/renew-license`, `POST /api/admin/reset-user-pin`, `POST /api/admin/toggle-user` — see `docs/architecture/Architecture.md`'s "explicitly NOT implemented" section for why each is out of scope.
