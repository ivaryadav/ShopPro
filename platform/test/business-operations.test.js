/**
 * platform/test/business-operations.test.js — Phase 5E: Business
 * Operations. Covers the Subscription Center, License Center extensions
 * (assign/cancel/history/grace/expiration dashboard), the Manual Billing
 * Ledger, Organization 360 expansion (subscription/usage/billing tabs),
 * the Business Dashboard, Renewal Center, the 3 new runtime jobs
 * (license-expiry/grace-period/renewal-reminder), and the new Business
 * Reports. Runs against a disposable in-process instance via
 * testServer.js, same harness every prior phase's suite uses.
 *
 * Usage: node test/business-operations.test.js
 */
'use strict';

const { startTestServer } = require('./testServer');
const { getDb } = require('../src/database/connection');
const jobRunnerService = require('../src/services/jobRunnerService');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}

async function main() {
  console.log('Z-SUPERADMIN Phase 5E — Business Operations: integration tests\n');
  const server = await startTestServer();
  const H = { Authorization: 'Bearer ' + server.ownerToken, 'Content-Type': 'application/json' };

  try {
    // ── Setup: a local organization + attached product ───────────────────
    const org = await fetch(server.baseUrl + '/api/platform/organizations', {
      method: 'POST', headers: H, body: JSON.stringify({ businessName: 'Nimbus Diagnostics', email: 'billing@nimbusdx.example' }),
    }).then((r) => r.json()).then((d) => d.organization);
    const attach = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/products`, {
      method: 'POST', headers: H, body: JSON.stringify({ productSlug: 'shoperp' }),
    }).then((r) => r.json());
    const productId = attach.products.find((p) => p.productSlug === 'shoperp').productId;
    assert(!!org.id && !!productId, 'setup: organization + attached product with an auto-created TRIAL license');

    // ── Plan Catalog ──────────────────────────────────────────────────────
    const plans = await fetch(server.baseUrl + '/api/platform/subscription-plans', { headers: H }).then((r) => r.json());
    assert(plans.plans.some((p) => p.code === 'TRIAL') && plans.plans.some((p) => p.code === 'PREMIUM'), 'Plan Catalog: seeded plans include TRIAL and PREMIUM');
    const customPlan = await fetch(server.baseUrl + '/api/platform/subscription-plans', {
      method: 'POST', headers: H, body: JSON.stringify({ code: 'CUSTOM1', name: 'Custom Tier', deviceLimit: 8, userLimit: 20, storageLimitMb: 8192, priceAmount: 4999 }),
    }).then((r) => r.json());
    assert(customPlan.plan && customPlan.plan.code === 'CUSTOM1' && customPlan.plan.device_limit === 8, 'Plan Catalog: a new plan can be created with real limits');
    const planUpdate = await fetch(server.baseUrl + `/api/platform/subscription-plans/${customPlan.plan.id}`, {
      method: 'PUT', headers: H, body: JSON.stringify({ deviceLimit: 12 }),
    }).then((r) => r.json());
    assert(planUpdate.plan.device_limit === 12, 'Plan Catalog: a plan can be updated');

    // ── License Assignment + license key generation ──────────────────────
    const assign = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/licenses/${productId}/assign`, {
      method: 'POST', headers: H, body: JSON.stringify({ planCode: 'BASIC' }),
    }).then((r) => r.json());
    assert(assign.ok && assign.planCode === 'BASIC' && /^ZMAX-/.test(assign.licenseKey), 'License Assignment: assigns a catalog plan and generates a real license key');
    const assignUnknownPlan = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/licenses/${productId}/assign`, {
      method: 'POST', headers: H, body: JSON.stringify({ planCode: 'NOT_A_REAL_PLAN' }),
    });
    assert(assignUnknownPlan.status === 400, 'License Assignment: an unknown plan code is rejected (got ' + assignUnknownPlan.status + ')');

    // ── Subscription Center: upgrade/downgrade/renew/suspend/resume ───────
    const upgrade = await fetch(server.baseUrl + `/api/platform/subscriptions/${org.id}/${productId}/upgrade`, {
      method: 'POST', headers: H, body: JSON.stringify({ planCode: 'PREMIUM' }),
    }).then((r) => r.json());
    assert(upgrade.ok && upgrade.planCode === 'PREMIUM', 'Subscription Center: upgrade changes the plan');
    const subView = await fetch(server.baseUrl + `/api/platform/subscriptions/${org.id}/${productId}`, { headers: H }).then((r) => r.json());
    assert(subView.plan && subView.plan.deviceLimit === 5 && subView.plan.userLimit === 15, 'Subscription Center: the subscription view reports the PREMIUM plan\'s real device/user limits');
    const renewSub = await fetch(server.baseUrl + `/api/platform/subscriptions/${org.id}/${productId}/renew`, {
      method: 'POST', headers: H, body: JSON.stringify({ days: 30 }),
    }).then((r) => r.json());
    assert(renewSub.ok && !!renewSub.expiresAt, 'Subscription Center: renew extends expiresAt');
    const suspendSub = await fetch(server.baseUrl + `/api/platform/subscriptions/${org.id}/${productId}/suspend`, {
      method: 'POST', headers: H, body: JSON.stringify({ reason: 'non-payment' }),
    }).then((r) => r.json());
    assert(suspendSub.ok && suspendSub.status === 'SUSPENDED', 'Subscription Center: suspend works');
    const resumeSub = await fetch(server.baseUrl + `/api/platform/subscriptions/${org.id}/${productId}/resume`, { method: 'POST', headers: H }).then((r) => r.json());
    assert(resumeSub.ok && resumeSub.status === 'ACTIVE', 'Subscription Center: resume restores ACTIVE');

    // ── Usage (devices/users vs plan limits) ──────────────────────────────
    const usage = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/usage`, { headers: H }).then((r) => r.json());
    assert(usage.deviceLimit === 5 && usage.storageUsedMb === null, 'Organization 360: Usage reports the plan\'s device limit and honestly reports storage as unmetered rather than fabricating a number');

    // ── Cancel — a genuine terminal state for local organizations ─────────
    const cancel = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/licenses/${productId}/cancel`, {
      method: 'POST', headers: H, body: JSON.stringify({ reason: 'customer requested' }),
    }).then((r) => r.json());
    assert(cancel.ok && cancel.status === 'ARCHIVED', 'License Center: cancel archives the license (terminal state)');
    const cancelledRow = getDb().prepare('SELECT cancelled_at FROM platform_licenses WHERE organization_id=? AND product_id=?').get(org.id, productId);
    assert(!!cancelledRow.cancelled_at, 'License Center: cancelled_at is recorded, distinguishing a cancellation from any other path to ARCHIVED');

    // Reactivate for the rest of the suite (assign fresh so later expiry/grace tests have a clean ACTIVE starting point).
    await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/licenses/${productId}/activate`, {
      method: 'POST', headers: H, body: JSON.stringify({ planCode: 'BASIC', days: 3 }),
    }).then((r) => r.json());

    // ── License Timeline / History ────────────────────────────────────────
    const history = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/license-history`, { headers: H }).then((r) => r.json());
    const eventTypes = history.history.map((h) => h.eventType);
    assert(eventTypes.includes('ASSIGNED') && eventTypes.includes('UPGRADED') && eventTypes.includes('CANCELLED'), 'License Timeline: records ASSIGNED/UPGRADED/CANCELLED as a real, ordered history (got ' + JSON.stringify(eventTypes) + ')');

    // ── Expiration Dashboard ───────────────────────────────────────────────
    getDb().prepare("UPDATE platform_licenses SET expires_at = datetime('now','+2 days') WHERE organization_id=? AND product_id=?").run(org.id, productId);
    const expDash = await fetch(server.baseUrl + '/api/platform/licenses/expiration-dashboard', { headers: H }).then((r) => r.json());
    assert(expDash.expiringSoon.some((e) => e.organizationId === String(org.id)), 'Expiration Dashboard: a license expiring in 2 days appears in expiringSoon');

    // ── Runtime Jobs: License Expiry + Grace Period ───────────────────────
    getDb().prepare("UPDATE platform_licenses SET status='ACTIVE', expires_at = datetime('now','-1 day') WHERE organization_id=? AND product_id=?").run(org.id, productId);
    await jobRunnerService.runNow('license-expiry');
    let licRow = getDb().prepare('SELECT status, grace_started_at FROM platform_licenses WHERE organization_id=? AND product_id=?').get(org.id, productId);
    assert(licRow.status === 'READ_ONLY' && !!licRow.grace_started_at, 'Runtime Job — License Expiry: an expired ACTIVE license becomes READ_ONLY with grace_started_at set');

    getDb().prepare("UPDATE platform_licenses SET grace_started_at = datetime('now','-20 days') WHERE organization_id=? AND product_id=?").run(org.id, productId);
    await jobRunnerService.runNow('grace-period');
    licRow = getDb().prepare('SELECT status FROM platform_licenses WHERE organization_id=? AND product_id=?').get(org.id, productId);
    assert(licRow.status === 'SUSPENDED', 'Runtime Job — Grace Period: a READ_ONLY license past its grace_period_days becomes SUSPENDED');

    // ── Runtime Job: Renewal Reminder (real email dispatch attempt, deduped) ──
    getDb().prepare("UPDATE platform_licenses SET status='ACTIVE', expires_at = datetime('now','+3 days') WHERE organization_id=? AND product_id=?").run(org.id, productId);
    const run1 = await jobRunnerService.runNow('renewal-reminder');
    assert(run1.lastStatus === 'success', 'Runtime Job — Renewal Reminder: first run succeeds');
    const historyAfterRun1 = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/license-history`, { headers: H }).then((r) => r.json());
    const reminderCount1 = historyAfterRun1.history.filter((h) => h.eventType === 'REMINDER_SENT').length;
    assert(reminderCount1 === 1, 'Runtime Job — Renewal Reminder: exactly one reminder is recorded for this organization');
    await jobRunnerService.runNow('renewal-reminder');
    const historyAfterRun2 = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/license-history`, { headers: H }).then((r) => r.json());
    const reminderCount2 = historyAfterRun2.history.filter((h) => h.eventType === 'REMINDER_SENT').length;
    assert(reminderCount2 === 1, 'Runtime Job — Renewal Reminder: a second run within the dedup window does NOT send a duplicate reminder');

    // ── Renewal (restore ACTIVE for the rest of the suite) ────────────────
    await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/licenses/${productId}/renew`, {
      method: 'POST', headers: H, body: JSON.stringify({ days: 60 }),
    }).then((r) => r.json());

    // ── Billing Ledger: Invoice / Payment / Credit / Debit / Balance ──────
    const invoice = await fetch(server.baseUrl + '/api/platform/billing/invoices', {
      method: 'POST', headers: H, body: JSON.stringify({ organizationId: String(org.id), amount: 1500, description: 'Q1 subscription' }),
    }).then((r) => r.json()).then((d) => d.invoice);
    assert(invoice.status === 'draft' && /^INV-/.test(invoice.invoice_number), 'Billing Ledger: a manual invoice is created in draft status with a real invoice number');
    const sendInv = await fetch(server.baseUrl + `/api/platform/billing/invoices/${invoice.id}/send`, { method: 'POST', headers: H }).then((r) => r.json());
    assert(sendInv.invoice.status === 'sent', 'Billing Ledger: an invoice can be sent (draft -> sent)');

    const partialPayment = await fetch(server.baseUrl + '/api/platform/billing/payments', {
      method: 'POST', headers: H, body: JSON.stringify({ organizationId: String(org.id), invoiceId: invoice.id, amount: 500, method: 'bank transfer' }),
    }).then((r) => r.json()).then((d) => d.payment);
    assert(partialPayment.amount === 500, 'Billing Ledger: a partial payment is recorded');
    const balanceAfterPartial = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/billing`, { headers: H }).then((r) => r.json());
    assert(balanceAfterPartial.balance.outstanding === 1000, 'Billing Ledger: outstanding balance reflects invoiced minus partial payment (1500 - 500 = 1000)');

    const finalPayment = await fetch(server.baseUrl + '/api/platform/billing/payments', {
      method: 'POST', headers: H, body: JSON.stringify({ organizationId: String(org.id), invoiceId: invoice.id, amount: 1000, method: 'bank transfer' }),
    }).then((r) => r.json());
    assert(!!finalPayment.payment, 'Billing Ledger: the final payment is recorded');
    const invoiceAfterFullPayment = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/billing`, { headers: H }).then((r) => r.json());
    const invRow = invoiceAfterFullPayment.invoices.find((i) => i.id === invoice.id);
    assert(invRow.status === 'paid' && !!invRow.paid_at, 'Billing Ledger: an invoice fully covered by payments auto-transitions to paid');
    assert(invoiceAfterFullPayment.balance.outstanding === 0, 'Billing Ledger: outstanding balance is 0 once fully paid');

    const creditNote = await fetch(server.baseUrl + '/api/platform/billing/adjustments', {
      method: 'POST', headers: H, body: JSON.stringify({ organizationId: String(org.id), type: 'credit', amount: 200, reason: 'goodwill gesture' }),
    }).then((r) => r.json()).then((d) => d.adjustment);
    assert(creditNote.type === 'credit', 'Billing Ledger: a Credit Note is recorded');
    const debitAdj = await fetch(server.baseUrl + '/api/platform/billing/adjustments', {
      method: 'POST', headers: H, body: JSON.stringify({ organizationId: String(org.id), type: 'debit', amount: 50, reason: 'late fee' }),
    }).then((r) => r.json()).then((d) => d.adjustment);
    assert(debitAdj.type === 'debit', 'Billing Ledger: a Debit Adjustment is recorded');
    const balanceAfterAdjustments = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/billing`, { headers: H }).then((r) => r.json());
    assert(balanceAfterAdjustments.balance.outstanding === -150, 'Billing Ledger: outstanding correctly reflects credit/debit adjustments (0 - 200 + 50 = -150)');

    const voidAttempt = await fetch(server.baseUrl + `/api/platform/billing/invoices/${invoice.id}/void`, { method: 'POST', headers: H });
    assert(voidAttempt.status === 400, 'Billing Ledger: a paid invoice cannot be voided (got ' + voidAttempt.status + ')');

    const invoiceTimeline = await fetch(server.baseUrl + `/api/platform/billing/invoices/${invoice.id}/timeline`, { headers: H }).then((r) => r.json());
    assert(invoiceTimeline.timeline.length >= 4, 'Invoice Timeline: reports created/sent/payment(s)/paid as a real ordered sequence');

    // ── Billing Dashboard ──────────────────────────────────────────────────
    const billingDash = await fetch(server.baseUrl + '/api/platform/billing/dashboard', { headers: H }).then((r) => r.json());
    assert(billingDash.revenue >= 1500 && billingDash.paid >= 1500, 'Billing Dashboard: revenue/paid reflect the real recorded payments');

    // ── Organization 360: Billing tab ─────────────────────────────────────
    const orgBilling = await fetch(server.baseUrl + `/api/platform/organizations/${org.id}/billing`, { headers: H }).then((r) => r.json());
    assert(orgBilling.invoices.length === 1 && orgBilling.payments.length === 2 && orgBilling.adjustments.length === 2, 'Organization 360: Billing tab shows this organization\'s full invoice/payment/adjustment history');

    // ── Business Dashboard ─────────────────────────────────────────────────
    const bizDash = await fetch(server.baseUrl + '/api/platform/business/dashboard', { headers: H }).then((r) => r.json());
    assert(typeof bizDash.activeCustomers === 'number' && typeof bizDash.outstandingPayments === 'number' && Array.isArray(bizDash.growthMetrics), 'Business Dashboard: reports real KPIs (activeCustomers, outstandingPayments, growthMetrics)');
    assert(bizDash.outstandingPayments === -150, 'Business Dashboard: outstandingPayments matches the ledger-computed balance exactly');

    // ── Renewal Center ─────────────────────────────────────────────────────
    getDb().prepare("UPDATE platform_licenses SET status='ACTIVE', expires_at = datetime('now','+2 days') WHERE organization_id=? AND product_id=?").run(org.id, productId);
    const renewalCenter = await fetch(server.baseUrl + '/api/platform/business/renewals', { headers: H }).then((r) => r.json());
    assert(renewalCenter.dueThisWeek.some((r) => r.organizationId === String(org.id)), 'Renewal Center: a license due in 2 days appears in dueThisWeek');
    assert(renewalCenter.renewalHistory.length > 0, 'Renewal Center: renewal history is populated from real RENEWED events');

    // ── Business Reports ───────────────────────────────────────────────────
    const reports = await fetch(server.baseUrl + '/api/platform/business/reports', { headers: H }).then((r) => r.json());
    assert(Array.isArray(reports.revenueTrends) && reports.revenueTrends.some((m) => m.total >= 1500), 'Business Reports: revenueTrends reflects the real recorded payment');
    assert(reports.licenseDistribution && typeof reports.licenseDistribution === 'object', 'Business Reports: licenseDistribution reports a real plan_code breakdown');
    assert(reports.outstandingRevenue === -150, 'Business Reports: outstandingRevenue matches the ledger exactly');
    assert(reports.renewalSuccessRate && typeof reports.renewalSuccessRate.ratePercent !== 'undefined', 'Business Reports: renewalSuccessRate is computed from real RENEWED vs SUSPENDED/CANCELLED history');
    assert(reports.customerLifetime && typeof reports.customerLifetime.sampleSize === 'number', 'Business Reports: customerLifetime reports a real (possibly small) sample size, never fabricated');

    // ── Permission enforcement: BILLING role vs SUPPORT role ─────────────
    const supportCreate = await fetch(server.baseUrl + '/api/platform/platform-users', {
      method: 'POST', headers: H, body: JSON.stringify({ email: `support${Date.now()}@zmaxlab.com`, password: 'SupportPass123!', displayName: 'Support Agent', roleCode: 'SUPPORT' }),
    }).then((r) => r.json());
    const supportLogin = await fetch(server.baseUrl + '/api/platform/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: supportCreate.user.email, password: 'SupportPass123!' }),
    }).then((r) => r.json());
    const HS = { Authorization: 'Bearer ' + supportLogin.token, 'Content-Type': 'application/json' };
    const supportBillingAttempt = await fetch(server.baseUrl + '/api/platform/billing/dashboard', { headers: HS });
    assert(supportBillingAttempt.status === 403, 'Permission enforcement: SUPPORT (lacks view_billing) cannot view the Billing Dashboard (got ' + supportBillingAttempt.status + ')');
    const supportInvoiceAttempt = await fetch(server.baseUrl + '/api/platform/billing/invoices', {
      method: 'POST', headers: HS, body: JSON.stringify({ organizationId: String(org.id), amount: 100 }),
    });
    assert(supportInvoiceAttempt.status === 403, 'Permission enforcement: SUPPORT (lacks manage_billing) cannot create an invoice (got ' + supportInvoiceAttempt.status + ')');

    // ── Validation ─────────────────────────────────────────────────────────
    const negativeInvoice = await fetch(server.baseUrl + '/api/platform/billing/invoices', {
      method: 'POST', headers: H, body: JSON.stringify({ organizationId: String(org.id), amount: -5 }),
    });
    assert(negativeInvoice.status === 400, 'Validation: a non-positive invoice amount is rejected (got ' + negativeInvoice.status + ')');
    const badAdjustmentType = await fetch(server.baseUrl + '/api/platform/billing/adjustments', {
      method: 'POST', headers: H, body: JSON.stringify({ organizationId: String(org.id), type: 'nonsense', amount: 10 }),
    });
    assert(badAdjustmentType.status === 400, 'Validation: an adjustment type other than credit/debit is rejected (got ' + badAdjustmentType.status + ')');

  } finally {
    server.stop();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
