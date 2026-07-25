# errors/

Centralized error system. Eight typed error classes (`ValidationError`, `AuthenticationError`, `AuthorizationError`, `ConflictError`, `DatabaseError`, `BusinessRuleError`, `NotFoundError`, `InfrastructureError`), all extending `AppError`, plus `errorHandler.js` — the **one** global Express error-handling middleware. No route/controller/service under `server/src/` should format its own error response or write its own try/catch-and-log — throw the right typed error and let `errorHandler.js` do it consistently.

See `errorHandler.js`'s own header comment for the operational vs. non-operational distinction that decides whether an error's message is safe to return to a caller.
