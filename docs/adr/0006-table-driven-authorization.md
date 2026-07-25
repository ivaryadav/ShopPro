# ADR-0006: Table-Driven Authorization (Role/Permission)

## Status
Accepted

## Context

`docs/architecture/DomainModel.md` (Phase 1.5) confirmed that no Permission entity exists anywhere in the current codebase — every authorization decision is a hardcoded `role !== 'owner'`-style string comparison at the point of use, and `role` itself is a free-text column, not a reference to any Role table. Phase 2's mission explicitly lists `Role` and `Permission` under "IMPLEMENT ONLY," and its database section explicitly requests `roles` and `permissions` tables — but Phase 2's own governing instruction is equally explicit: "Preserve existing business behavior exactly... Do NOT 'fix' any of these [Phase 1.5 findings]."

These two instructions are only in tension if building the tables would change who is allowed to do what. This ADR resolves that tension.

## Decision

Build real `roles`, `permissions`, and `role_permissions` tables, and a real `AuthorizationService` that looks up permissions dynamically through them — but seed the tables so the **resulting authorization decisions are byte-for-byte identical to today's hardcoded checks**, and verify that equivalence with dedicated tests (`server/src/tests/authorization.test.js`).

Concretely: `roles` is seeded with exactly the hosted server's own two role values (`owner`, `staff` — not the desktop app's five, per ADR-0003). `permissions` is seeded with exactly the three real, in-scope gates found in `server/local.js` (`sessions:view`, `sessions:revoke`, `staff:add` — confirmed by grepping every `role !== 'owner'` check in the file: 4 hits total, one of which, `/api/auth/renew-license`, is Licensing-domain and out of scope, leaving exactly 3). `role_permissions` grants all three to `owner` and none to `staff` — reproducing `local.js`'s exact `if (req.user.role !== 'owner')` outcome for every one of these three checks, just resolved through a table lookup instead of a string literal. Note `GET /api/data/users` (list users) is deliberately *not* seeded with any permission — `local.js` has no role gate on it at all, so seeding one would invent a restriction rather than extract one.

This is not "fixing" the absence of a Permission model (which Phase 2 was told not to do) — it's building the structural piece Phase 2 was explicitly asked to build, in a way that provably preserves today's behavior rather than inventing new authorization outcomes.

## Alternatives considered

- **Keep hardcoded role-string checks, translate them 1:1 into the new middleware without a Permission table at all**: rejected — this would satisfy "preserve behavior" but not the mission's explicit request to implement `Permission` as a first-class part of this phase's layered architecture.
- **Build a full, generic RBAC system with an admin UI for assigning permissions to roles dynamically**: rejected as over-scoped for this phase — nothing in the mission asks for a permission-management UI, and inventing one would be new feature development, explicitly out of scope ("NOT feature development").
- **Seed `permissions` with a broader, "more correct" set of capabilities than the four found in code today** (e.g., separate `staff:remove`, `staff:edit` even though `local.js` has no such distinct gate): rejected — this would be inventing behavior, not extracting it. Only the four gates that actually exist today are seeded.

## Consequences

- A future phase that migrates the desktop app's five-role model, or adds real per-permission admin tooling, has a real table to extend rather than starting from hardcoded strings — but this ADR does not decide what that extension looks like.
- The `role_permissions` table is genuinely load-bearing in Phase 2 (the new `AuthorizationService` reads it on every check), not decorative schema — this is a real behavior-preserving migration, not a stub.
- If a future phase ever needs a permission this table doesn't have, that's a new decision (and likely a new ADR), not an automatic consequence of this one.
