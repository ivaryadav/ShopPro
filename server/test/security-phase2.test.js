/**
 * Regression tests for S-7, S-9, S-10 (SecurityHardeningReview.md /
 * SecurityHardeningPhase2.md) — all three implemented in this pass.
 *
 * S-7: jwt.verify() now pins { algorithms: ['HS256'] } (server/local.js).
 * S-9: POST /api/admin/generate-key no longer echoes e.message to the
 *      client on failure (server/local.js).
 * S-10: requireAdminKey now uses crypto.timingSafeEqual() instead of !==
 *       (server/local.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  const srv = await startTestServer();
  try {
    // -------------------------------------------------------------------
    // S-7: algorithm pinning
    // -------------------------------------------------------------------
    // Empirically confirmed (not assumed) that jsonwebtoken's unpinned
    // jwt.verify(token, secret) accepts whatever algorithm the token's
    // header claims, as long as it's HMAC-compatible with a plain string
    // secret — an HS384 token signed with the SAME secret verifies
    // successfully with no algorithms option. Pinning algorithms:['HS256']
    // is what makes the server reject it. This is the actual, measurable
    // effect of the fix, not a theoretical one.
    {
      const payload = { userId: 1, tenantId: 1, role: 'owner' };
      const hs256Token = jwt.sign(payload, srv.jwtSecret, { algorithm: 'HS256' });
      const hs384Token = jwt.sign(payload, srv.jwtSecret, { algorithm: 'HS384' });

      assert(
        !!jwt.verify(hs256Token, srv.jwtSecret) && !!jwt.verify(hs384Token, srv.jwtSecret),
        'baseline (unpinned) jwt.verify accepts both HS256 and HS384 tokens signed with the same secret — confirms the algorithm-confusion surface genuinely exists before considering the server-side pin'
      );
      let hs384Rejected = false;
      try { jwt.verify(hs384Token, srv.jwtSecret, { algorithms: ['HS256'] }); }
      catch (e) { hs384Rejected = e.message.includes('invalid algorithm'); }
      assert(hs384Rejected, 'pinned jwt.verify({algorithms:["HS256"]}) rejects an HS384-signed token with the same secret — the actual fix, proven at the jsonwebtoken level');

      // Live, end-to-end: an HS384-signed token presented to a real
      // protected endpoint is rejected by the running server.
      const r1 = await fetch(srv.baseUrl + '/api/data', { headers: { Authorization: 'Bearer ' + hs384Token } });
      assert(r1.status === 401, 'live server: an HS384-signed Bearer token (same secret, different algorithm) is rejected with 401');

      // Regression: a normal HS256 token (the only kind sessions.js ever
      // actually issues) must still authenticate exactly as before.
      const reg = await fetch(srv.baseUrl + '/api/auth/verify-license', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: 'AAAA-AAAA-AAAA-AAAA' }),
      });
      assert(reg.status === 200, 'regression: normal API traffic (unrelated endpoint) still responds correctly after the algorithm pin — server did not break on boot or on request handling');
    }

    // -------------------------------------------------------------------
    // S-10: timing-safe admin key comparison
    // -------------------------------------------------------------------
    {
      const r1 = await fetch(srv.baseUrl + '/api/admin/tenants', { headers: { 'X-Admin-Key': srv.adminKey } });
      assert(r1.status === 200, 'regression: the correct admin key is still accepted (200) after switching to timingSafeEqual');

      const r2 = await fetch(srv.baseUrl + '/api/admin/tenants', { headers: { 'X-Admin-Key': 'wrong-key-entirely' } });
      assert(r2.status === 401, 'a wrong admin key of different length is still rejected (401) — the length pre-check does not accidentally allow through');

      // Same length as the real key, differs only in the last character —
      // the exact shape a naive !== check and a timing-safe check must
      // both still reject correctly; specifically exercises the
      // timingSafeEqual() path (equal-length buffers) rather than the
      // length-mismatch short-circuit above.
      const almostRight = srv.adminKey.slice(0, -1) + (srv.adminKey.slice(-1) === 'x' ? 'y' : 'x');
      const r3 = await fetch(srv.baseUrl + '/api/admin/tenants', { headers: { 'X-Admin-Key': almostRight } });
      assert(r3.status === 401, 'a same-length admin key differing in only the last character is rejected (401) — exercises the actual timingSafeEqual() comparison path, not just the length pre-check');

      const r4 = await fetch(srv.baseUrl + '/api/admin/tenants', {});
      assert(r4.status === 401, 'missing admin key header is still rejected (401) — unchanged edge case');
    }

    // -------------------------------------------------------------------
    // S-9: error disclosure
    // -------------------------------------------------------------------
    {
      // Regression: the success path is completely unaffected by the fix.
      const r1 = await fetch(srv.baseUrl + '/api/admin/generate-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': srv.adminKey },
        body: JSON.stringify({ plan: 'monthly', machineId: 'ABCD1234EFGH5678' }),
      });
      const body1 = await r1.json();
      assert(r1.status === 200 && !!body1.key, 'regression: generate-key success path is unaffected — still returns a real key');

      // A genuine invalid-input error path this endpoint already validates
      // for (missing/unknown plan) — confirms the 400 path (a different,
      // pre-existing validation branch, not the try/catch this fix
      // touches) is untouched, and gives us a real error response shape
      // to inspect for the absence of internal detail.
      const r2 = await fetch(srv.baseUrl + '/api/admin/generate-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': srv.adminKey },
        body: JSON.stringify({ plan: 'not-a-real-plan' }),
      });
      const body2 = await r2.json();
      assert(r2.status === 400 && typeof body2.error === 'string' && !body2.error.includes('at '), 'unknown-plan error response contains no stack-trace-shaped internal detail');

      // The actual catch(e){...} block this fix touches (the genuine 500
      // path) isn't realistically triggerable live without contrived
      // internal-state corruption — license.generateKey()'s only throw
      // condition (unknown plan) is already pre-validated by this same
      // route before the try block is ever entered, so a live request
      // can't reach it. Verified instead via the real source, the same
      // extract-and-check approach used in migration-safety.test.js.
      const localJsSrc = fs.readFileSync(path.join(__dirname, '..', 'local.js'), 'utf8');
      const catchBlockMatch = localJsSrc.match(/app\.post\('\/api\/admin\/generate-key'[\s\S]*?catch \(e\) \{[\s\S]*?\n {2}\}\n\}\);/);
      assert(!!catchBlockMatch, 'generate-key route handler found in server/local.js');
      const catchBlock = catchBlockMatch[0];
      assert(!catchBlock.includes('e.message'), 'the generate-key catch block no longer interpolates e.message into any string (removed entirely, not just from the client response)');
      assert(/res\.status\(500\)\.json\(\{\s*error:\s*'Key generation failed'\s*\}\)/.test(catchBlock), "the client response is the fixed generic string 'Key generation failed', matching the pattern used by every other catch block in this file");
      assert(/console\.error\('Key generation error:', e\)/.test(catchBlock), 'the real error is still logged server-side via console.error — operators can still diagnose failures, only the client-facing leak is closed');
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed > 0 ? 1 : 0);
  } finally {
    srv.stop();
  }
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
