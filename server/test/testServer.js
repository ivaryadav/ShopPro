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

function startTestServer() {
  const dbPath = path.join(os.tmpdir(), `shoperpro-test-${crypto.randomBytes(8).toString('hex')}.db`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const adminKey = crypto.randomBytes(32).toString('hex');

  const env = Object.assign({}, process.env, {
    DB_PATH: dbPath,
    PORT: String(port),
    JWT_SECRET: jwtSecret,
    ADMIN_KEY: adminKey,
  });

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
          resolve({
            baseUrl,
            adminKey,
            jwtSecret,
            dbPath,
            stop() {
              child.kill();
              cleanupFiles();
            },
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
