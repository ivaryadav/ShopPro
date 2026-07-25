# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately to the maintainer: **+91 94511 00556** (WhatsApp/call), the same contact the application itself surfaces to customers. Include:

- A description of the vulnerability and its impact.
- Steps to reproduce (or a proof of concept).
- Which mode it affects — Offline Desktop, Web-Hosted (SaaS), or both.
- The version/commit you tested against.

You will get an acknowledgement, and a fix or mitigation plan will follow once the issue is confirmed. There is currently no bug-bounty program.

## Supported versions

| Version | Supported |
|---|---|
| `v1.0.x` (current) | Yes — security fixes only, see `docs/architecture/BranchingStrategy.md` for the `hotfix/*` process |
| `v2.0.0` (in development) | Security review required before release, per `docs/adr/` and `docs/independent-audit/` |
| Anything pre-`v1.0.0` | No |

## What this project already does

This codebase has been through a full, from-scratch independent security audit (`docs/independent-audit/`) covering authentication, tenant isolation, session management, license/subscription authorization, and API-level review, plus a dedicated hardening pass (`docs/production-hardening/`) that removed a hardcoded admin bypass, migrated admin authentication to bcrypt, closed a login user-enumeration gap, and added standard security headers. See those directories for full, honest detail — including residual risk that is disclosed rather than hidden. This project does not claim to have "no vulnerabilities."

## Known, disclosed residual risk

See `docs/independent-audit/ReleaseApproval.md` for the current, itemized list (as of the last audit) — including third-party CVEs pending a breaking-version upgrade, CORS defaults that should be tightened per-deployment, and accessibility gaps. This file will be kept current as that list changes.
