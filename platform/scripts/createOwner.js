#!/usr/bin/env node
/**
 * platform/scripts/createOwner.js — bootstraps the very first Platform
 * Owner account. There is no default/seeded platform user (unlike
 * ShopERP's ADMIN_KEY fallback) — deliberately: a platform managing every
 * ZMAX product should never ship with a guessable default credential.
 *
 * Usage: node scripts/createOwner.js <email> <password> [displayName]
 */
'use strict';

require('dotenv').config();
const { loadEnv } = require('../src/config/env');
loadEnv(); // fail fast if PLATFORM_JWT_SECRET etc. are missing
const platformAuthService = require('../src/services/platformAuthService');

async function main() {
  const [email, password, displayName] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/createOwner.js <email> <password> [displayName]');
    process.exit(1);
  }
  const user = await platformAuthService.createUser({ email, password, displayName: displayName || '', roleCode: 'OWNER' });
  console.log(`Platform Owner created: ${user.email} (id ${user.id})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
