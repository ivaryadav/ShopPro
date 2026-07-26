/**
 * platform/src/services/platformMailerService.js — SMTP is OPTIONAL for
 * the platform foundation (unlike ShopERP's own mailer, which fails boot
 * without it) — a "Revenue (future-ready)" dashboard card and this
 * best-effort mailer share the same reasoning: some v1.0 foundation
 * pieces are deliberately non-blocking until a real deployment configures
 * them. If SMTP isn't configured, sends are logged, not thrown.
 */
'use strict';

const nodemailer = require('nodemailer');
const { loadEnv } = require('../config/env');

let _transporter = null;
function getTransporter(source) {
  if (_transporter) return _transporter;
  const env = loadEnv(source);
  if (!env.PLATFORM_SMTP_HOST) return null;
  _transporter = nodemailer.createTransport({
    host: env.PLATFORM_SMTP_HOST, port: env.PLATFORM_SMTP_PORT,
    secure: env.PLATFORM_SMTP_PORT === 465,
    auth: env.PLATFORM_SMTP_USER ? { user: env.PLATFORM_SMTP_USER, pass: env.PLATFORM_SMTP_PASS } : undefined,
  });
  return _transporter;
}

async function send({ to, subject, html }, source) {
  const transporter = getTransporter(source);
  if (!transporter) {
    console.log(`[PLATFORM MAILER] SMTP not configured — logging only. To: ${to}, Subject: ${subject}`);
    return { delivered: false, reason: 'smtp_not_configured' };
  }
  const env = loadEnv(source);
  await transporter.sendMail({ from: env.PLATFORM_SMTP_FROM, to, subject, html });
  return { delivered: true };
}

module.exports = { send };
