'use strict';

const businessService = require('../services/businessService');
const reportService = require('../services/reportService');

async function dashboard(req, res, next) { try { res.json(await businessService.getDashboard()); } catch (e) { next(e); } }
async function renewalCenter(req, res, next) { try { res.json(await businessService.getRenewalCenter()); } catch (e) { next(e); } }
async function reports(req, res, next) { try { res.json(await reportService.getBusinessReports()); } catch (e) { next(e); } }

module.exports = { dashboard, renewalCenter, reports };
