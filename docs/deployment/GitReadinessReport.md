# Git Readiness Report — Phase 1

Status: **PASS.**

Note: `docs/architecture-review/GitReadinessReport.md` already exists from a prior engagement (session-architecture hardening) — this is a distinct, later report for the production-deployment phase, deliberately placed in `docs/deployment/` rather than overwriting that history.

## `.gitignore` — before vs. after

Before this phase:
```
node_modules/
dist/
*.DS_Store
._*
server/.env
server/*.db
server/*.db-shm
server/*.db-wal
server/backups/
```

Gaps against this phase's checklist: no general `.env`/`.env.*` pattern (only the specific `server/.env` path was covered — a root-level `.env` or a differently-located one wouldn't have been), no `logs/`, no `tmp/`, no `coverage/`, no `build/`.

After:
```
node_modules/
dist/
build/
coverage/
*.DS_Store
._*
.env
.env.*
!.env.example
!.env.*.example
server/.env
server/.env.*
!server/.env.example
!server/.env.*.example
server/*.db
server/*.db-shm
server/*.db-wal
server/*.db-journal
server/backups/
logs/
*.log
tmp/
*.tmp
```

Every item on the checklist is now covered:

| Required | Covered by |
|---|---|
| `node_modules` | `node_modules/` |
| `.env` | `.env`, `.env.*`, `server/.env`, `server/.env.*` (with explicit `!...example` exceptions so templates stay trackable) |
| `.env.*` | as above |
| `backups` | `server/backups/` |
| `logs` | `logs/`, `*.log` |
| `tmp` | `tmp/`, `*.tmp` |
| `coverage` | `coverage/` |
| `dist` (build artifacts) | `dist/`, `build/` |
| database backups | `server/backups/` |
| SQLite database | `server/*.db`, `-shm`, `-wal`, `-journal` |

**SQLite database is correctly excluded, not intentionally versioned** — `server/shoperpro.db` is runtime state (tenant data), never meant to ship in the repo.

Verified with `git check-ignore -v`: `server/.env` → ignored; `.env.example` / `server/.env.local.example` → **not** ignored (the negation rules work); `logs/test.log`, `tmp/foo.tmp` → ignored. No previously-tracked file was newly hidden or dropped by this change (`git status` before/after shows the identical set of tracked files).

## Secrets scan

- **`server/.env` has never been committed**, at any point in git history: `git log --all --full-history -- server/.env` returns zero commits.
- **`.env`/`.env.*` files ever added to the repo, anywhere in history**: only `server/.env.example` (a template with placeholder values, safe by design).
- **No API keys, private keys, or credential files tracked**: `git ls-files` contains no `.pem`, `.key`, `.p12`, `.pfx`, `id_rsa`, or `credentials`-named files.
- **No hardcoded live-looking secrets in tracked file contents**: scanned for AWS access-key shape (`AKIA...`), PEM private-key headers, Stripe live-key prefix (`sk_live_`), and Slack token shape (`xox...`) — zero matches.
- **JWT secrets**: never hardcoded. `server/local.js` requires `JWT_SECRET` from the environment and refuses to boot without it (fails loudly, by design — see `SecurityReview.md` F-1 from the prior engagement).
- **SMTP credentials**: never hardcoded. `server/mailer.js` requires `SMTP_HOST/PORT/USER/PASS/FROM` from the environment and refuses to boot without them (added in the SaaS-licensing phase, same fail-loud posture as `JWT_SECRET`).
- **Two pre-existing, already-reviewed committed constants** (not new findings, not the kind of "secret" this checklist is scanning for): `MASTER_SECRET` in `app/ShopERP_Pro_v8.html` and `server/license.js` (a shared constant the offline-license scheme requires both client and server to know — not a per-deployment credential), and a default `ADMIN_KEY` hash in `server/local.js` (has a documented override path via the `ADMIN_KEY` env var and is already surfaced via `GET /health`'s `adminKeyIsDefault` field). Both were reviewed in `docs/architecture-review/SecurityReview.md` and `SecurityHardeningReview.md`.

## Working-tree hygiene

- No duplicate files (checksum-verified across every tracked file).
- No stale/backup file variants tracked.
- Untracked, pre-existing items unrelated to the app noted for the user's disposition, not actioned: `.codex/` (unrelated dev-tool config — recommend adding to `.gitignore`) and `ShopERP_Pro_Architecture_Reference.pdf` (a reference doc — recommend either committing intentionally or ignoring).

## Verdict

Git hygiene is production-ready. No secrets found in the working tree or history. `.gitignore` now fully covers the required categories. Proceeding to Phase 2.
