/**
 * platform/src/services/billingService.js — Phase 5E Manual Billing Ledger.
 * No payment gateway in this phase — every invoice/payment/adjustment here
 * is operator-entered. organization_id is TEXT throughout (like
 * organization_notes) so billing works identically for local and
 * ShopERP-adapter-backed customers without any adapter contract change —
 * billing is pure platform business data, never product data.
 *
 * Outstanding balance is always computed live from the ledger (invoiced -
 * paid - credits + debits), never cached, matching this codebase's
 * established "derive, don't cache derived state" convention (see
 * maintenanceGate/alertService).
 */
'use strict';

const invoiceRepository = require('../repositories/platformInvoiceRepository');
const paymentRepository = require('../repositories/platformPaymentRepository');
const adjustmentRepository = require('../repositories/platformBillingAdjustmentRepository');
const auditService = require('./auditService');
const { NotFoundError: NF, ValidationError: VE } = require('../errors');

function generateInvoiceNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1e4).toString().padStart(4, '0');
  return `INV-${stamp}-${rand}`;
}

function getBalance(organizationId) {
  const org = String(organizationId);
  const invoiced = require('../database/connection').getDb()
    .prepare("SELECT COALESCE(SUM(amount),0) s FROM platform_invoices WHERE organization_id = ? AND status != 'void'").get(org).s;
  const paid = paymentRepository.sumForOrganization(org);
  const credits = adjustmentRepository.sumForOrganization(org, 'credit');
  const debits = adjustmentRepository.sumForOrganization(org, 'debit');
  return { invoiced, paid, credits, debits, outstanding: Math.round((invoiced - paid - credits + debits) * 100) / 100 };
}

function createInvoice({ organizationId, productId, description, amount, currency, dueAt }, actor) {
  if (!organizationId) throw new VE('organizationId is required');
  if (!(amount > 0)) throw new VE('amount must be a positive number');
  const invoice = invoiceRepository.create({
    organizationId, productId, invoiceNumber: generateInvoiceNumber(), description, amount, currency, dueAt, createdBy: actor.userId,
  });
  auditService.record({ platformUserId: actor.userId, organizationId: null, action: 'INVOICE_CREATED', newValue: invoice.invoice_number, detail: `${organizationId} — ${amount} ${currency || 'INR'}`, ip: actor.ip });
  return invoice;
}

function sendInvoice(invoiceId, actor) {
  const inv = invoiceRepository.findById(invoiceId);
  if (!inv) throw new NF('Invoice not found');
  if (inv.status !== 'draft') throw new VE('Only a draft invoice can be sent');
  const updated = invoiceRepository.updateStatus(invoiceId, 'sent');
  auditService.record({ platformUserId: actor.userId, action: 'INVOICE_SENT', newValue: inv.invoice_number, ip: actor.ip });
  return updated;
}

function voidInvoice(invoiceId, actor) {
  const inv = invoiceRepository.findById(invoiceId);
  if (!inv) throw new NF('Invoice not found');
  if (inv.status === 'paid') throw new VE('A paid invoice cannot be voided');
  const updated = invoiceRepository.updateStatus(invoiceId, 'void');
  auditService.record({ platformUserId: actor.userId, action: 'INVOICE_VOIDED', oldValue: inv.status, newValue: 'void', detail: inv.invoice_number, ip: actor.ip });
  return updated;
}

/** Payment Entry — recording a real payment received against an invoice (or a standalone credit, invoiceId omitted). Auto-marks the invoice paid once fully covered. */
function recordPayment({ organizationId, invoiceId, amount, currency, method, reference, note }, actor) {
  if (!organizationId) throw new VE('organizationId is required');
  if (!(amount > 0)) throw new VE('amount must be a positive number');
  let invoice = null;
  if (invoiceId) {
    invoice = invoiceRepository.findById(invoiceId);
    if (!invoice) throw new NF('Invoice not found');
    if (invoice.status === 'void') throw new VE('Cannot record a payment against a voided invoice');
  }
  const payment = paymentRepository.create({ organizationId, invoiceId, amount, currency, method, reference, note, recordedBy: actor.userId });
  if (invoice) {
    const totalPaid = paymentRepository.sumForInvoice(invoiceId);
    if (totalPaid >= invoice.amount) invoiceRepository.updateStatus(invoiceId, 'paid', new Date().toISOString());
  }
  auditService.record({ platformUserId: actor.userId, action: 'PAYMENT_RECORDED', newValue: String(amount), detail: `${organizationId}${invoiceId ? ' — invoice ' + invoiceId : ''}`, ip: actor.ip });
  return payment;
}

/** Credit Note (reduces outstanding) or Debit Adjustment (increases it) — one entry point, type discriminates. */
function recordAdjustment({ organizationId, invoiceId, type, amount, currency, reason }, actor) {
  if (!organizationId) throw new VE('organizationId is required');
  if (!['credit', 'debit'].includes(type)) throw new VE("type must be 'credit' or 'debit'");
  if (!(amount > 0)) throw new VE('amount must be a positive number');
  const adj = adjustmentRepository.create({ organizationId, invoiceId, type, amount, currency, reason, createdBy: actor.userId });
  auditService.record({ platformUserId: actor.userId, action: type === 'credit' ? 'CREDIT_NOTE_ISSUED' : 'DEBIT_ADJUSTMENT_ISSUED', newValue: String(amount), detail: `${organizationId} — ${reason || ''}`, ip: actor.ip });
  return adj;
}

/** Organization-scoped billing view — invoices, payments, adjustments, and current balance, for Organization 360's Billing tab. */
function getOrganizationBilling(organizationId) {
  return {
    invoices: invoiceRepository.listForOrganization(organizationId),
    payments: paymentRepository.listForOrganization(organizationId),
    adjustments: adjustmentRepository.listForOrganization(organizationId),
    balance: getBalance(organizationId),
  };
}

/** Invoice Timeline — every event touching one invoice, sorted, for a per-invoice drill-down view. */
function getInvoiceTimeline(invoiceId) {
  const invoice = invoiceRepository.findById(invoiceId);
  if (!invoice) throw new NF('Invoice not found');
  const events = [{ type: 'created', timestamp: invoice.created_at, detail: `Invoice ${invoice.invoice_number} created for ${invoice.amount} ${invoice.currency}` }];
  if (invoice.status === 'sent' || invoice.status === 'paid') events.push({ type: 'sent', timestamp: invoice.updated_at, detail: 'Invoice sent to customer' });
  for (const p of paymentRepository.listForInvoice(invoiceId)) events.push({ type: 'payment', timestamp: p.created_at, detail: `Payment of ${p.amount} ${p.currency} via ${p.method}` });
  if (invoice.status === 'paid') events.push({ type: 'paid', timestamp: invoice.paid_at, detail: 'Invoice marked fully paid' });
  if (invoice.status === 'void') events.push({ type: 'void', timestamp: invoice.updated_at, detail: 'Invoice voided' });
  return { invoice, timeline: events.filter((e) => e.timestamp).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)) };
}

/** Total outstanding across the whole ledger — same formula as getBalance(), just unfiltered by organization. */
function getTotalOutstanding() {
  const sums = invoiceRepository.sums();
  const paid = paymentRepository.totalSum();
  const credits = adjustmentRepository.totalSum('credit');
  const debits = adjustmentRepository.totalSum('debit');
  return Math.round((sums.totalInvoiced - paid - credits + debits) * 100) / 100;
}

/** Billing Dashboard — Business > Billing. */
function getDashboard() {
  const sums = invoiceRepository.sums();
  return {
    revenue: paymentRepository.totalSum(),
    outstanding: getTotalOutstanding(),
    paid: sums.paid,
    overdue: sums.overdue,
    recentPayments: paymentRepository.listRecent(10),
    recentInvoices: invoiceRepository.listRecent(10),
    monthlyRevenue: invoiceRepository.monthlyRevenue(),
  };
}

module.exports = {
  createInvoice, sendInvoice, voidInvoice, recordPayment, recordAdjustment,
  getBalance, getOrganizationBilling, getInvoiceTimeline, getDashboard, getTotalOutstanding,
  listAllInvoices: invoiceRepository.listAll,
};
