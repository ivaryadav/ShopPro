/**
 * server/src/routes/sales/index.js — REST endpoints for Sale/SaleItem.
 */
'use strict';

const express = require('express');
const saleController = require('../../controllers/saleController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createSalesRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive];
  router.get('/', ...auth, saleController.list);
  router.get('/next-invoice-no', ...auth, saleController.nextInvoiceNo);
  router.get('/:id', ...auth, saleController.getOne);
  router.post('/', ...auth, saleController.create);
  router.put('/:id', ...auth, saleController.update);
  return router;
}

module.exports = { createSalesRouter };
