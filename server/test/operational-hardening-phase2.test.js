/**
 * Regression tests for OperationalHardeningPhase2.md:
 *   1. Startup validation — DB_PATH parent-directory-writable check.
 *   2. Backup verification command (server/scripts/backup-verify.js).
 *   3. Structured logging (server/logger.js).
 *   4. Migration validation command (server/scripts/validate-migrations.js).
 *
 * All against disposable/isolated data — never server/shoperpro.db.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function run(cmd, args) {
  try {
    const out = execFileSync(process.execPath, [cmd, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

async function main() {
  // -----------------------------------------------------------------------
  // 1. Structured logger
  // -----------------------------------------------------------------------
  {
    const logger = require('../logger');
    const origLog = console.log, origErr = console.error;
    let logged = null, errored = null;
    console.log = (line) => { logged = line; };
    console.error = (line) => { errored = line; };
    logger.info('test info message', { foo: 'bar' });
    console.log = origLog;
    logger.warn('test warn message');
    logger.error('test error message', { code: 42 });
    console.error = origErr;

    let parsed;
    try { parsed = JSON.parse(logged); } catch (_) {}
    assert(!!parsed, 'logger.info() emits valid JSON');
    assert(parsed && parsed.level === 'info' && parsed.message === 'test info message', 'logger.info() carries the correct level and message');
    assert(parsed && !!parsed.time && !isNaN(Date.parse(parsed.time)), 'logger output carries a valid ISO timestamp');
    assert(parsed && parsed.meta && parsed.meta.foo === 'bar', 'logger carries optional structured metadata');

    let parsedErr;
    try { parsedErr = JSON.parse(errored); } catch (_) {}
    assert(parsedErr && parsedErr.level === 'error' && parsedErr.meta.code === 42, 'logger.error() routes to console.error (not console.log) and carries metadata');
  }

  // -----------------------------------------------------------------------
  // 2. Startup validation — DB_PATH directory-writable check
  // -----------------------------------------------------------------------
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'local.js')], {
      env: Object.assign({}, process.env, {
        DB_PATH: '/nonexistent-dir-' + crypto.randomBytes(4).toString('hex') + '/cannot.db',
        PORT: '0', JWT_SECRET: 'startup-validation-test-secret',
        // server/mailer.js requires these to boot at all — set explicitly so
        // this assertion (about the DB_PATH failure specifically) isn't
        // masked by an earlier, unrelated SMTP boot failure in environments
        // (e.g. a fresh CI checkout) with no server/.env fallback.
        SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_USER: 'test', SMTP_PASS: 'test', SMTP_FROM: 'test@example.com',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    child.on('exit', (code) => {
      assert(code === 1, 'server exits with code 1 when DB_PATH\'s parent directory does not exist/is not writable');
      assert(out.includes('[FATAL]') && out.includes('Cannot write to the database directory'), 'exits with a clear, specific message naming the actual problem (not better-sqlite3\'s raw error)');
      resolve();
    });
    setTimeout(() => { try { child.kill(); } catch (_) {} resolve(); }, 5000);
  });

  // Regression: a normal, writable DB_PATH boots exactly as before.
  {
    const srv = await startTestServer();
    const r = await fetch(srv.baseUrl + '/health');
    assert(r.ok, 'regression: a valid, writable DB_PATH still boots and serves /health normally');
    srv.stop();
  }

  // -----------------------------------------------------------------------
  // 3. Backup verification command
  // -----------------------------------------------------------------------
  {
    const srv = await startTestServer();
    const outDir = path.join(os.tmpdir(), 'backup-verify-test-' + crypto.randomBytes(4).toString('hex'));
    const db = new Database(srv.dbPath);
    db.prepare("INSERT INTO tenants (shop_name, status) VALUES ('BackupVerifyTestShop','active')").run();
    db.pragma('wal_checkpoint(FULL)');
    db.close();

    const result = run(path.join(__dirname, '..', 'scripts', 'backup-verify.js'), ['--path', srv.dbPath, '--out', outDir]);
    assert(result.code === 0, 'backup-verify.js exits 0 for a valid, healthy source database');
    const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(f => f.endsWith('.db')) : [];
    assert(files.length === 1, 'backup-verify.js writes exactly one .db file to the output directory');
    if (files.length === 1) {
      const backupDb = new Database(path.join(outDir, files[0]), { readonly: true });
      const row = backupDb.prepare("SELECT shop_name FROM tenants WHERE shop_name = 'BackupVerifyTestShop'").get();
      assert(!!row, 'the produced backup file actually contains the source database\'s real data');
      const integrity = backupDb.pragma('integrity_check');
      assert(integrity.length === 1 && integrity[0].integrity_check === 'ok', 'the produced backup independently passes its own PRAGMA integrity_check');
      backupDb.close();
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    srv.stop();

    const badResult = run(path.join(__dirname, '..', 'scripts', 'backup-verify.js'), ['--path', '/tmp/does-not-exist-' + crypto.randomBytes(4).toString('hex') + '.db']);
    assert(badResult.code === 1, 'backup-verify.js exits 1 (not a crash, not a silent success) when the source database does not exist');
  }

  // -----------------------------------------------------------------------
  // 4. Migration validation command
  // -----------------------------------------------------------------------
  {
    const srv = await startTestServer();
    const goodResult = run(path.join(__dirname, '..', 'scripts', 'validate-migrations.js'), ['--path', srv.dbPath]);
    assert(goodResult.code === 0, 'validate-migrations.js exits 0 for a freshly, correctly migrated database');
    srv.stop();

    const badDbPath = path.join(os.tmpdir(), 'incomplete-schema-' + crypto.randomBytes(4).toString('hex') + '.db');
    const badDb = new Database(badDbPath);
    badDb.exec('CREATE TABLE tenants (id INTEGER PRIMARY KEY, shop_name TEXT)'); // missing columns, missing every other table
    badDb.close();
    const badResult = run(path.join(__dirname, '..', 'scripts', 'validate-migrations.js'), ['--path', badDbPath]);
    assert(badResult.code === 1, 'validate-migrations.js exits 1 for a schema missing expected tables/columns');
    assert(badResult.out.includes('missing table: users') && badResult.out.includes('missing column: tenants.status'), 'failure output names the SPECIFIC missing tables/columns, not just a generic failure');
    fs.unlinkSync(badDbPath);

    const missingResult = run(path.join(__dirname, '..', 'scripts', 'validate-migrations.js'), ['--path', '/tmp/truly-does-not-exist-' + crypto.randomBytes(4).toString('hex') + '.db']);
    assert(missingResult.code === 1, 'validate-migrations.js exits 1 (not a crash) for a nonexistent database file');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
