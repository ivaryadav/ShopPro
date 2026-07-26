'use strict';

const reportService = require('../services/reportService');

async function trends(req, res, next) { try { res.json(await reportService.getTrends()); } catch (e) { next(e); } }

module.exports = { trends };
