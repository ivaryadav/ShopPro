/**
 * platform/src/app.js — Z-SUPERADMIN's own Express app. A separate process
 * from server/local.js (or any product), on its own port, with its own
 * database, its own auth, its own everything. The two never share a
 * process, a database connection, or a secret.
 */
'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createPlatformRouter } = require('./routes/index');
const { errorHandler } = require('./errors');
const { getDb } = require('./database/connection');

function createApp({ jwtSecret, allowedOrigins }) {
  if (!jwtSecret) throw new Error('createApp requires config.jwtSecret');
  const app = express();
  app.set('trust proxy', 1);

  app.use(cors({
    origin: function (origin, cb) {
      if (!origin || !allowedOrigins || allowedOrigins.length === 0) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('CORS: origin not allowed'));
    },
    credentials: true,
  }));
  app.use(function (req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (_req, res) => {
    try {
      getDb().prepare('SELECT 1').get();
      res.json({ status: 'ok', service: 'z-superadmin', time: new Date().toISOString() });
    } catch (e) {
      res.status(503).json({ status: 'degraded', service: 'z-superadmin', error: e.message });
    }
  });

  // Bare liveness probe for load balancers / uptime monitors — intentionally
  // minimal and unauthenticated, unlike the rich GET /api/platform/health
  // (Phase 5A System Health) which requires a session and reports DB +
  // per-adapter reachability + version info.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.use('/api/platform', createPlatformRouter({ jwtSecret }));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
