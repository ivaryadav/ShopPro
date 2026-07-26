/**
 * platform/src/adapters/index.js — the product-adapter registry.
 *
 * Adding a real ZLAB/ZHospital/etc. integration later means: write one
 * adapter file matching shoperpAdapter.js's exported shape, add one line
 * here. No change to organizationService/licenseService/dashboardController
 * or any other core platform code — this is what "adding a new product
 * requires configuration, not architectural redesign" means in practice.
 */
'use strict';

const shoperpAdapter = require('./shoperpAdapter');

const REGISTRY = { shoperp: shoperpAdapter };

/** @param {string} slug @returns {object|null} */
function getAdapter(slug) {
  return REGISTRY[slug] || null;
}

/** @returns {Array<{slug:string, adapter:object}>} every registered, currently-configured adapter */
function listConfiguredAdapters(source) {
  return Object.entries(REGISTRY)
    .filter(([, adapter]) => adapter.isConfigured(source))
    .map(([slug, adapter]) => ({ slug, adapter }));
}

module.exports = { getAdapter, listConfiguredAdapters, REGISTRY };
