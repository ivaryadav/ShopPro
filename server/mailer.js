/**
 * ShopERP Pro — Outbound Email (hosted registration flow only)
 * ─────────────────────────────────────────────────────────────
 * Required for the Step 5 email-verification link sent by
 * POST /api/auth/signup. No email infrastructure existed anywhere in this
 * project before this file — see docs/architecture-review/RegistrationFlow.md.
 *
 * SMTP_HOST/PORT/USER/PASS/FROM are mandatory, same fail-loudly-at-boot
 * posture as the existing JWT_SECRET check in server/local.js: an
 * unconfigured mailer would otherwise let signups silently never receive a
 * verification email, with no way for an operator to notice short of a
 * customer complaint. This affects every server/local.js deployment, even
 * ones not yet using the new registration flow — see
 * docs/architecture-review/LicensingMigrationPlan.md for the deploy note.
 */
'use strict';

const nodemailer = require('nodemailer');

const REQUIRED = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n[FATAL] Missing SMTP env vars: ${missing.join(', ')}`);
  console.error('Registration email verification cannot work without these. Set them in server/.env:');
  console.error('  SMTP_HOST=smtp.example.com');
  console.error('  SMTP_PORT=587');
  console.error('  SMTP_USER=you@example.com');
  console.error('  SMTP_PASS=your-smtp-password-or-app-key');
  console.error('  SMTP_FROM="ShopERP Pro <no-reply@example.com>"\n');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// Verified at boot but only logged, never fatal — an SMTP outage shouldn't
// take down the whole POS server, only degrade the one feature that needs it.
transporter.verify().catch(e => {
  console.error('[MAILER] SMTP verify failed at boot:', e.message);
});

async function sendVerificationEmail(toEmail, { shopName, verifyUrl }) {
  return transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject: `Verify your email — ${shopName} on ShopERP Pro`,
    html: `<p>Hi,</p>
<p>Thanks for registering <strong>${shopName}</strong> on ShopERP Pro. Click below to verify your email address:</p>
<p><a href="${verifyUrl}">${verifyUrl}</a></p>
<p>This link expires in 24 hours. Once verified, our team will review your registration and approve your account.</p>`,
  });
}

// ── Super Admin Portal (v1.0) additions ──────────────────────────────────────
// Every function below follows sendVerificationEmail's exact shape (same
// transporter, same from address, same plain-HTML style) — no new email
// infrastructure, just more templates on the one that already exists.

async function sendWelcomeEmail(toEmail, { shopName, planLabel }) {
  return transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject: `Welcome to ShopERP Pro, ${shopName}!`,
    html: `<p>Hi,</p>
<p>Your shop <strong>${shopName}</strong> has been approved on ShopERP Pro${planLabel ? ` on the <strong>${planLabel}</strong> plan` : ''}.</p>
<p>You can now log in and start using your account. If you have any questions, just reply to this email.</p>`,
  });
}

async function sendRenewalReminder(toEmail, { shopName, expiresAt, daysRemaining }) {
  return transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject: `Your ShopERP Pro subscription expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
    html: `<p>Hi,</p>
<p><strong>${shopName}</strong>'s ShopERP Pro subscription expires on <strong>${expiresAt}</strong> (${daysRemaining} day${daysRemaining === 1 ? '' : 's'} from today).</p>
<p>Please contact us to renew before then to avoid any interruption to your account.</p>`,
  });
}

async function sendExpiryNotice(toEmail, { shopName, expiresAt }) {
  return transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject: `Your ShopERP Pro subscription has expired`,
    html: `<p>Hi,</p>
<p><strong>${shopName}</strong>'s ShopERP Pro subscription expired on <strong>${expiresAt}</strong>. Your account is now read-only.</p>
<p>Please contact us to renew and restore full access.</p>`,
  });
}

async function sendCustomEmail(toEmail, { subject, body }) {
  return transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject,
    html: `<p>${body}</p>`,
  });
}

module.exports = { sendVerificationEmail, sendWelcomeEmail, sendRenewalReminder, sendExpiryNotice, sendCustomEmail, transporter };
