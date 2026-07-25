# ADR-0003: Desktop Offline Architecture Is Out of MariaDB Scope

## Status
Accepted

## Context

ADR-0002 makes MariaDB the sole database for the hosted/SaaS backend. But ShopERP Pro ships a second, entirely separate product mode: the offline Electron desktop app (`main.js` loading `app/ShopERP_Pro_v8.html`), whose entire premise is running on one shop's own PC with **no internet connection required**. It stores all data (`DB.inventory`, `DB.sales`, `DB.customers`, etc.) in the browser/Electron process's own `localStorage`, and its license activation is validated entirely client-side against a machine-specific key (`server/license.js`'s crypto engine, mirrored client-side) — there is no server round-trip in this mode today.

Read literally, "MariaDB is the ONLY supported database" could be misread as requiring this offline mode to also depend on MariaDB — which would require a permanent network connection to a database server, contradicting the product's core value proposition for shops with unreliable or no internet access.

## Decision

**The offline desktop product's data storage and licensing model is explicitly out of scope for the MariaDB migration.** It continues to use client-side `localStorage` and its existing client-side license validation, unmodified by ADR-0001's reconstruction. "One database" (ADR-0002) applies to the hosted/SaaS backend (`server/`) only — the one thing this reconstruction is rebuilding a server-side data layer for in the first place.

## Alternatives considered

- **Force the desktop app to always require a MariaDB-backed server connection**: rejected — this deletes the offline product's reason to exist and would be a customer-facing breaking change to a currently-shipping mode, not an internal architecture improvement.
- **Give the desktop app an embedded, local MariaDB instance**: rejected — MariaDB is a client/server database requiring a running server process; bundling and managing that inside a single-PC Electron install is a materially different and far heavier engineering problem than this reconstruction is scoped to solve, for a benefit (relational queries over what is currently a handful of arrays) that hasn't been shown to be needed.
- **Leave it ambiguous and decide file-by-file during implementation**: rejected — this is exactly the kind of decision ADR-0001's governance section says must be made explicitly and documented before implementation touches it, not inferred silently.

## Consequences

- Two genuinely different data-persistence models will continue to coexist in this codebase long-term: MariaDB for hosted/SaaS, `localStorage` for offline desktop. This is not "two databases" in the sense ADR-0002 forbids — it is one product intentionally supporting two deployment shapes with different constraints, a distinction worth stating explicitly so it isn't later "fixed" by someone unaware of why it's this way.
- If a future business decision changes the desktop product's requirements (e.g., requiring periodic sync to the hosted backend), that is a new, separate ADR — not an automatic consequence of this reconstruction.
