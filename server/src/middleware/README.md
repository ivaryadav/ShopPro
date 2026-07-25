# middleware/

Express middleware: authentication/session checks (`requireAuth`, `requireAdminKey`-equivalents), authorization/license-status gating (`requireActive`, `requireLicenseRead`/`requireLicenseWrite`-equivalents — see the tenant-status consistency fix this must not regress, `docs/independent-audit/FinalBlockerResolution.md`), rate limiting, and request validation wiring. No SQL — a middleware calls into `services/`/`repositories/` for anything it needs to check, it doesn't query the database directly.
