'use strict';

const { getDb } = require('../database/connection');

function findByEmail(email) {
  return getDb().prepare(`
    SELECT u.*, r.code AS role_code, r.label AS role_label
    FROM platform_users u JOIN platform_roles r ON r.id = u.role_id
    WHERE u.email = ?
  `).get(email);
}
function findById(id) {
  return getDb().prepare(`
    SELECT u.*, r.code AS role_code, r.label AS role_label
    FROM platform_users u JOIN platform_roles r ON r.id = u.role_id
    WHERE u.id = ?
  `).get(id);
}
function listAll() {
  return getDb().prepare(`
    SELECT u.id, u.email, u.display_name, u.is_active, u.last_login, u.created_at, r.code AS role_code, r.label AS role_label
    FROM platform_users u JOIN platform_roles r ON r.id = u.role_id
    ORDER BY u.created_at
  `).all();
}
function create({ email, displayName, passwordHash, roleId }) {
  const result = getDb().prepare(
    'INSERT INTO platform_users (email, display_name, password_hash, role_id) VALUES (?,?,?,?)'
  ).run(email, displayName || '', passwordHash, roleId);
  return findById(Number(result.lastInsertRowid));
}
function updatePassword(id, passwordHash, algo) {
  getDb().prepare('UPDATE platform_users SET password_hash = ?, algo = ? WHERE id = ?').run(passwordHash, algo || 'bcrypt', id);
}
function touchLastLogin(id) {
  getDb().prepare("UPDATE platform_users SET last_login = datetime('now') WHERE id = ?").run(id);
}
function setLockedUntil(email, lockedUntil) {
  getDb().prepare('UPDATE platform_users SET locked_until = ? WHERE email = ?').run(lockedUntil, email);
}
function clearLock(id) {
  getDb().prepare('UPDATE platform_users SET locked_until = NULL WHERE id = ?').run(id);
}

module.exports = { findByEmail, findById, listAll, create, updatePassword, touchLastLogin, setLockedUntil, clearLock };
