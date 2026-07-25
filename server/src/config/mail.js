/**
 * server/src/config/mail.js
 *
 * Typed SMTP config for the enterprise backend's future mailer (Phase 4,
 * SaaS Licensing & Subscriptions — email verification). Mirrors
 * server/mailer.js's existing "all five SMTP_* vars mandatory, fail loudly
 * at boot if any are missing" posture, expressed as validated config.
 */
'use strict';

const { loadEnv } = require('./env');

/**
 * @typedef {Object} MailConfig
 * @property {string} host
 * @property {number} port
 * @property {string} user
 * @property {string} pass
 * @property {string} from
 */

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @param {{ optional?: boolean }} [opts] - Pass optional:true to load without
 *   throwing (e.g. for a health-check that reports mail as "unconfigured"
 *   rather than crashing) — real send paths should not use this.
 * @returns {MailConfig}
 * @throws {Error} If any SMTP_* variable is missing and opts.optional is not set.
 */
function getMailConfig(source, opts = {}) {
  const env = loadEnv(source);
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].filter((k) => !env[k]);
  if (missing.length > 0 && !opts.optional) {
    throw new Error(`[Config] Missing required SMTP configuration: ${missing.join(', ')}`);
  }
  return Object.freeze({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
  });
}

module.exports = { getMailConfig };
