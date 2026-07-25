# Wave 0 — Conflict Resolution (Optimistic Concurrency on `tenant_data`)

Status: **Implemented**. Addresses `RiskAssessment.md` R-1.

## What changed

`tenant_data` gained two columns:
```sql
ALTER TABLE tenant_data ADD COLUMN version    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenant_data ADD COLUMN updated_by INTEGER;  -- users.id of the last writer
```
Both are additive `ALTER TABLE ADD COLUMN` statements wrapped in the same `try{}catch{}` migration pattern already used throughout `server/local.js` for every prior schema change (`status`, `suspend_reason`, `license_key_hash`, etc.) — existing rows get `version = 1` automatically via the column default, no backfill script needed, no downtime.

### `GET /api/data`
Now returns `{ data, version, updatedAt }` instead of `{ data, updatedAt }`. Purely additive — any caller that ignored the extra field before continues to work.

### `PUT /api/data`
Now requires `{ data, expectedVersion }`. The update is a single atomic SQL statement:
```sql
UPDATE tenant_data
SET data = ?, version = version + 1, updated_at = datetime('now'), updated_by = ?
WHERE tenant_id = ? AND version = ?
```
If `expectedVersion` no longer matches the row's current version, `changes === 0` and the server returns **409** instead of writing — the write that would have silently clobbered another device's save never happens. The 409 body includes `currentVersion`, `currentUpdatedAt`, and `updatedByName` (looked up from `users.display_name`/`mobile`) so the client can tell the user *who* saved over them, not just that a conflict occurred.

**A request with a missing or non-numeric `expectedVersion` is treated as an automatic conflict**, not an automatic pass. This is a deliberate fail-safe: it's the only correct behavior for an old, stale client (a browser tab left open across a deploy) that doesn't know to send the field yet — better to force it to resync than guess. Because `better-sqlite3` executes synchronously and Node is single-threaded, there is no window between the read and the write for a second request to interleave — the `UPDATE ... WHERE version = ?` guard is the actual safety mechanism, not a race-prevention measure on top of a separate check.

### Client (`app/ShopERP_Pro_v8.html`)
- `window._svrDataVersion` is the client's cached "version I last confirmed with the server." Set at every point the client establishes what the server has: after `GET /api/data` (login, license-lookup sign-in, silent token-based boot) and directly to `1` on fresh registration (matching the row the server just inserted, with no extra round-trip).
- `saveDB()`'s existing debounced server-sync call now sends `expectedVersion: window._svrDataVersion` and updates it from every successful response.
- `_api.put()` now recognizes HTTP 409 as a distinct case (previously only 401/403 were special-cased) and throws an `Error` carrying `.status` and `.conflict`.
- On a 409, `_handleSyncConflict()` fires: adopts the server's `currentVersion` (so the *next* save attempt uses the right number), and shows the app's existing `showConfirm()` modal — the same primitive already used for the factory-reset confirmation — explaining that another device saved first and offering to reload. Choosing to reload does a fresh `GET /api/data`, replaces `DB`, and reloads the page; choosing to dismiss leaves local changes in memory (unsaved to the server) so nothing is lost, and the next autosave attempt will surface the same prompt again if the conflict hasn't been resolved.

**No new screen, button, or layout was added.** The conflict UX reuses the existing `openModal`/`closeModal`/`showConfirm` system and the existing `#autosave-ind` status indicator element — satisfying the "do not redesign UI" constraint while making data loss visible instead of silent.

## What this does *not* do (by design, for Wave 0)

- No field-level or three-way merge. A conflict means "someone else's full save landed first" — the resolution is reload-and-redo, not automatic reconciliation. Real merge logic (e.g., "both devices added a different sale, keep both") is a materially larger feature and explicitly out of scope for the hardening wave; if it's wanted later, `updated_by`/`version` are the foundation it would build on.
- No retry-with-backoff loop. A conflicted save simply stops and asks the user to reload; it does not automatically retry, since retrying with the *same* stale data would just conflict again.

## Backward compatibility

- **Electron/desktop mode is entirely unaffected** — it never calls `/api/data` at all (confirmed: `saveDB()`'s server-sync block is gated on `SHOPERPRO_API_URL`, which is never set inside the Electron shell). Rule #6 ("do not break Electron mode") is satisfied by construction, not by testing around it.
- **Existing web/hosted sessions**: a browser tab already open when this deploys will make its next save with `window._svrDataVersion` still `undefined` (page hasn't reloaded, so the new login-time assignment never ran) — that save gets a clean 409 with a clear message, the user reloads once, and every subsequent save carries a real version number. One graceful resync per already-open tab, zero data loss, zero silent overwrite — which is the entire point of this wave.

## Rollback

Revert `server/local.js` and `app/ShopERP_Pro_v8.html` to the prior commit. The two new columns can be left in place (unused, harmless — SQLite doesn't mind an extra column an old query never references) or dropped with `ALTER TABLE tenant_data DROP COLUMN version, DROP COLUMN updated_by` if a fully clean revert is wanted. No data migration is needed either direction since `data` (the actual business data column) was never touched by this change.

## Manual verification performed

Ran against the live server (`server/shoperpro.db`, real HTTP requests, not mocked):
1. Registered a test tenant, confirmed `GET /api/data` returns `version: 1`.
2. Saved with `expectedVersion: 1` → succeeded, returned `version: 2`.
3. Saved again with the **stale** `expectedVersion: 1` (simulating a second device that hadn't seen the first device's save) → **409**, with `currentVersion: 2` and the correct `updatedByName`. No data was overwritten — verified by re-reading the row directly from SQLite.
4. Saved with no `expectedVersion` field at all (simulating a stale pre-Wave-0 client) → **409**, same safe behavior.
5. Test tenant and its rows removed after verification; production tenants (Dada Mobile, Vision Communication, etc.) untouched.
