/**
 * server/src/middleware/rateLimit.js
 *
 * Ports server/local.js's hand-rolled, dependency-free in-memory rate
 * limiter verbatim (local.js:507-530) — omitting rate limiting here would
 * be a real security regression ("never weaken existing security"), and
 * local.js already deliberately avoids the `express-rate-limit` package
 * (present in package.json only for the vestigial server/index.js), so
 * this matches house style rather than introducing a new dependency.
 */
'use strict';

const _buckets = new Map();

/**
 * @param {number} maxReq
 * @param {number} windowMs
 * @returns {import('express').RequestHandler}
 */
function rateLimit(maxReq, windowMs) {
  return function (req, res, next) {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    const key = ip + ':' + req.path;
    const now = Date.now();
    let bucket = _buckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > bucket.reset) bucket = { count: 0, reset: now + windowMs };
    bucket.count++;
    _buckets.set(key, bucket);
    if (bucket.count > maxReq) {
      const retryAfter = Math.ceil((bucket.reset - now) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many requests. Try again in ' + retryAfter + 's.' });
    }
    next();
  };
}

setInterval(function () {
  const now = Date.now();
  for (const [k, v] of _buckets.entries()) {
    if (now > v.reset) _buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

module.exports = { rateLimit };
