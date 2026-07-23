/**
 * Isolated test-server harness (Task 2 — Database Isolation).
 * See docs/architecture-review/DatabaseIsolationPlan.md for the design.
 *
 * Spawns a real `node local.js` child process pointed at a disposable temp
 * SQLite file and a random port, waits for it to be healthy, and returns a
 * handle to talk to it plus a stop() that kills the process and deletes the
 * temp DB (and its -wal/-shm siblings) entirely. Production's shoperpro.db
 * is never opened by anything this file does.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function startTestServer(opts) {
  opts = opts || {};
  const dbPath = path.join(os.tmpdir(), `shoperpro-test-${crypto.randomBytes(8).toString('hex')}.db`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  // Admin auth (Issue 2, PasswordMigration.md): ADMIN_KEY now seeds
  // admin_credentials as the legacy sha256(password) value, exactly like a
  // real pre-migration deployment — adminPassword is the real plaintext a
  // caller would type in. Every test that previously used `adminKey`
  // directly as the X-Admin-Key bearer value now instead gets a real
  // session token below (obtained via one login call after boot), so no
  // existing test file needs to change at all.
  // opts.adminPassword lets a test that reboots against the SAME DB file
  // multiple times (e.g. license-backfill-regression.test.js) pass the
  // identical password each time — admin_credentials is seeded once and
  // persists across boots by design (that's the whole point of moving it
  // off the env var), so a fresh random password on a later boot against
  // an already-seeded file would just fail to log in.
  const adminPassword = opts.adminPassword || crypto.randomBytes(16).toString('hex');
  const adminKeySeed = crypto.createHash('sha256').update(adminPassword).digest('hex');

  const env = Object.assign({}, process.env, {
    DB_PATH: dbPath,
    PORT: String(port),
    JWT_SECRET: jwtSecret,
    ADMIN_KEY: adminKeySeed,
    // server/mailer.js requires these to be set to boot at all (see
    // LicensingMigrationPlan.md) — a fake, unreachable host is fine here:
    // transporter.verify() only logs on failure, it's never fatal, and no
    // test in this repo actually needs a real outbound email to be sent.
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    SMTP_USER: 'test@example.com',
    SMTP_PASS: 'test',
    SMTP_FROM: 'ShopERP Pro Test <test@example.com>',
  }, opts.envOverrides || {});

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'local.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });

  const baseUrl = `http://localhost:${port}`;

  function cleanupFiles() {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.unlinkSync(f); } catch (_) { /* fine if it never existed */ }
    }
  }

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Test server exited early (code ${code}). Output:\n${out}`));
      }
    });
    (function poll() {
      fetch(baseUrl + '/health').then(r => {
        if (r.ok) {
          // Exchange the seeded legacy password for a real session token —
          // this is also what exercises the sha256->bcrypt auto-migration
          // path on every single test run that uses this harness.
          fetch(baseUrl + '/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword }),
          }).then(loginRes => loginRes.json()).then(loginBody => {
            if (!loginBody.adminToken) {
              child.kill();
              cleanupFiles();
              return reject(new Error('Test server admin login did not return a token: ' + JSON.stringify(loginBody)));
            }
            resolve({
              baseUrl,
              adminKey: loginBody.adminToken,
              adminPassword,
              jwtSecret,
              dbPath,
              stop() {
                child.kill();
                cleanupFiles();
              },
            });
          }).catch(e => {
            child.kill();
            cleanupFiles();
            reject(new Error('Test server admin login failed: ' + e.message));
          });
        } else if (Date.now() < deadline) {
          setTimeout(poll, 150);
        } else {
          child.kill();
          cleanupFiles();
          reject(new Error('Test server did not become healthy in time. Output:\n' + out));
        }
      }).catch(() => {
        if (Date.now() < deadline) setTimeout(poll, 150);
        else {
          child.kill();
          cleanupFiles();
          reject(new Error('Test server did not become healthy in time. Output:\n' + out));
        }
      });
    })();
  });
}

module.exports = { startTestServer };
