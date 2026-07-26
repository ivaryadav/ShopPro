'use strict';

const { getDb } = require('../database/connection');

function listForOrganization(organizationId) {
  return getDb().prepare(
    'SELECT * FROM organization_notes WHERE organization_id = ? ORDER BY created_at DESC'
  ).all(String(organizationId));
}
function create(organizationId, authorEmail, note) {
  const result = getDb().prepare(
    'INSERT INTO organization_notes (organization_id, author_email, note) VALUES (?,?,?)'
  ).run(String(organizationId), authorEmail, note);
  return getDb().prepare('SELECT * FROM organization_notes WHERE id = ?').get(Number(result.lastInsertRowid));
}

module.exports = { listForOrganization, create };
