/** Syntax-checks every .js file in platform/ (excluding node_modules). */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      try {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
        console.log('  \x1b[32m✓\x1b[0m ' + path.relative(ROOT, full));
      } catch (e) {
        failed++;
        console.log('  \x1b[31m✗ FAIL\x1b[0m ' + path.relative(ROOT, full));
        console.error(e.stderr ? e.stderr.toString() : e.message);
      }
    }
  }
}

walk(ROOT);

// public/superadmin.html's inline <script> is the platform's ENTIRE frontend
// and has no build step — a syntax error there breaks the whole UI silently
// in the browser (nothing shows in a Node .js walk, since it's not a .js
// file). Checked here the same way server/scripts/lint.js already checks
// app/ShopERP_Pro_v8.html — this caught a real bug (a double-escaped
// apostrophe that truncated a string mid-statement) that had been sitting
// undetected in this file precisely because this check didn't exist yet.
console.log('\nSyntax-checking public/superadmin.html inline script:');
const htmlPath = path.join(ROOT, 'public', 'superadmin.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
scripts.forEach((s, i) => {
  try {
    new Function(s);
    console.log('  \x1b[32m✓\x1b[0m inline script block ' + i);
  } catch (e) {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m inline script block ' + i + ': ' + e.message);
  }
});

if (failed) { console.log(`\n${failed} file(s) failed to parse.`); process.exit(1); }
console.log('\nLint passed — every file parses.');
