# ADR-0007: API Error Response Strategy

## Status
Accepted

## Context

`server/local.js` returns errors as a flat `{ error: "<string>" }`. Phase 1's `server/src/errors/errorHandler.js` returns `{ error: { code, message, details? } }` — built before this specific conflict was analyzed, and flagged as an open, undecided compatibility gap in `docs/security/Security.md` and `docs/database/MigrationNotes.md` (Phase 2): *"a real API-shape difference... whichever future phase does the actual cutover must either update every client call site... or add a compatibility-shaping layer."* This ADR makes that decision explicitly, as promised.

## Decision

**The structured `{ error: { code, message, details? } }` shape is the permanent standard for every future `server/src/` endpoint, superseding `local.js`'s flat-string convention.** It is not reverted for compatibility's sake.

Reasoning:
1. It is strictly more capable — a stable `code` lets a client branch on error type programmatically (`AUTHENTICATION_ERROR` vs. `VALIDATION_ERROR`) without parsing a human-readable sentence; `details` carries structured context (e.g., which field failed) that a flat string can't.
2. It is already built, tested (Phase 1's `errors.test.js`), and in active use across every Phase 2 endpoint — reverting it would mean throwing away working infrastructure to match a format that itself was never a deliberate design decision in `local.js` (it's simply what `res.status(x).json({error: '...'})` naturally produces when nobody has built a shared error-response layer yet).
3. The compatibility cost is bounded and one-time: only the client code that reads `res.error` as a string needs updating (to read `res.error.message` instead), and only once, at whichever future phase performs the actual production cutover (Phase 9, per `docs/adr/0001-enterprise-reconstruction.md`) — not an ongoing, growing cost paid by every future endpoint built between now and then.

## Alternatives considered

- **Revert to `local.js`'s flat-string shape for byte-compatibility**: rejected — this permanently caps error-response quality at the level of code that was never designed as a contract, to avoid a one-time, bounded update cost that has to happen at cutover regardless of which shape is chosen (the client needs *some* update to point at the new backend at all).
- **Support both shapes simultaneously (a compatibility-mode flag)**: rejected — adds real, permanent complexity (every error path must produce two representations) to avoid a problem that only exists for a few months until cutover; not worth the maintenance burden for a temporary bridge.
- **Decide this later, at cutover time**: rejected — this is exactly the kind of decision `docs/adr/README.md` says must be made explicitly, before implementation continues to depend on an undecided contract; Phase 2 already flagged it as open, and leaving it open into Phase 3+ just means more endpoints get built against an ambiguous contract.

## Consequences

- Every future phase's endpoints use `errors/errorHandler.js`'s existing typed error classes (`ValidationError`, `AuthenticationError`, etc.) — no new error-formatting code should be written per-endpoint.
- Whichever future phase cuts over to this backend for real must update `app/modules/auth.js`'s `_api._fetch()` (and any other client code reading `res.error` as a string) to read the new shape — a known, scoped, tracked task, not a surprise.
- `local.js` itself is never changed to match this shape — it keeps its own, original contract for as long as it's the running production server, per this whole reconstruction's "zero behavior change to the deployed application" principle.
