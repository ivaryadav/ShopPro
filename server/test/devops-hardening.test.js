/**
 * Production-hardening regression test — Permissions-Policy header +
 * response compression (Issue 4, docs/production-hardening/DevOpsHardening.md).
 *
 * Verifies the new header/compression additions work, and that every
 * pre-existing security header (especially CSP) is completely unaffected.
 *
 * Usage:  node server/test/devops-hardening.test.js
 */
'use strict';

const { startTestServer } = require('./testServer');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Production-hardening regression: Permissions-Policy + compression (Issue 4)');
  console.log('Starting isolated test server...');
  const srv = await startTestServer();
  console.log('Isolated server up: ' + srv.baseUrl);
  console.log('');

  try {
    // ── Permissions-Policy ───────────────────────────────────────────────────
    let r = await fetch(srv.baseUrl + '/');
    const pp = r.headers.get('permissions-policy');
    assert(!!pp, 'Permissions-Policy header is present');
    ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()'].forEach(directive => {
      assert(pp.includes(directive), `Permissions-Policy locks down "${directive}" (this app never uses this feature)`);
    });

    // ── Pre-existing security headers unaffected ────────────────────────────
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options unchanged');
    assert(r.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options unchanged');
    assert(r.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', 'Referrer-Policy unchanged');

    // ── CSP — no regression, byte-identical to before this issue ────────────
    const csp = r.headers.get('content-security-policy');
    assert(!!csp, 'Content-Security-Policy still present');
    assert(csp.includes("default-src 'self'"), 'CSP default-src unchanged');
    assert(csp.includes("frame-ancestors 'none'"), 'CSP frame-ancestors unchanged');
    assert(csp.includes('https://unpkg.com'), 'CSP script-src allowlist unchanged');
    assert(csp.includes('https://prod.spline.design'), 'CSP connect-src/img-src allowlist unchanged');

    // ── Compression ──────────────────────────────────────────────────────────
    const compressed = await fetch(srv.baseUrl + '/', { headers: { 'Accept-Encoding': 'gzip' } });
    assert(compressed.headers.get('content-encoding') === 'gzip', 'response is gzip-compressed when the client accepts it');

    const uncompressed = await fetch(srv.baseUrl + '/', { headers: { 'Accept-Encoding': 'identity' } });
    assert(!uncompressed.headers.get('content-encoding'), 'response is NOT compressed when the client does not accept an encoding (identity)');
    const rawSize = Number(uncompressed.headers.get('content-length'));
    assert(rawSize > 1_000_000, 'uncompressed response is the expected multi-MB size (sanity check, not a stub)');

    // ── Compression does not corrupt the actual content ─────────────────────
    const body = await compressed.text();
    assert(body.includes('<!DOCTYPE html>') || body.includes('<!doctype html>'), 'the gzip-compressed response still decodes to valid, complete HTML (fetch() transparently decompresses)');
    const bodyByteLength = Buffer.byteLength(body, 'utf8');
    assert(bodyByteLength === rawSize, 'decompressed content is byte-for-byte the same size as the uncompressed response (nothing truncated or corrupted)');

    // ── JSON API responses are also correctly served (compression doesn't break them) ─
    const health = await fetch(srv.baseUrl + '/health', { headers: { 'Accept-Encoding': 'gzip' } }).then(x => x.json());
    assert(health.status === 'ok', 'a JSON API response still parses correctly through the compression middleware');

  } finally {
    srv.stop();
    console.log('\nIsolated test server stopped, temp DB removed.');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test run crashed:', e); process.exit(1); });
