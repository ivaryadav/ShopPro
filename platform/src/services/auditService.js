/**
 * platform/src/services/auditService.js — the ONE place every platform
 * action is logged. Every service below calls this; nothing writes to
 * platform_audit_logs directly.
 */
'use strict';

const auditLogRepository = require('../repositories/platformAuditLogRepository');

function record({ platformUserId, organizationId, productId, action, oldValue, newValue, detail, ip, device }) {
  auditLogRepository.create({
    platformUserId: platformUserId || null, organizationId: organizationId || null, productId: productId || null,
    action, oldValue: oldValue !== undefined ? String(oldValue) : null, newValue: newValue !== undefined ? String(newValue) : null,
    detail: detail || '', ip: ip || '', device: device || '',
  });
}

module.exports = { record };
