# ADR-0004: Incremental Frontend Modularization

## Status
Accepted

## Context

`app/ShopERP_Pro_v8.html` is a single 16,883-line, ~2.46 MB file containing the entire UI for both product modes — no components, no build step, no module boundaries. ADR-0001's enterprise reconstruction is primarily a backend/data-layer effort (ADR-0002 through ADR-0005 are all backend concerns), but freezing the frontend entirely for the length of a multi-phase backend reconstruction risks the opposite problem: every backend phase that changes an API contract would need a corresponding frontend change made under time pressure at the end, in one large, hard-to-verify pass, against a file with no internal structure to safely change pieces of in isolation.

## Decision

The frontend is **not** rewritten as its own dedicated phase or big-bang effort. Instead, **each backend phase that changes an area of functionality extracts the corresponding frontend code for that same area into its own module as part of that phase**, while keeping the application working end-to-end throughout (the strangler-fig pattern: new, isolated modules progressively replace equivalent code paths inside the monolith, rather than everything being cut over at once). For example: when Phase 2 (Auth & Tenant Core) rebuilds authentication against MariaDB, that same phase extracts the login/session-handling frontend code out of the monolith into its own file/module, wired to call the same API contract as before.

No phase may leave the application in a state where `app/ShopERP_Pro_v8.html` fails to load or a previously-working screen breaks. Extraction happens only for the specific area a given phase already touches on the backend — this ADR does not authorize a general frontend refactor as a side effect of unrelated backend work.

## Alternatives considered

- **Freeze the frontend entirely until all backend phases are done**: rejected — by the user's explicit instruction ("Do not freeze the frontend... Extract it module-by-module while maintaining compatibility") and because it defers the frontend's own real technical debt indefinitely, right up until it becomes urgent.
- **Rewrite the entire frontend in one dedicated phase**: rejected — explicitly ruled out ("Do not rewrite it all at once"), and would roughly double this reconstruction's total scope and risk.
- **Extract frontend modules ahead of backend changes, speculatively**: rejected — extracting a module before its backend counterpart changes risks building the wrong abstraction and doing the work twice; tying extraction to the phase that already has a concrete reason to touch that area keeps the two changes coherent and reviewable together.

## Consequences

- Frontend modularization progress is uneven and driven by backend phase order, not by which parts of the frontend are objectively worst — that's an accepted tradeoff for keeping the app shippable throughout.
- `app/ShopERP_Pro_v8.html` will, for most of this reconstruction, be a shrinking monolith with a growing set of extracted modules alongside it, rather than either a single file or a fully modular app — this is an intentional, transitional state, not a stopping point in itself.
- Each phase's "files changed" and "test results" sections must show the frontend extraction's own verification (the extracted module produces byte-for-byte the same behavior as the code it replaced), not just the backend's.
