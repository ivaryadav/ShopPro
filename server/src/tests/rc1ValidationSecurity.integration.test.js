/**
 * RC1 End-to-End Product Validation — adversarial security testing against
 * the server/src/ REST API (createApp() + real MariaDB), covering angles
 * not already exercised by Phase/Sprint test suites: cross-tenant IDOR on
 * Operations endpoints, JWT tampering, SQL injection due diligence, and
 * Operations rate limiting under real repeated requests (operationsRateLimit
 * .test.js already covers the limiter's own logic in isolation — this
 * verifies it's actually wired into a live route end to end).
 *
 * Same honest-skip pattern as every other integration test in this
 * project. Config is env-overridable (TEST_DB_HOST/PORT/USER/PASSWORD/NAME).
 *
 * Usage: node server/src/tests/rc1ValidationSecurity.integration.test.js
 */
'use strict';

const bcrypt = require('bcryptjs');
const { getPool, migrateUp, checkDatabaseHealth, closePool, _resetForTests } = require('../database');
const { createApp } = require('../app');
const roleRepository = require('../repositories/roleRepository');
const tenantRepository = require('../repositories/tenantRepository');
const userRepository = require('../repositories/userRepository');

let passed = 0, failed = 0, skipped = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
function skip(label, reason) { skipped++; console.log('  \x1b[33m○ SKIP\x1b[0m ' + label + ' — ' + reason); }

const TEST_DB_CONFIG = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'shoperpro_phase6_test',
};

async function main() {
  console.log('RC1 Validation: adversarial security testing against server/src/ (createApp + real MariaDB)');
  console.log('');

  const labels = [
    'Tenant B cannot read Tenant A\'s inventory item by guessing its numeric ID (IDOR)',
    'Tenant B cannot update Tenant A\'s inventory item by guessing its ID',
    'Tenant B cannot read Tenant A\'s customer/sale records by guessing IDs',
    'a JWT with a tampered tenantId claim is rejected (signature invalid)',
    'a SQL-injection-shaped product name is stored as inert text, not executed',
    'Operations routes are really rate-limited end to end under real repeated requests',
  ];

  _resetForTests();
  const health = await checkDatabaseHealth(TEST_DB_CONFIG);
  if (!health.ok) {
    for (const label of labels) skip(label, `no reachable/authenticated database: ${health.error}`);
    console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
    process.exit(0);
  }

  _resetForTests();
  const pool = getPool(TEST_DB_CONFIG);
  const jwtSecret = 'rc1-validation-test-secret-1234567890';
  const app = createApp({ jwtSecret, startCleanupJob: false });

  try {
    await migrateUp(pool);
    const ownerRole = await roleRepository.findByCode('owner');

    const tenantA = await tenantRepository.create('RC1 Val Security Tenant A ' + Date.now());
    const tenantB = await tenantRepository.create('RC1 Val Security Tenant B ' + Date.now());
    const mobA = '97000' + String(Date.now()).slice(-5);
    const mobB = '97001' + String(Date.now()).slice(-5);
    await userRepository.create({ tenantId: tenantA.id, mobile: mobA, displayName: 'Owner A', passwordHash: bcrypt.hashSync('123456', 10), roleId: ownerRole.id });
    await userRepository.create({ tenantId: tenantB.id, mobile: mobB, displayName: 'Owner B', passwordHash: bcrypt.hashSync('654321', 10), roleId: ownerRole.id });

    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const loginA = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobA, pin: '123456' }) }).then((r) => r.json());
    const loginB = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: mobB, pin: '654321' }) }).then((r) => r.json());
    if (!loginA.token || !loginB.token) throw new Error('setup: login failed for one or both tenants: ' + JSON.stringify({ loginA, loginB }));

    // ── Cross-tenant IDOR on Inventory ──────────────────────────────────
    const productA = await fetch(baseUrl + '/api/inventory', { method: 'POST', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tenant A Secret Product', sellPrice: 1000, costPrice: 500, stock: 5 }) }).then((r) => r.json());
    const idorRead = await fetch(baseUrl + `/api/inventory/${productA.product.id}`, { headers: { Authorization: `Bearer ${loginB.token}` } });
    assert(idorRead.status === 404, `Tenant B cannot read Tenant A's inventory item by guessing its numeric ID (IDOR) (got ${idorRead.status}, expected 404)`);
    const idorUpdate = await fetch(baseUrl + `/api/inventory/${productA.product.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${loginB.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Hijacked', sellPrice: 1, costPrice: 1, stock: 999 }) });
    assert(idorUpdate.status === 404, `Tenant B cannot update Tenant A's inventory item by guessing its ID (got ${idorUpdate.status}, expected 404)`);
    const stillIntact = await fetch(baseUrl + `/api/inventory/${productA.product.id}`, { headers: { Authorization: `Bearer ${loginA.token}` } }).then((r) => r.json());
    assert(stillIntact.product.name === 'Tenant A Secret Product' && stillIntact.product.stock === 5, "Tenant A's product was NOT modified by Tenant B's IDOR attempt");

    // ── Cross-tenant IDOR on Customers ──────────────────────────────────
    const customerA = await fetch(baseUrl + '/api/customers', { method: 'POST', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tenant A Secret Customer', phone: '9333333333' }) }).then((r) => r.json());
    const idorCustomerRead = await fetch(baseUrl + `/api/customers/${customerA.customer.id}`, { headers: { Authorization: `Bearer ${loginB.token}` } });
    assert(idorCustomerRead.status === 404, `Tenant B cannot read Tenant A's customer record by guessing its ID (got ${idorCustomerRead.status}, expected 404)`);

    // ── JWT tampering ────────────────────────────────────────────────────
    const [h, p, sig] = loginA.token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), tenantId: tenantB.id })).toString('base64url');
    const forged = await fetch(baseUrl + '/api/inventory', { headers: { Authorization: `Bearer ${h}.${forgedPayload}.${sig}` } });
    assert(forged.status === 401, `a JWT with a tampered tenantId claim is rejected outright (signature no longer valid) (got ${forged.status})`);

    // ── SQL injection due diligence ──────────────────────────────────────
    const sqliName = "Robert'); DROP TABLE inventory_items;--";
    const sqliCreate = await fetch(baseUrl + '/api/inventory', { method: 'POST', headers: { Authorization: `Bearer ${loginA.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sqliName, sellPrice: 100, costPrice: 50, stock: 1 }) });
    assert(sqliCreate.status === 201, 'a SQL-injection-shaped product name is accepted as inert literal text (parameterized query), not executed');
    const listAfterSqli = await fetch(baseUrl + '/api/inventory', { headers: { Authorization: `Bearer ${loginA.token}` } }).then((r) => r.json());
    assert(Array.isArray(listAfterSqli.inventory) && listAfterSqli.inventory.some((p) => p.name === sqliName), 'inventory_items table was NOT dropped — the payload is stored as inert text, confirming parameterized queries hold, and the list endpoint still works');

    // ── Operations rate limiting, wired end to end ───────────────────────
    let sawRateLimit = false;
    for (let i = 0; i < 150; i++) {
      const r = await fetch(baseUrl + '/api/inventory', { headers: { Authorization: `Bearer ${loginA.token}` } });
      if (r.status === 429) { sawRateLimit = true; break; }
    }
    assert(sawRateLimit, 'repeated rapid requests (150x) to a real Operations route eventually hit a real 429 — Phase 6\'s rateLimit(120, 60s) is genuinely wired into the live route, not just unit-tested in isolation');

    server.close();
  } finally {
    await closePool();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
