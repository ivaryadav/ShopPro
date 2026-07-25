# tests/

This new backend's own test suite, built up alongside `src/` starting Phase 2 — unit tests per repository/service, integration tests per route, migration tests per `src/database/migrations/` entry.

**Not a replacement (yet) for `server/test/`.** That existing 21-file, 436-assertion suite tests `server/local.js` and must keep passing, unmodified, throughout this entire reconstruction — it is the regression baseline every later phase's "prove equivalent behavior" claim is checked against, right up until Phase 9 retires `local.js` for good.
