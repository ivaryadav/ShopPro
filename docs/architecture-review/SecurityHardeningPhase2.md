# Security Hardening — Phase 2 (S-7, S-9, S-10)

All three findings from `SecurityHardeningReview.md` were already assessed as Low severity there — this task implements them (per this task's own "implement only if LOW RISK" instruction), rather than re-litigating severity.

## S-7: JWT verification did not pin the algorithm

**Change** (`server/local.js`, `requireAuth`):
```diff
- const payload = jwt.verify(header.slice(7), JWT_SECRET);
+ const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
```

**Verified this has a real, measurable effect, not just theoretical**: empirically confirmed that `jsonwebtoken`'s unpinned `jwt.verify(token, secret)` accepts a token signed with a *different* HMAC variant (HS384) using the *same* secret — i.e., without the pin, the algorithm the token's own header claims is trusted rather than restricted. With the pin, that same HS384 token is correctly rejected (`invalid algorithm`). Confirmed live against the real running server too: an HS384-signed Bearer token is rejected with 401 at `/api/data`.

**Backward compatible**: yes — `sessions.js`'s `jwt.sign()` (the only place tokens are issued) always signs with the library's default algorithm, which is HS256 for a plain string secret (confirmed: no `algorithm` option is passed there, and no other signing call site exists in the codebase — checked via `grep -n "jwt.sign" *.js`). Every token this system has ever issued or will issue is HS256, so the pin restricts to exactly the algorithm already in universal use.

## S-9: Raw error-message disclosure on `POST /api/admin/generate-key`

**Change** (`server/local.js`):
```diff
  } catch (e) {
-   res.status(500).json({ error: 'Key generation failed: ' + e.message });
+   console.error('Key generation error:', e);
+   res.status(500).json({ error: 'Key generation failed' });
  }
```
Matches the exact pattern already used by every other catch block in this file (e.g. the renew-license handler a few hundred lines away: `console.error('Renew license error:', e); res.status(500).json({error:'Renewal failed'});`) — not a new pattern invented for this fix.

**Backward compatible**: yes — the success path (the overwhelming majority of calls to this endpoint) is completely untouched; only the shape of an already-rare 500 response changes, and no caller in this codebase parses `error` beyond displaying it as a string (checked: the client's admin panel just does `toast('Failed: '+e.message,...)`-style display, never branches on the error text's content).

## S-10: Admin key comparison was not timing-safe

**Change** (`server/local.js`, `requireAdminKey`):
```diff
  function requireAdminKey(req, res, next) {
    const key = req.headers['x-admin-key'];
-   if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
+   const keyBuf = Buffer.from(key || '', 'utf8');
+   const adminKeyBuf = Buffer.from(ADMIN_KEY, 'utf8');
+   const valid = key
+     && keyBuf.length === adminKeyBuf.length
+     && crypto.timingSafeEqual(keyBuf, adminKeyBuf);
+   if (!valid) return res.status(401).json({ error: 'Invalid admin key' });
    next();
  }
```
The length check runs before `crypto.timingSafeEqual()` because that function throws (rather than returning `false`) on mismatched-length buffers — length itself isn't a meaningful secret to protect (unlike content), so short-circuiting on it first introduces no new timing leak of consequence. Added a top-level `const crypto = require('crypto');` (the module wasn't previously imported at the top of this file, only inline via `require('crypto')` at a few unrelated call sites elsewhere — left those untouched, out of scope for this fix).

**Backward compatible**: yes — for any input, `valid` evaluates to exactly the same boolean the old `key !== ADMIN_KEY` check would have produced; only *how long* an incorrect answer takes to compute changes, not *what* the answer is.

## Regression tests

`server/test/security-phase2.test.js`, 14 assertions, all passing:
```
✓ baseline (unpinned) jwt.verify accepts both HS256 and HS384 tokens signed with the same secret
✓ pinned jwt.verify({algorithms:["HS256"]}) rejects an HS384-signed token with the same secret
✓ live server: an HS384-signed Bearer token is rejected with 401
✓ regression: normal API traffic still responds correctly after the algorithm pin
✓ regression: the correct admin key is still accepted (200) after switching to timingSafeEqual
✓ a wrong admin key of different length is still rejected (401)
✓ a same-length admin key differing in only the last character is rejected (401)
✓ missing admin key header is still rejected (401)
✓ regression: generate-key success path is unaffected
✓ unknown-plan error response contains no stack-trace-shaped internal detail
✓ generate-key route handler found in server/local.js
✓ the generate-key catch block no longer interpolates e.message into any string
✓ the client response is the fixed generic string 'Key generation failed'
✓ the real error is still logged server-side via console.error

14 passed, 0 failed
```

**Why S-9's genuine 500 path is verified via extracted source rather than a live trigger**: `license.generateKey()`'s only throw condition (an unknown plan) is already pre-validated by the route itself before the `try` block is ever entered (`if (!plan || !license.PLANS[plan]) return res.status(400)...` runs first) — so the actual `catch(e)` block this fix touches isn't realistically reachable via a live request without contrived internal-state corruption. Verified instead by extracting the real, current route handler source from `server/local.js` and asserting on its shape directly (no `e.message` interpolation anywhere in the block, the exact fixed client-facing string, and that `console.error` still logs the real error) — the same extract-and-verify approach already established in `migration-safety.test.js` for an analogous hard-to-trigger-live case.

Full suite re-run after all three fixes: **152/152 assertions passing** across all 7 test files, lint clean. Wired into `npm run test` and `.github/workflows/ci.yml` (new step: "Security tests — phase 2 (S-7/S-9/S-10)").

## Files changed

- `server/local.js` — `requireAuth` (S-7), `requireAdminKey` (S-10), generate-key catch block (S-9), one new top-level `require('crypto')`.
- `server/test/security-phase2.test.js` — new file, 14 assertions.
- `server/package.json` — added `test:security-phase2`, added to aggregate `test`.
- `.github/workflows/ci.yml` — added a "Security tests — phase 2 (S-7/S-9/S-10)" step.
