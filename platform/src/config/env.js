/**
 * platform/src/config/env.js
 *
 * Z-SUPERADMIN's own environment configuration. Deliberately named
 * PLATFORM_* throughout so nothing here can ever collide with, or be
 * confused for, ShopERP's own env vars (JWT_SECRET, ADMIN_KEY, etc.) even
 * if both processes somehow shared a shell environment — the isolation
 * principle applies to configuration, not just runtime state.
 */
'use strict';

const SPEC = {
  PLATFORM_JWT_SECRET: { required: true },
  PLATFORM_PORT: { default: '4100', parse: (v) => Number(v) },
  PLATFORM_DB_PATH: { default: './platform.db' },
  PLATFORM_ALLOWED_ORIGINS: { default: '' },
  PLATFORM_SMTP_HOST: { default: '' },
  PLATFORM_SMTP_PORT: { default: '587', parse: (v) => Number(v) },
  PLATFORM_SMTP_USER: { default: '' },
  PLATFORM_SMTP_PASS: { default: '' },
  PLATFORM_SMTP_FROM: { default: 'Z-SUPERADMIN <no-reply@zmaxlab.com>' },

  // ShopERP adapter (platform/src/adapters/shoperpAdapter.js) — optional.
  // Unset = the adapter reports isConfigured():false and ShopERP simply
  // doesn't appear in Z-SUPERADMIN's data, rather than erroring at boot.
  SHOPERP_BASE_URL: { default: '' },
  SHOPERP_ADMIN_PASSWORD: { default: '' },
};

function loadEnv(source) {
  const env = source || process.env;
  const out = {};
  const missing = [];
  for (const [key, spec] of Object.entries(SPEC)) {
    let val = env[key];
    if (val === undefined || val === '') {
      if (spec.required) { missing.push(key); continue; }
      val = spec.default;
    }
    out[key] = spec.parse ? spec.parse(val) : val;
  }
  if (missing.length) {
    throw new Error(`Missing required platform env var(s): ${missing.join(', ')}`);
  }
  return out;
}

module.exports = { loadEnv };
