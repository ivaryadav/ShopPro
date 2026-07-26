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

const env = loadEnv();
const app = createApp({
  jwtSecret: env.PLATFORM_JWT_SECRET,
  allowedOrigins: env.PLATFORM_ALLOWED_ORIGINS ? env.PLATFORM_ALLOWED_ORIGINS.split(',') : [],
});

app.listen(env.PLATFORM_PORT, () => {
  console.log(`\nZ-SUPERADMIN platform running: http://localhost:${env.PLATFORM_PORT}\n`);
});
