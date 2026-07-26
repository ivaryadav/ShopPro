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
if (failed) { console.log(`\n${failed} file(s) failed to parse.`); process.exit(1); }
console.log('\nLint passed — every file parses.');
