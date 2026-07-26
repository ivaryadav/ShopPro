#!/usr/bin/env node
/**
 * platform/server.js — Z-SUPERADMIN's real entrypoint. `node server.js`
 * boots the whole platform on PLATFORM_PORT (default 4100), completely
 * independent of server/local.js (ShopERP) or any other product's
 * process. Requires server/.env-style config — see .env.example.
 */
'use strict';

require('dotenv').config();
const { loadEnv } = require('./src/config/env');
const { createApp } = require('./src/app');
const { bootAllJobs } = require('./src/jobs');
const jobRunnerService = require('./src/services/jobRunnerService');

const env = loadEnv();
const app = createApp({
  jwtSecret: env.PLATFORM_JWT_SECRET,
  allowedOrigins: env.PLATFORM_ALLOWED_ORIGINS ? env.PLATFORM_ALLOWED_ORIGINS.split(',') : [],
});

bootAllJobs();

const server = app.listen(env.PLATFORM_PORT, () => {
  console.log(`\nZ-SUPERADMIN platform running: http://localhost:${env.PLATFORM_PORT}\n`);
});

// Graceful shutdown — stop every scheduled job's timer before the process
// exits, so a SIGTERM/SIGINT (Ctrl+C, container stop, systemd restart)
// never leaves an orphaned interval or an in-flight job half-written.
function gracefulShutdown(signal) {
  console.log(`\n${signal} received — stopping scheduled jobs and closing server...`);
  jobRunnerService.stopAll();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
