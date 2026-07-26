'use strict';

const { getDb } = require('../database/connection');

function get() { return getDb().prepare('SELECT * FROM platform_settings WHERE id = 1').get(); }
function update({ platformName, supportEmail, supportPhone }) {
  const sets = [];
  const params = [];
  if (platformName !== undefined) { sets.push('platform_name = ?'); params.push(platformName); }
  if (supportEmail !== undefined) { sets.push('support_email = ?'); params.push(supportEmail); }
  if (supportPhone !== undefined) { sets.push('support_phone = ?'); params.push(supportPhone); }
  if (!sets.length) return get();
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE platform_settings SET ${sets.join(', ')} WHERE id = 1`).run(...params);
  return get();
}

module.exports = { get, update };
