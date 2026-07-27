'use strict';

const { getDb } = require('../database/connection');

function record({ apiKeyId, method, path, statusCode, durationMs, requestId }) {
  getDb().prepare(`
    INSERT INTO platform_api_usage (api_key_id, method, path, status_code, duration_ms, request_id) VALUES (?,?,?,?,?,?)
  `).run(apiKeyId || null, method, path, statusCode || null, durationMs || null, requestId || '');
}

function summaryForKey(apiKeyId) {
  const db = getDb();
  return {
    totalRequests: db.prepare('SELECT COUNT(*) c FROM platform_api_usage WHERE api_key_id = ?').get(apiKeyId).c,
    last24h: db.prepare(`SELECT COUNT(*) c FROM platform_api_usage WHERE api_key_id = ? AND created_at >= datetime('now','-1 day')`).get(apiKeyId).c,
    errorCount: db.prepare('SELECT COUNT(*) c FROM platform_api_usage WHERE api_key_id = ? AND status_code >= 400').get(apiKeyId).c,
  };
}
function listRecent(limit) {
  return getDb().prepare('SELECT * FROM platform_api_usage ORDER BY created_at DESC, id DESC LIMIT ?').all(limit || 50);
}

module.exports = { record, summaryForKey, listRecent };
