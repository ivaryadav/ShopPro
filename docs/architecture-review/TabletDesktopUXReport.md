# Tablet + Desktop UX Report — Phase 2 Continued

Extends `ResponsiveDesignReport.md`'s systemic foundation with per-screen work on the 5 screens named, in the priority order given: Inventory → Repairs → Reports → Settings → Admin. Same constraints as before: no workflow/business-logic/API/navigation changes — verified, not just asserted (see "Verification" below).

## An important correctness bug caught and fixed while doing this work

Several screens set grid column counts via an inline `style="grid-template-columns:..."` attribute (Repairs' 5-column stats row, Reports' 6-column stats row, Admin's 3-column stat cards, Settings' 2-column card grids). Inline styles always outrank external/embedded stylesheet rules regardless of media query — meaning the tablet/small-tablet collapse rules from the first responsive pass were **silently not applying** on any screen that used this pattern. Fixed by adding `!important` to the relevant rules (justified here specifically because it's overriding inline styles that predate any responsive design, not fighting another stylesheet rule) and, where the inline pattern didn't already match an existing class, adding a small hook class (`.settings-2col`, `.admin-stat-grid-3`) so the override has something to target without changing the base inline values themselves.

## Also fixed while here: touch targets that fell short of 48–56px

`.btn-sm` (44px) and `.btn-xs` (38px, and missing entirely from the small-tablet tier) were below the stated minimum from the first pass. Bumped to 48px and 44px respectively — `.btn-xs` deliberately stays slightly under full compliance because it's the class used inside `.tbl-actions` icon-button rows that can hold 4–5 buttons in one table cell; `.tbl-wrap`'s existing horizontal-scroll behavior (already established in this codebase) is the safety net for that width, rather than shrinking buttons below usability. This fix is global — every screen using `.btn-sm`/`.btn-xs` benefits, not just the 5 covered this pass.

## Per-screen changes

### 1. Inventory
- Table (Product | Category | SKU | Cost Price | Sell Price | Stock | Actions): `SKU` and `Cost Price` marked `.col-secondary` (hidden on tablet/small-tablet) — Product, Category, Sell Price, Stock, and Actions stay visible, since those are what an operator needs at a glance.
- `.search-input`/`.search-bar` (shared with other screens) added to the global touch-target rules — was previously only `.form-control`, missing the dedicated search-input class Inventory (and Customers, Repairs) actually use.
- The category filter `<select>`'s inline `width:160px` now correctly goes full-width on small tablet via a new `.search-bar select{width:100%!important}` rule.

### 2. Repairs
- Table (11 columns: Job # | Customer | Device | Issue | Status | Estimated | Final Cost | Received | Delivered | Note | Actions) — the widest table in the app. Marked `Issue`, `Estimated`, `Received`, `Delivered`, `Note` as secondary (5 of 11 hidden on tablet), keeping Job #/Customer/Device/Status/Final Cost/Actions — Status already shows a payment-due badge inline, so hiding Estimated/Final-Cost-adjacent detail columns doesn't lose the operationally critical "is this paid" signal.
- Applied identically to **both** row-rendering code paths for this table (`filterRepairsTable()` and the separate status-change re-render path at a different line) — found by searching for every place that writes to `repair-tbl-body`, not just the one the page-load function calls.
- Fixed the 5-column stats row (`grid-template-columns:repeat(5,1fr)` inline) via the `!important` fix described above.

### 3. Reports
- Owner-only, periodic-review screen — lower daily-touch priority than the first three, scoped proportionately.
- 4 inline 2-column card grids (CA/ITR summary, payment breakdown, product/category revenue, GST breakdown) swapped to the `.dash-grid-2` class, which already existed and already matched their exact `display:grid;grid-template-columns:1fr 1fr;gap:14px` shape — gains responsive stacking on small tablet for free, zero visual change on desktop.
- The 9-column monthly P&L table: `Sales`, `Service`, `Cash`, `Digital`, `Bills` marked secondary, keeping `Month`/`Total Rev`/`Expenses`/`Net`/(the row's click-to-expand affordance).
- The 6-column stats row fixed via the same `!important` mechanism.

### 4. Settings
- 4 tab-content 2-column card grids (Shop & Branding tab: logo/QR/signature uploaders + info forms) — these have `max-width:800px` and differ slightly from `.dash-grid-2`'s exact values, so rather than force a swap (which would subtly change desktop spacing), added a dedicated `.settings-2col` hook class that overrides only `grid-template-columns` and `max-width` at the small-tablet breakpoint, preserving exact desktop appearance.
- `.settings-tabs`/`.settings-tab` (the 5-tab switcher: Shop & Branding / Users / License / Data / Audit Log) — added touch-target sizing and `overflow-x:auto` so 5 tabs with icon+label don't overflow or become unreadable on a narrow tablet.
- Audit Log table (Time | By | Role | Action | Detail) — `Role` marked secondary.
- Users tab is card-based already (not a `<table>`), inherits button/spacing improvements automatically without needing column-hiding logic.

### 5. Admin (Super Admin console)
- Lowest priority per the given order, and explicitly labeled "DEVELOPER ONLY" in its own UI — scoped lightest of the five, deliberately.
- Its nav items (`.adm-nav-item`) embed an emoji and label in one text node (unlike the main sidebar's separate icon/label spans), so the icon-rail collapse technique used for the main sidebar isn't applicable without restructuring markup — not done, to stay within "CSS-only, no markup restructuring" for this pass. Given touch-target sizing instead: `#adm-sidebar` narrows (220px → 170px tablet → 150px small tablet) and `.adm-nav-item` grows to a 44px minimum height.
- Web Users table (Name | Role | Mobile | Last Login | Status | Actions) — `Role` and `Last Login` marked secondary.
- The 3-column stat-card row (Active / Expiring / Paused counts) fixed via the `!important`-plus-hook-class mechanism, same as Reports/Repairs.

## Verification performed

- **`npm run lint`**: clean, all files parse including all 3 inline `<script>` blocks.
- **Brace balance**: all 14 `<style>` blocks in the file individually balanced (Python regex sweep), confirming no CSS syntax corruption across ~180 lines of manual editing.
- **`git diff` reviewed line-by-line**: every removed line paired with its `class="col-secondary"`-added replacement, or an inline-style-to-class swap preserving identical properties (`.dash-grid-2`) or adding only a hook class alongside the existing inline style (`.settings-2col`, `.admin-stat-grid-3`) — zero JS logic, zero business rules, zero navigation structure touched.
- **Keyboard shortcuts**: grepped the diff for `keydown`/`keyCode`/`ctrlKey`/`metaKey` — zero matches, confirming no keyboard-handling code was touched (this pass added no new interactive behavior at all, only CSS and static class attributes).
- **Full server test suite**: 169/169 assertions passing (unrelated to this client-only change, run as a full-suite sanity check).

### A real regression this pass caused, found, and fixed — not swept under the rug
Inserting ~90 lines of CSS in the first responsive pass shifted every subsequent line number in the file, which broke `server/test/xss-regression.test.js`'s Layer-2 checks — they were hardcoded to specific line numbers for each S-1/S-2 fix site. Running the full suite after this pass's edits caught this immediately (22 failures). Investigated: the actual `escHtml()` fixes were all still correctly in place (confirmed via the Layer-1 functional tests, which don't depend on line numbers, and by manually re-locating every site) — only the test's own anchoring was wrong. Rewrote the test to match by unique source snippet instead of line number, which is both the fix for right now and a structural fix so this class of false failure can't recur the next time anyone edits this file above line 6000-something for an unrelated reason. Re-ran: 28/28 passing, and the full suite: 169/169.

## Files changed

- `app/ShopERP_Pro_v8.html` — 181 insertions, 43 deletions (CSS additions to the global responsive block, `.col-secondary`/hook-class additions across Inventory/Repairs/Reports/Settings/Admin).
- `server/test/xss-regression.test.js` — rewritten to match by content snippet instead of line number (see above) — a durability fix, not scope creep; required to keep the suite green after this pass's edits.

## Screenshot checklist for manual validation

This sandboxed environment has no browser/screenshot tool — every change above is verified by reading the CSS/cascade logic, not by seeing it rendered. Before treating this as shippable, check the following on a real desktop browser and a real 11" Android tablet (both landscape and portrait where noted):

**Per screen, at each of 3 widths (desktop >1400px, tablet ~1024–1280px landscape, small tablet ~768–900px):**
- [ ] **Inventory** — table renders correctly; SKU/Cost Price disappear at tablet width without leaving a ragged/misaligned header row; category filter dropdown goes full-width on small tablet without overlapping the search box.
- [ ] **Repairs** — 11-column table collapses to 6 visible columns cleanly; tapping a row's action buttons (up to 5 icons) is comfortable, with horizontal scroll available if needed; stats row (5 cards) becomes 2 columns on tablet, 2 columns on small tablet without card content clipping.
- [ ] **Reports** — the 4 two-column card grids stack to one column on small tablet without any table inside them overflowing its card; monthly P&L table's 4 visible columns remain readable at 13px font on small tablet.
- [ ] **Settings** — all 5 tabs are reachable (scroll if needed) and legible at small-tablet width; the Shop & Branding tab's logo/QR/signature upload cards stack to one column below 900px; Audit Log table's Role column disappears cleanly.
- [ ] **Admin** — sidebar narrows without truncating nav item text awkwardly; Web Users table's Role/Last Login columns disappear cleanly; stat cards collapse from 3→2→1 columns correctly.

**Cross-cutting, once per breakpoint:**
- [ ] Sidebar icon-rail collapse (main app) at tablet and small-tablet widths — confirm tapping an icon-only nav item still navigates correctly and shows an active-state indicator.
- [ ] Every primary button (`.btn`) and icon button (`.btn-icon`) is comfortably tappable with a thumb on the physical tablet, not just visually sized 48px+ in devtools.
- [ ] Body text is legible without zooming at each tier (14px desktop / 15px tablet / 16px small tablet).
- [ ] No horizontal scrollbar appears on the page itself (only inside `.tbl-wrap` table containers, which is expected/existing behavior).
- [ ] Desktop (>1400px) is visually **unchanged** from before this work — the dense, information-rich layout should look identical to a pre-Phase-2 screenshot.

Not committed — same as the first responsive pass, awaiting your review before this goes into git history.
