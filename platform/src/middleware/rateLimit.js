/** Same in-memory IP+path rate limiter pattern as server/local.js — no new dependency. */
'use strict';

const _buckets = new Map();
function rateLimit(maxReq, windowMs) {
  return function (req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = ip + ':' + req.path;
    const now = Date.now();
    let bucket = _buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) { bucket = { start: now, count: 0 }; _buckets.set(key, bucket); }
    bucket.count += 1;
    if (bucket.count > maxReq) return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } });
    next();
  };
}
module.exports = { rateLimit };
