# Architecture Decision Records

An ADR records a significant, hard-to-reverse architectural decision: why it was made, what alternatives were considered, and what its consequences are. It is a permanent record — an ADR is never edited to pretend a past decision was different; if a decision changes later, a new ADR supersedes the old one and says so explicitly.

## When an ADR is required

Add one before implementing, not after, when a change:

- Introduces or removes a dependency the whole project will rely on (a database engine, a major framework).
- Changes the shape of the layered architecture (routes/middleware/services/repositories).
- Changes how a cross-cutting concern works (auth, config, logging, error handling).
- Would be expensive or risky to reverse once other code depends on it.
- Affects the offline desktop product's or the SaaS product's fundamental trust model.

A bug fix, a new endpoint that follows existing patterns, or a UI tweak does not need one.

## Format

```
# ADR-NNNN: <Title>

## Status
Proposed | Accepted | Superseded by ADR-XXXX

## Context
What situation/problem led to needing this decision.

## Decision
What was decided.

## Alternatives considered
What else was on the table, and why it wasn't chosen.

## Consequences
What this makes easier, what it makes harder, what it costs.
```

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-enterprise-reconstruction.md) | Enterprise Reconstruction | Accepted |
| [0002](0002-mariadb-canonical-database.md) | MariaDB Canonical Database | Accepted |
| [0003](0003-desktop-offline-architecture.md) | Desktop Offline Architecture (Out of MariaDB Scope) | Accepted |
| [0004](0004-incremental-frontend-modularization.md) | Incremental Frontend Modularization | Accepted |
| [0005](0005-layered-backend-architecture.md) | Layered Backend Architecture | Accepted |
| [0006](0006-table-driven-authorization.md) | Table-Driven Authorization (Role/Permission) | Accepted |
