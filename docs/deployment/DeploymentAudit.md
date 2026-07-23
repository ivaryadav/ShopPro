# Deployment Audit — Phase 0

Status: **PASS — no critical issues. Proceeding to Phase 1.**

Scope note: this and every doc under `docs/deployment/` belong to a separate, later engagement than `docs/architecture-review/` (which already contains its own `GitReadinessReport.md` and `MigrationSafetyReport.md` from a prior phase). To avoid overwriting that history, this phase's deliverables — using the exact filenames requested — live in this new `docs/deployment/` directory instead.

## ✓ Debug code / `console.log`

One stray debug trace found and **removed** (zero-risk, non-functional — logging only, no behavior change): `app/ShopERP_Pro_v8.html`, inside the legacy-localStorage-key migration path, logged which legacy key was found. It carried no sensitive data and was already neutralized in practice by the app's own console-silencing hardening (the "App Hardening" IIFE overrides `console.log` to a no-op before `bootApp()` runs) — but it shouldn't have been in source at all, so it's gone.

Every remaining `console.log`/`console.error` in `server/*.js` is intentional operational output, not debug leftovers:
- `server/local.js` — the startup banner (server URL, admin key prefix), `[Sessions]`/`[Admin]`/`[License]` action logs (audit-trail-style, e.g. "Tenant 5 renewed → yearly").
- `server/logger.js` — a documented, deliberate thin wrapper around `console.log`/`console.error` (not a logging framework — see the file's own header comment), the *implementation* of structured logging, not a leftover.
- `server/scripts/lint.js` — a CLI dev-tool's own output, not shipped application code.
- `server/index.js` (the vestigial Postgres/cloud entry point, not the production `local.js`) — a boot confirmation and a DB-connected confirmation, same category as `local.js`'s banner.

No `debugger;` statements anywhere. (One devtools-*detection* trick in `app/ShopERP_Pro_v8.html` constructs the string `'debugger'` dynamically as an anti-tampering timing check — reviewed in the prior `SecurityHardeningReview.md` engagement, intentional, not a leftover breakpoint.)

## ✓ TODO / FIXME

Zero matches for `TODO`, `FIXME`, or `XXX:` anywhere in `server/*.js`, `server/routes/*.js`, `server/middleware/*.js`, `server/scripts/*.js`, or `app/ShopERP_Pro_v8.html`.

## ✓ Temporary files

No `.tmp`, `.bak`, `~`, `.orig`, `.swp`, or Finder metadata (`.DS_Store`, `._*`) files are tracked by git — confirmed via `git ls-files`. Untracked `.DS_Store`/`._*` files exist on disk (normal for macOS) and are already correctly ignored by `.gitignore`'s `*.DS_Store` / `._*` rules.

## ✓ Duplicate files

Every tracked file's MD5 checksum is unique — no exact-duplicate files anywhere in the repository (verified by hashing all of `git ls-files` and checking for any repeated hash). No stale versioned copies either (e.g. no `ShopERP_Pro_v7.html` sitting alongside `v8.html`, no `local.js.bak`).

## ⚠ Dead route (flagged, not removed)

`GET /api/admin/tenants` in `server/local.js` is defined but not called anywhere in `app/ShopERP_Pro_v8.html` — superseded by the richer `GET /api/admin/web-users` and the newer `GET /api/admin/tenant-licenses`. **Not removed**: deleting an endpoint is a feature/behavior change, and this phase is explicitly scoped to deployment readiness only, not business-logic changes. Recommend removing in a dedicated follow-up cleanup PR, not this one.

## ⚠ Env var naming — flagged for accuracy, not changed

Two pre-existing, out-of-scope-to-fix inconsistencies, both fully documented (not silently papered over) in `EnvironmentSetup.md`:
1. **`ALLOWED_ORIGIN`** (singular — read by `server/index.js`, the vestigial Postgres/cloud mode) vs **`ALLOWED_ORIGINS`** (plural — read by `server/local.js`, the actual production entry point). Pre-existing naming drift between the two parallel server implementations; renaming either would be a code change beyond this phase's scope.
2. This deployment request's own Phase 3 list uses the names `SERVER_PORT` and `DATABASE_PATH` — the code actually reads `PORT` and `DB_PATH`. `.env.example` and `EnvironmentSetup.md` use the **real** names the code reads, with the requested names noted as aliases, specifically so a deployment doesn't set a variable that silently does nothing.
3. **`EMAIL_ENABLED`** — requested for documentation in Phase 3, but no code currently reads this variable (SMTP is unconditionally mandatory at boot via `server/mailer.js`, added in the prior licensing-feature phase). Documented in `.env.example` as a **reserved, not-yet-wired** placeholder — explicitly labeled as such, not implied to control real behavior it doesn't yet control. Wiring it up would be a business-logic change, out of scope here.

## ✓ Secrets scan (full detail in `GitReadinessReport.md`)

`server/.env` has never been committed at any point in git history (`git log --all --full-history -- server/.env` returns nothing). No private keys, `.pem`/`.p12` files, AWS access keys, Stripe live keys, or Slack tokens found anywhere in tracked file contents. The only committed "secret-shaped" strings are the pre-existing, intentionally-committed `MASTER_SECRET` (the offline-license shared constant, by design — client and server must agree on it) and the default `ADMIN_KEY` hash (has a documented override path and is already flagged via `GET /health`'s `adminKeyIsDefault` field) — both reviewed in the prior `SecurityReview.md`/`SecurityHardeningReview.md` engagement, not new findings.

## Noted but not touched — pre-existing, unrelated to the app

- `.codex/` — an untracked directory belonging to an unrelated dev tool (Codex CLI config), not part of ShopERP Pro. Recommend adding to `.gitignore` since it's local tool state, not project source — left as a recommendation, not actioned, since it predates this audit and its disposition is the user's call.
- `ShopERP_Pro_Architecture_Reference.pdf` — an untracked, large reference PDF at repo root. Recommend either committing it intentionally (if it's meant to ship with the repo) or adding it to `.gitignore` (if it's a local reference only) — again the user's call, not actioned here.

## Verdict

No critical issues. Nothing here blocks proceeding to Phase 1 (Git Hygiene).
