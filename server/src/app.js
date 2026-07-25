/**
 * server/src/app.js
 *
 * Assembles the Identity & Tenant Core + Operations Domain Express app
 * (Phase 2 + Phase 4). NOT the running production server — server/local.js
 * remains that until a future cutover phase
 * (docs/adr/0001-enterprise-reconstruction.md, Phase 9). This exists so
 * the new architecture is genuinely testable end-to-end, not just
 * unit-tested in isolation.
 *
 * Security headers, CORS, and compression are ported from local.js
 * verbatim (local.js:599-637) — cross-cutting infra, not tied to any one
 * bounded context, so porting them here too matches "never weaken existing
 * security."
 */
'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { createAuthRouter } = require('./routes/auth');
const { createUsersRouter } = require('./routes/users');
const { createInventoryRouter } = require('./routes/inventory');
const { createCustomersRouter } = require('./routes/customers');
const { createSalesRouter } = require('./routes/sales');
const { createRepairsRouter } = require('./routes/repairs');
const { createExpensesRouter } = require('./routes/expenses');
const { createSettingsRouter } = require('./routes/settings');
const { createLicenseRouter } = require('./routes/license');
const { errorHandler } = require('./errors');
const { checkDatabaseHealth } = require('./database');
const sessionService = require('./services/sessionService');
const tenantLicenseService = require('./services/tenantLicenseService');
const { getLogger } = require('./logging');

const SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // matches local.js's _runSessionCleanup() interval exactly
// Matches local.js's LICENSE_SWEEP_INTERVAL_MS exactly, including the same
// env-var override for tests that want to fast-forward it (local.js:564).
const LICENSE_SWEEP_INTERVAL_MS = Number(process.env.LICENSE_SWEEP_INTERVAL_MS) || 15 * 60 * 1000;

/**
 * @param {{jwtSecret: string, allowedOrigins?: string[], startCleanupJob?: boolean}} config
 * @returns {import('express').Express}
 */
function createApp({ jwtSecret, allowedOrigins, startCleanupJob = true }) {
  if (!jwtSecret) {
    throw new Error('createApp requires config.jwtSecret');
  }
  const app = express();
  app.set('trust proxy', 1);

  // Matches local.js's _runSessionCleanup() pattern exactly (same interval,
  // same "run once at boot, then on a timer" shape) — marks idle sessions
  // expired and hard-deletes long-dead revoked/expired rows so
  // user_sessions doesn't grow unbounded. Skippable via startCleanupJob:false
  // for tests that don't want a background timer outliving them.
  if (startCleanupJob) {
    const logger = getLogger();
    const runCleanup = () => {
      sessionService.runCleanup().catch((e) => logger.error('[Sessions] cleanup failed', { error: e.message }));
    };
    runCleanup();
    setInterval(runCleanup, SESSION_CLEANUP_INTERVAL_MS).unref();

    // Matches local.js's runLicenseTransitionSweep() pattern exactly (run
    // once at boot, then on a timer) — RC1 Sprint 1 (Licensing Domain).
    const runSweep = () => {
      tenantLicenseService.runTransitionSweep().catch((e) => logger.error('[Licensing] sweep failed', { error: e.message }));
    };
    runSweep();
    setInterval(runSweep, LICENSE_SWEEP_INTERVAL_MS).unref();
  }

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
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()'
    );
    // Matches local.js's CSP string verbatim (local.js:626-628) — applied
    // globally there (every response, HTML or JSON), so it is here too,
    // even though this app serves no HTML itself in Phase 2's scope.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https://prod.spline.design https://app.spline.design; media-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' https://prod.spline.design https://unpkg.com; worker-src 'self' blob:; frame-ancestors 'none';"
    );
    next();
  });
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', async (_req, res) => {
    const dbHealth = await checkDatabaseHealth();
    res.json({
      status: dbHealth.ok ? 'ok' : 'degraded',
      mode: 'mariadb-identity-and-operations',
      time: new Date().toISOString(),
      db: dbHealth.ok ? 'ok' : 'error',
    });
  });

  app.use('/api/auth', createAuthRouter({ jwtSecret }));
  app.use('/api/data', createUsersRouter({ jwtSecret }));

  // Operations domain (Phase 4) — real per-entity REST endpoints, a
  // necessary consequence of ADR-0008's normalization decision (local.js
  // itself has no equivalent; everything there goes through one
  // GET/PUT /api/data whole-blob path).
  app.use('/api/inventory', createInventoryRouter({ jwtSecret }));
  app.use('/api/customers', createCustomersRouter({ jwtSecret }));
  app.use('/api/sales', createSalesRouter({ jwtSecret }));
  app.use('/api/repairs', createRepairsRouter({ jwtSecret }));
  app.use('/api/expenses', createExpensesRouter({ jwtSecret }));
  app.use('/api/settings', createSettingsRouter({ jwtSecret }));

  // Licensing domain (RC1 Sprint 1) — GET /api/license/status only; every
  // other Licensing action (approve/reject/assign-plan/extend/suspend/etc.)
  // is service-layer-only for now, since its real-world gate
  // (requireAdminKey) is Administration domain, out of scope for this
  // sprint — same "tested service, no public route yet" precedent as
  // Phase 2's resetPin/setActive.
  app.use('/api/license', createLicenseRouter({ jwtSecret }));

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
