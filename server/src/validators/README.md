# validators/

Shared input-validation schemas/functions, used by `routes/`/`middleware/` before a request ever reaches a controller or service. Throws `errors/ValidationError` on failure — validators don't format their own HTTP response, they let `errorHandler.js` do it.

Empty in Phase 1 — populated starting Phase 2 alongside the routes that need validation (mobile-number format, PIN format, email format, etc. — currently inline regex checks in `server/local.js`, e.g. `/^\d{4,6}$/.test(pin)`, moved here so the same rule isn't re-typed in every handler that needs it).
