# logging/

Centralized logger for `server/src/`. Levels: `DEBUG < INFO < WARN < ERROR < FATAL`. Import `getLogger()` from `index.js`; don't construct `Logger` directly outside of tests.

- `levels.js` — level ordering/threshold logic.
- `Logger.js` — the class: dispatches a structured entry to every configured transport, supports `.child(context)` for request-scoped loggers (e.g. `logger.child({ tenantId, requestId })`).
- `transports/consoleTransport.js` — stdout/stderr, JSON lines.
- `transports/fileTransport.js` — daily-rotated file under `config.logDir`.
- `transports/cloudTransport.js` — **not implemented**, a documented interface stub so a later phase can add a real provider without changing `Logger.js`.

**No `console.log` outside this module** is the rule for everything under `server/src/` — existing `server/local.js`/`server/logger.js` are untouched and keep using their own convention until a later phase explicitly migrates them.
