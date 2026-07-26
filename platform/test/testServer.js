/**
 * platform/test/testServer.js — isolated in-process test harness, same
 * shape as server/test/testServer.js's isolated-child-process harness but
 * in-process (no real product to conflict with — this is a brand new
 * service, no legacy /shoperpro.db-style shared file risk to isolate from
 * via a child process). Uses a disposable SQLite file + random port.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { _resetForTests } = require('../src/database/connection');
const { createApp } = require('../src/app');
const platformAuthService = require('../src/services/platformAuthService');

async function startTestServer(opts) {
  opts = opts || {};
  const dbPath = path.join(os.tmpdir(), `zsuperadmin-test-${crypto.randomBytes(8).toString('hex')}.db`);
  process.env.PLATFORM_DB_PATH = dbPath;
  process.env.PLATFORM_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  _resetForTests();

  const ownerEmail = opts.ownerEmail || `owner${Date.now()}@zmaxlab.com`;
  const ownerPassword = opts.ownerPassword || 'TestOwnerPass123!';
  const owner = await platformAuthService.createUser({ email: ownerEmail, password: ownerPassword, displayName: 'Test Owner', roleCode: 'OWNER' });

  const app = createApp({ jwtSecret: process.env.PLATFORM_JWT_SECRET, allowedOrigins: [] });
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const login = await fetch(baseUrl + '/api/platform/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  }).then((r) => r.json());
  if (!login.token) throw new Error('Test server owner login did not return a token: ' + JSON.stringify(login));

  return {
    baseUrl, ownerToken: login.token, ownerId: owner.id, ownerEmail, ownerPassword, dbPath,
    stop() {
      server.close();
      _resetForTests();
      for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
    },
  };
}

module.exports = { startTestServer };
