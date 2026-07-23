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

module.exports = { sendVerificationEmail, transporter };
