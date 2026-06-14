const express = require('express');
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/data  — load the entire DB blob for this tenant
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT data, updated_at FROM tenant_data WHERE tenant_id = $1',
      [req.user.tenantId]
    );
    if (rows.length === 0) {
      return res.json({ data: {}, updatedAt: null });
    }
    res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error('Load data error:', e);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// PUT /api/data  — save entire DB blob for this tenant
router.put('/', requireAuth, async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data must be a JSON object' });
  }
  try {
    await pool.query(
      `INSERT INTO tenant_data (tenant_id, data, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (tenant_id) DO UPDATE
       SET data = $2, updated_at = NOW(), updated_by = $3`,
      [req.user.tenantId, JSON.stringify(data), req.user.userId]
    );

    // Write audit log (fire and forget)
    pool.query(
      `INSERT INTO audit_log (tenant_id, user_id, action) VALUES ($1, $2, 'data_save')`,
      [req.user.tenantId, req.user.userId]
    ).catch(() => {});

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Save data error:', e);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// GET /api/data/users  — list staff for this tenant (owner only)
router.get('/users', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, role, is_active, last_login, created_at
       FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [req.user.tenantId]
    );
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;
