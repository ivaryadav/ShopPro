# Phase 3 Review — Operations Domain Architecture

Named `Phase3Review.md` rather than the generic `PhaseReview.md` the mission requested, matching the collision-avoidance precedent set in `docs/architecture/Phase2Review.md`.

## Scope delivered

A fully evidenced storage-strategy decision (Option C — Hybrid) for the entire Operations domain, two ADRs (API error strategy, storage strategy), and complete schema designs for 8 normalized entities plus a JSON-column design for Configuration — with every deviation from current behavior explicitly flagged for approval rather than silently decided. **No code was written** — no migrations, no repositories, no services — per the mission's explicit "implementation is secondary... design first" instruction.

## What made this phase's evidence-gathering different from a generic "should we use SQL or NoSQL" debate

The decision wasn't made from a general preference — it traces to one specific, re-verified mechanical fact: `PUT /api/data` requires the entire tenant dataset on every write, with no partial-update path (`server/local.js:1656-1670`, re-read directly in this phase, not assumed from memory). That single fact, combined with each entity's actual growth profile (Sales/Repairs unbounded and continuous vs. Configuration static and bounded), is what produces a *hybrid* recommendation rather than a uniform one — the analysis in `docs/architecture/OperationsDomainAnalysis.md` treats each entity on its own evidence, and two entities (Configuration, and the rejected Invoice table) land on the opposite side of the normalize/don't-normalize line from the rest for reasons specific to them, not as exceptions grudgingly carved out of a blanket rule.

## A branch-management error caught and corrected mid-phase

This phase was initially branched from `refactor/phase1.5-domain-model` alone — which turned out to be missing Phase 1's ADRs 0001-0006 and all of Phase 2's implementation, both of which this phase's own mission explicitly lists as required reading and both of which this phase's new documents cite throughout. Caught before any further work compounded the gap; the branch was rebuilt from `feature/phase2-identity-tenant-core` (which has Phase 1 + Phase 2) and merged with `refactor/phase1.5-domain-model` (Phase 1.5's domain-model docs) to get a single branch with complete ancestry. One trivial merge conflict (the pre-commit hook's cosmetic version-bump line, present differently on both branches) was resolved in favor of the more advanced side. The existing test suite and lint were re-verified passing after the merge, not assumed clean.

## Decisions explicitly deferred to a future, separately-approved phase (not silently made here)

- Whether `inventory_items` uses soft-delete (`is_deleted`) instead of `local.js`'s current hard-delete — proposed, flagged, not decided unilaterally.
- Whether to finally enforce SKU uniqueness, resolve the Customer-phone-uniqueness inconsistency, add a `technician_id` to repairs, build a real RecurringExpense scheduler, or unify Payment's per-context method restrictions — every one of these is named explicitly in `docs/database/OperationsSchemaDesign.md` as a real gap or inconsistency the design surfaces but does not resolve, because resolving any of them would be a business-rule change, not a storage-format decision.
- Whether `customers.balance`/`loyalty_points` should ever become real — explicitly dropped from the design (dead columns aren't carried forward) rather than either implemented or silently kept.

## Recommendation for Phase 4

The natural next phase is implementing this design against MariaDB — starting with `inventory_items` and `customers` (the lowest-migration-difficulty, least design-sensitive tables per `OperationsDomainAnalysis.md`), before attempting `sales`/`sale_items` and the new `payments` table (the highest-difficulty, most design-sensitive pieces). `payments`' unification specifically should get its own focused design review before implementation begins, given it's consolidating three currently-incompatible shapes, not just moving one array into one table.
