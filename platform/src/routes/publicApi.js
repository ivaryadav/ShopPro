/**
 * platform/src/routes/publicApi.js — Phase 5F: Public API Foundation.
 * A versioned (/api/public/v1) namespace future external integrations
 * will plug into — deliberately minimal today (a health check and a
 * documentation-metadata endpoint), authenticated via the SAME Platform
 * API Keys mechanism as everything else (requirePlatformAuthOrApiKey,
 * unchanged) rather than a new auth system. Every request through this
 * router is logged to platform_api_usage for the API Usage Metrics
 * requirement.
 */
'use strict';

const express = require('express');
const { requirePlatformAuthOrApiKey } = require('../middleware/requirePlatformAuthOrApiKey');
const apiUsageRepository = require('../repositories/platformApiUsageRepository');
const { getDb } = require('../database/connection');

const API_VERSION = 'v1';
const KNOWN_EVENT_TYPES = [
  'organization.created', 'organization.updated', 'license.issued', 'license.renewed', 'license.expired',
  'maintenance.started', 'maintenance.ended', 'invoice.created', 'invoice.paid', 'subscription.changed',
  'user.locked', 'mfa.enabled', 'api_key.created',
];

function trackUsage(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    try {
      apiUsageRepository.record({
        apiKeyId: req.platformUser && req.platformUser.apiKeyId, method: req.method, path: req.baseUrl + req.path,
        statusCode: res.statusCode, durationMs: Date.now() - startedAt, requestId: req.correlationId,
      });
    } catch (e) { /* usage logging must never affect the actual response */ }
  });
  next();
}

function createPublicApiRouter({ jwtSecret }) {
  const router = express.Router();
  const auth = requirePlatformAuthOrApiKey(jwtSecret);
  router.use(auth, trackUsage);

  router.get('/meta', (req, res) => {
    res.json({
      apiVersion: API_VERSION,
      requestId: req.correlationId,
      endpoints: [
        { method: 'GET', path: '/api/public/v1/meta', description: 'API documentation metadata' },
        { method: 'GET', path: '/api/public/v1/health', description: 'Platform liveness + database connectivity' },
      ],
      eventTypes: KNOWN_EVENT_TYPES,
    });
  });

  router.get('/health', (req, res) => {
    try {
      getDb().prepare('SELECT 1').get();
      res.json({ status: 'ok', apiVersion: API_VERSION, requestId: req.correlationId });
    } catch (e) {
      res.status(503).json({ status: 'degraded', apiVersion: API_VERSION, requestId: req.correlationId, error: { code: 'DATABASE_ERROR', message: e.message } });
    }
  });

  return router;
}

module.exports = { createPublicApiRouter, KNOWN_EVENT_TYPES };
