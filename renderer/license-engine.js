/**
 * ShopERP Pro — License Crypto Engine v4
 * ═══════════════════════════════════════════════════
 * SECURITY: DEVELOPER EYES ONLY
 * Never ship this file to customers.
 * ═══════════════════════════════════════════════════
 *
 * Key encodes:  machineId + plan + expiryDate + MASTER_SECRET
 * custId is admin metadata only — NOT part of the key formula.
 * This guarantees keys always validate regardless of customer number.
 */
'use strict';

// ── MASTER SECRET — change ONCE before first distribution ─────
const MASTER_SECRET = 'SH0P3RP0-PR0-M4ST3R-K3Y-D33P4K-2025-X9Z';

// ── PLANS ────────────────────────────────────────────────────
const PLANS = {
  monthly:    { label: 'Monthly',     days: 30,    code: 11, price: 299  },
  halfyearly: { label: 'Half-Yearly', days: 180,   code: 22, price: 1499 },
  yearly:     { label: 'Yearly',      days: 365,   code: 33, price: 2499 },
  lifetime:   { label: 'Lifetime',    days: 36500, code: 44, price: 7999 },
};

// 32-char unambiguous charset (no 0/O, 1/I confusion)
const CS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ── FNV-1a 32-bit hash ────────────────────────────────────────
function fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = ((h & 0xffff) * 0x01000193 + ((h >>> 16) * 0x01000193 << 16)) & 0xffffffff;
  }
  return h >>> 0;
}

// ── Base-32 encode ────────────────────────────────────────────
function enc(num, len) {
  let s = '', n = (num >>> 0);
  for (let i = 0; i < len; i++) { s = CS[n % CS.length] + s; n = Math.floor(n / CS.length); }
  return s;
}

// ── Compute 4 key segments ────────────────────────────────────
// IMPORTANT: custId is NOT part of this formula.
// Only machineId + planCode + expiryDays + MASTER_SECRET determine the key.
function computeSegments(mid, planCode, expiryDays) {
  const eD = (expiryDays >>> 0);
  const pC = (planCode   >>> 0);
  // Base string: machine + plan + expiry + secret (no custId)
  const base = mid + '|' + pC + '|' + eD + '|' + MASTER_SECRET;
  const h1 = fnv32(base + '~S1');
  const h2 = fnv32(base + '~S2');
  const h3 = fnv32(base + '~S3');
  const h4 = fnv32(base + '~S4');
  // XOR with plan and expiry constants to guarantee plan-distinct keys
  const x1 = (h1 ^ ((eD & 0xFFFF) * pC)) >>> 0;
  const x2 = (h2 ^ (pC * 0x9E37))        >>> 0;
  const x3 = (h3 ^ (eD >> 4))             >>> 0;
  const x4 = (h4 ^ (pC << 8))             >>> 0;
  return [enc(x1, 4), enc(x2, 4), enc(x3, 4), enc(x4, 4)];
}

// ── GENERATE KEY ─────────────────────────────────────────────
// custId is accepted as param for admin records but does NOT affect the key.
function generateKey(machineId, plan, custId) {
  const p = PLANS[plan];
  if (!p) throw new Error('Unknown plan: ' + plan);
  const mid = machineId.replace(/-/g, '').toUpperCase().padEnd(16, '0').substring(0, 16);
  const todayDays = Math.floor(Date.now() / 86400000);
  const expiryDays = (todayDays + p.days) >>> 0;
  const segs = computeSegments(mid, p.code, expiryDays);
  return segs.join('-');
}

// ── VALIDATE KEY ─────────────────────────────────────────────
function validateKey(key, machineId) {
  const clean = key.replace(/-/g, '').toUpperCase();
  if (clean.length !== 16) return { valid: false, message: 'Key must be 16 characters (got ' + clean.length + ')' };
  for (const c of clean) {
    if (CS.indexOf(c) < 0) return { valid: false, message: 'Invalid character in key: ' + c };
  }
  const mid = machineId.replace(/-/g, '').toUpperCase().padEnd(16, '0').substring(0, 16);
  const todayDays = Math.floor(Date.now() / 86400000);

  // Try every plan × every possible issue date
  for (const [planId, p] of Object.entries(PLANS)) {
    for (let ago = 0; ago <= p.days; ago++) {
      const expiryDays = (todayDays - ago + p.days) >>> 0;
      const segs = computeSegments(mid, p.code, expiryDays);
      if (segs.join('') === clean) {
        const daysLeft = Math.max(0, expiryDays - todayDays);
        const expired  = daysLeft <= 0;
        const expDate  = new Date(expiryDays * 86400000).toISOString().split('T')[0];
        return {
          valid: true, expired,
          plan: planId, planLabel: p.label,
          expiryDate: expDate, daysLeft,
          message: expired
            ? 'Expired ' + (todayDays - expiryDays) + ' days ago'
            : planId === 'lifetime'
              ? 'Lifetime — never expires'
              : daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + ' remaining (expires ' + expDate + ')',
        };
      }
    }
  }
  return { valid: false, message: 'Key is invalid or belongs to a different machine' };
}

// ── BROWSER MACHINE ID ────────────────────────────────────────
function generateBrowserMachineId() {
  try {
    const f = [
      typeof navigator !== 'undefined' ? navigator.userAgent   : 'UA',
      typeof navigator !== 'undefined' ? navigator.language    : 'EN',
      typeof screen    !== 'undefined' ? screen.width + 'x' + screen.height : '1920x1080',
      typeof screen    !== 'undefined' ? String(screen.colorDepth) : '24',
      String(new Date().getTimezoneOffset()),
      typeof navigator !== 'undefined' ? String(navigator.hardwareConcurrency || 4) : '4',
      typeof navigator !== 'undefined' ? (navigator.platform || 'PLAT') : 'PLAT',
    ].join('|');
    return [fnv32(f+'_A'), fnv32(f+'_B'), fnv32(f+'_C'), fnv32(f+'_D')]
      .map(h => enc(h, 4)).join('-');
  } catch { return 'BROW-SER0-MACH-ID00'; }
}

// ── SELF-TEST ─────────────────────────────────────────────────
function runSelfTest() {
  const mid   = 'A3F29B1C7E4D2F8A';
  const wrong = 'FFFFFFFFFFFFFFFF';
  const results = [];
  const allKeys = [];
  let pass = 0, fail = 0;

  for (const planId of Object.keys(PLANS)) {
    // Generate with various custIds — should produce SAME key (custId doesn't matter)
    const key1 = generateKey(mid, planId, 'CUST1');
    const key2 = generateKey(mid, planId, 'CUST99');
    const key3 = generateKey(mid, planId, undefined);
    const custIdIndependent = (key1 === key2 && key2 === key3);

    const r1 = validateKey(key1, mid);    // correct machine
    const r2 = validateKey(key1, wrong);  // wrong machine
    const planMatch = r1.plan === planId;
    const isUnique  = !allKeys.includes(key1);
    allKeys.push(key1);

    const ok = r1.valid && !r1.expired && !r2.valid && planMatch && isUnique && custIdIndependent;
    if (ok) pass++; else fail++;
    results.push({ planId, key: key1, valid: r1.valid, wrongValid: r2.valid, planMatch, isUnique, custIdIndependent, status: ok ? 'PASS' : 'FAIL' });
  }
  return { pass, fail, total: pass + fail, results };
}

// ── EXPORTS ───────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateKey, validateKey, generateBrowserMachineId, runSelfTest, PLANS, MASTER_SECRET };
}
