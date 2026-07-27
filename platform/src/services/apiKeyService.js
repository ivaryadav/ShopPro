/**
 * platform/src/services/apiKeyService.js — Platform API Keys (Phase 5B),
 * future-ready for external/automation integrations against Z-SUPERADMIN's
 * own API. A key is shown in full exactly once, at creation or rotation;
 * only its SHA-256 hash and a short, non-secret prefix are ever stored.
 */
'use strict';

const crypto = require('crypto');
const apiKeyRepository = require('../repositories/platformApiKeyRepository');
const auditService = require('./auditService');
const eventBusService = require('./eventBusService');
const { ValidationError, NotFoundError } = require('../errors');

const KEY_PREFIX = 'zsa_live_';

function generateRawKey() {
  const raw = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  return raw;
}
function hashKey(rawKey) { return crypto.createHash('sha256').update(rawKey).digest('hex'); }

function create({ name, permissions, expiresInDays }, actor) {
  if (!name || !String(name).trim()) throw new ValidationError('name is required');
  const rawKey = generateRawKey();
  const created = apiKeyRepository.create({
    name: String(name).trim(), keyHash: hashKey(rawKey), keyPrefix: rawKey.slice(0, 14),
    permissions: permissions || [], createdBy: actor.userId, expiresInDays: expiresInDays || null,
  });
  auditService.record({ platformUserId: actor.userId, action: 'API_KEY_CREATED', detail: created.name, ip: actor.ip });
  eventBusService.publish({ eventType: 'api_key.created', organizationId: null, payload: { apiKeyId: created.id, name: created.name } });
  return { key: mapKey(created), rawKey };
}
function list() { return apiKeyRepository.listAll().map(mapKey); }
function rotate(id, actor) {
  const existing = apiKeyRepository.findById(Number(id));
  if (!existing || existing.revoked_at) throw new NotFoundError('API key not found');
  const rawKey = generateRawKey();
  const updated = apiKeyRepository.rotate(existing.id, hashKey(rawKey), rawKey.slice(0, 14));
  auditService.record({ platformUserId: actor.userId, action: 'API_KEY_ROTATED', detail: updated.name, ip: actor.ip });
  return { key: mapKey(updated), rawKey };
}
function revoke(id, actor) {
  const existing = apiKeyRepository.findById(Number(id));
  if (!existing) throw new NotFoundError('API key not found');
  const ok = apiKeyRepository.revoke(existing.id);
  if (ok) auditService.record({ platformUserId: actor.userId, action: 'API_KEY_REVOKED', detail: existing.name, ip: actor.ip });
  return { ok };
}
/** Used by requirePlatformAuthOrApiKey — resolves a raw key header value to its row, or null if invalid/expired/revoked (revoked/expired check happens entirely in SQL — see findValidByHash). */
function authenticate(rawKey) {
  const row = apiKeyRepository.findValidByHash(hashKey(rawKey));
  if (!row) return null;
  apiKeyRepository.touchUsage(row.id);
  return row;
}
function mapKey(k) {
  return {
    id: k.id, name: k.name, keyPrefix: k.key_prefix, permissions: JSON.parse(k.permissions || '[]'),
    createdByEmail: k.created_by_email, lastUsedAt: k.last_used_at, usageCount: k.usage_count,
    expiresAt: k.expires_at, revokedAt: k.revoked_at, createdAt: k.created_at,
  };
}

module.exports = { create, list, rotate, revoke, authenticate };
