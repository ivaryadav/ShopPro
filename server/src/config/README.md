# config/

Single configuration layer. Every module here reads `process.env` exactly once (via `env.js`) and exposes a typed, validated config object — nothing else in `server/src/` should read `process.env` directly.

- `env.js` — declarative spec + fail-fast validation for every environment variable this backend uses.
- `database.js`, `jwt.js`, `mail.js`, `logger.js`, `license.js`, `storage.js` — one typed config module per concern.
- `index.js` — `getConfig()` aggregates all of the above into one object; import this unless a test specifically needs one loader in isolation.

`JWT_SECRET` and full SMTP config fail loudly if missing (matching `server/local.js`'s existing posture for both) — everything else has a safe, explicit default.
