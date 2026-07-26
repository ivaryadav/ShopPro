'use strict';

const billingService = require('../services/billingService');

function actor(req) { return { userId: req.platformUser.userId, email: req.platformUser.email, ip: req.ip }; }

async function dashboard(req, res, next) { try { res.json(await billingService.getDashboard()); } catch (e) { next(e); } }
async function listInvoices(req, res, next) { try { res.json(billingService.listAllInvoices(req.query)); } catch (e) { next(e); } }
async function invoiceTimeline(req, res, next) { try { res.json(billingService.getInvoiceTimeline(Number(req.params.id))); } catch (e) { next(e); } }

async function createInvoice(req, res, next) { try { res.status(201).json({ invoice: billingService.createInvoice(req.body, actor(req)) }); } catch (e) { next(e); } }
async function sendInvoice(req, res, next) { try { res.json({ invoice: billingService.sendInvoice(Number(req.params.id), actor(req)) }); } catch (e) { next(e); } }
async function voidInvoice(req, res, next) { try { res.json({ invoice: billingService.voidInvoice(Number(req.params.id), actor(req)) }); } catch (e) { next(e); } }
async function recordPayment(req, res, next) { try { res.status(201).json({ payment: billingService.recordPayment(req.body, actor(req)) }); } catch (e) { next(e); } }
async function recordAdjustment(req, res, next) { try { res.status(201).json({ adjustment: billingService.recordAdjustment(req.body, actor(req)) }); } catch (e) { next(e); } }

module.exports = { dashboard, listInvoices, invoiceTimeline, createInvoice, sendInvoice, voidInvoice, recordPayment, recordAdjustment };
