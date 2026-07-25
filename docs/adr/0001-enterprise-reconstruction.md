# ADR-0001: Enterprise Reconstruction

## Status
Accepted

## Context

ShopERP Pro reached `v1.0.0`: a working, independently security-audited, production-hardened SaaS + offline-desktop product with zero onboarded customers and zero production business data. With no live customer data at risk and no backward-compatibility obligation to an installed base, this is the lowest-cost point in the product's lifetime to fix architectural debt that accumulated during rapid feature development — before real customers make every change expensive.

That debt, documented across this project's own audits (`docs/independent-audit/DatabaseAudit.md`, `DevOpsAudit.md`, `ReleaseApproval.md`), includes: two parallel, independently-built backend implementations (`server/local.js` on SQLite, `server/index.js` on Postgres — the latter never fully built out or tested); no layered separation between HTTP handling and data access in the real (SQLite) implementation; a 16,883-line single-file frontend with no build step; ad hoc `console.log` logging; no centralized error handling; no formal migration framework (only inline, additive `ALTER TABLE` calls); and a Git history that never used branches, semantic versioning, or protected branches.

## Decision

Undertake a phased "v2.0" enterprise reconstruction: one backend, one database (MariaDB — see ADR-0002), strict layered architecture (see ADR-0005), centralized configuration/logging/error-handling, a real migration framework, a professional Git workflow with protected branches and PR review, semantic versioning with release/rollback/migration notes, and complete architecture/API/security/deployment documentation.

This is executed in independently-completable phases (Phase 1: foundations and governance; Phase 2: auth/tenant core; ... Phase 9: cutover and decommission of the old implementations), each requiring explicit approval before the next begins. Business logic, API behavior, and the offline desktop product's behavior are not to change as a side effect of this reconstruction — only the implementation underneath changes, verified equivalent at each phase via the existing (and, as each phase lands, newly rebuilt) test suite.

## Alternatives considered

- **Keep iterating on `server/local.js` as-is**: rejected — the accumulated debt (two backends, no layering, no real migrations) would only compound, and "zero customers" is a uniquely low-cost window to fix it that will not recur.
- **Rewrite everything in one pass**: rejected — far too large and risky to verify correctness of in one session or even one sitting; the project's own prior engagements (SaaS licensing, security hardening, independent audit) already demonstrated that phased, independently-verified work with explicit approval gates is what this codebase's history responds well to.
- **Do nothing until real customers exist**: rejected per the explicit mission — architecture quality is the stated priority precisely because no customer data is yet at risk.

## Consequences

- A meaningfully longer path to the next customer-facing feature, in exchange for a foundation that scales past a single maintainer and a single server.
- Two working backends (`local.js`, `index.js`) and one working database engine (SQLite) will eventually be deleted (Phase 9) — not before the new MariaDB-backed system is proven equivalent via full regression.
- Every subsequent phase must independently verify "application remains deployable" and "zero business behavior change" before proceeding — this is the standing acceptance criterion for the whole reconstruction, not just Phase 1.
