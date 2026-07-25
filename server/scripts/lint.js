/**
 * Minimal lint step for CI — syntax-checks every server .js file and every
 * inline <script> block in the app HTML.
 *
 * No eslint (or any other lint framework) is configured anywhere in this
 * project, and introducing one — with its own config, style rules, and
 * opinions — is a real decision that wasn't asked for here. This is
 * deliberately narrower: it catches "this file doesn't parse," which is
 * exactly the class of bug this engagement hit and fixed by hand with
 * `node --check` throughout (see every Wave 0/1 change). Wiring that same
 * check into CI so it can never be skipped by accident.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = false;

// 1. Every server .js file (excluding node_modules)
const serverDir = path.join(__dirname, '..');
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      try {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
        console.log('  \x1b[32m✓\x1b[0m ' + path.relative(serverDir, full));
      } catch (e) {
        failed = true;
        console.log('  \x1b[31m✗\x1b[0m ' + path.relative(serverDir, full));
        console.log(e.stderr.toString());
      }
    }
  }
}
console.log('Syntax-checking server/*.js:');
walk(serverDir);

// 2. Every inline <script> block in the app HTML
console.log('\nSyntax-checking app/ShopERP_Pro_v8.html inline scripts:');
const htmlPath = path.join(serverDir, '..', 'app', 'ShopERP_Pro_v8.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((s, i) => {
  try {
    new Function(s);
    console.log('  \x1b[32m✓\x1b[0m inline script block ' + i);
  } catch (e) {
    failed = true;
    console.log('  \x1b[31m✗\x1b[0m inline script block ' + i + ': ' + e.message);
  }
});

console.log('');
if (failed) {
  console.log('Lint FAILED — one or more files do not parse.');
  process.exit(1);
} else {
  console.log('Lint passed — every file parses.');
  process.exit(0);
}
