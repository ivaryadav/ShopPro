'use strict';

const customerService = require('../services/customerService');

async function search(req, res, next) {
  try { res.json({ results: await customerService.search(req.query) }); } catch (e) { next(e); }
}

module.exports = { search };
