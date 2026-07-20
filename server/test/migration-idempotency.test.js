/**
 * Migration idempotency test — starts the server against the SAME isolated
 * DB file three times in a row (simulating three consecutive deploys/
 * restarts against one persistent database) and confirms every migration
 * (`ALTER TABLE ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, sessions.migrate)
 * runs cleanly every time, with no errors and no data loss in between.
 *
 * Runs against an isolated, disposable file — never server/shoperpro.db.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

function bootOnce(dbPath, port) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      DB_PATH: dbPath, PORT: String(port),
      JWT_SECRET: 'migration-idempotency-test-secret',
      ADMIN_KEY: 'migration-idempotency-test-admin-key',
    });
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'local.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    const deadline = Date.now() + 8000;
    child.once('exit', code => { if (code !== null && code !== 0) reject(new Error('exited ' + code + ':\n' + out)); });
    (function poll() {
      fetch(`http://localhost:${port}/health`).then(r => {
        if (r.ok) resolve({ child, out: () => out });
        else if (Date.now() < deadline) setTimeout(poll, 150);
        else reject(new Error('did not become healthy:\n' + out));
      }).catch(() => {
        if (Date.now() < deadline) setTimeout(poll, 150);
        else reject(new Error('did not become healthy:\n' + out));
      });
    })();
  });
}

async function main() {
  console.log('Migration idempotency test — same DB file, 3 consecutive server boots');
  const dbPath = path.join(os.tmpdir(), `shoperpro-migtest-${crypto.randomBytes(8).toString('hex')}.db`);
  const port = 25000 + Math.floor(Math.random() * 5000);
  console.log('DB: ' + dbPath);
  console.log('');

  try {
    // Boot 1: fresh file, migrations create everything from scratch
    let r = await bootOnce(dbPath, port);
    assert(!/error/i.test(r.out()), 'boot 1 (fresh file): no errors in startup output');
    r.child.kill();
    await new Promise(res => setTimeout(res, 300));

    const db1 = new Database(dbPath);
    const tables1 = db1.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert(
      ['cloud_backups', 'tenant_data', 'tenants', 'user_sessions', 'users'].every(t => tables1.includes(t)),
      'boot 1: all 5 expected tables exist after first boot'
    );
    // Insert a marker row to prove later boots don't wipe data
    db1.exec("INSERT INTO tenants (shop_name, status) VALUES ('MigrationMarkerTenant', 'active')");
    const markerCountBefore = db1.prepare("SELECT COUNT(*) c FROM tenants WHERE shop_name='MigrationMarkerTenant'").get().c;
    db1.close();
    assert(markerCountBefore === 1, 'marker row inserted successfully after boot 1');

    // Boot 2: same file, migrations must be no-ops (idempotent), data must survive
    r = await bootOnce(dbPath, port);
    assert(!/error/i.test(r.out()), 'boot 2 (same file, re-run migrations): no errors in startup output');
    r.child.kill();
    await new Promise(res => setTimeout(res, 300));

    const db2 = new Database(dbPath);
    const markerAfterBoot2 = db2.prepare("SELECT COUNT(*) c FROM tenants WHERE shop_name='MigrationMarkerTenant'").get().c;
    assert(markerAfterBoot2 === 1, 'marker row still present after boot 2 (migrations did not touch existing data)');
    db2.close();

    // Boot 3: one more time for good measure
    r = await bootOnce(dbPath, port);
    assert(!/error/i.test(r.out()), 'boot 3 (same file again): no errors in startup output');
    r.child.kill();
    await new Promise(res => setTimeout(res, 300));

    const db3 = new Database(dbPath);
    const markerAfterBoot3 = db3.prepare("SELECT COUNT(*) c FROM tenants WHERE shop_name='MigrationMarkerTenant'").get().c;
    assert(markerAfterBoot3 === 1, 'marker row still present after boot 3 — three consecutive boots, zero data loss');
    const tableCountStable = db3.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
    assert(tableCountStable === tables1.length, 'table count is stable across repeated migrations (no duplicate/renamed tables)');
    db3.close();

  } finally {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    console.log('\nTemp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
