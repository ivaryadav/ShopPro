# routes/

HTTP layer only. A route file:

- Declares the Express route (method + path).
- Applies the relevant `middleware/` (auth, validation, rate limiting).
- Calls exactly one `controllers/` handler (or, for trivial cases, a single `services/` or `repositories/` call directly — see ADR-0005 on when a service layer is justified).
- Contains **no SQL**, **no business logic**.

Organized by bounded context — see `auth/`, `licenses/`, `tenants/`, `users/`. A new domain gets its own subfolder here, not a growing flat file.
