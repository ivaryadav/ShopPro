/**
 * server/src/routes/customers/index.js — REST endpoints for Customer.
 */
'use strict';

const express = require('express');
const customerController = require('../../controllers/customerController');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireActive } = require('../../middleware/requireActive');

/** @param {{jwtSecret: string}} deps @returns {import('express').Router} */
function createCustomersRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = [requireAuth(jwtSecret), requireActive];
  router.get('/', ...auth, customerController.list);
  router.get('/:id', ...auth, customerController.getOne);
  router.post('/', ...auth, customerController.create);
  router.put('/:id', ...auth, customerController.update);
  return router;
}

module.exports = { createCustomersRouter };
