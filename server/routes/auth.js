const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db');

const router = express.Router();
const SALT_ROUNDS = 12;
const TOKEN_TTL   = '7d';

function makeToken(user, tenant) {
  return jwt.sign(
    { userId: user.id, tenantId: tenant.id, role: user.role, shopName: tenant.shop_name },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// POST /api/auth/register
// Creates a new tenant + owner user in one step
router.post('/register', async (req, res) => {
  const { shopName, username, password, email } = req.body;
  if (!shopName || !username || !password) {
    return res.status(400).json({ error: 'shopName, username, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create tenant
    const subdomain = shopName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 60);
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (shop_name, subdomain) VALUES ($1, $2)
       ON CONFLICT (subdomain) DO UPDATE SET subdomain = $2 || '-' || floor(random()*9000+1000)::text
       RETURNING *`,
      [shopName, subdomain]
    );

    // Create owner user
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows: [user] } = await client.query(
      `INSERT INTO users (tenant_id, username, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'owner') RETURNING *`,
      [tenant.id, username, email || null, hash]
    );

    // Create empty data store for this tenant
    await client.query(
      `INSERT INTO tenant_data (tenant_id, data, updated_by) VALUES ($1, $2, $3)`,
      [tenant.id, JSON.stringify({}), user.id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Shop registered successfully',
      token: makeToken(user, tenant),
      shopName: tenant.shop_name,
      username: user.username,
      role: user.role,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Username already taken for this shop' });
    }
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password, shopName } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  try {
    // Find user — if shopName provided, scope to that tenant
    let query, params;
    if (shopName) {
      query = `SELECT u.*, t.shop_name, t.id as tenant_id_val
               FROM users u JOIN tenants t ON t.id = u.tenant_id
               WHERE u.username = $1 AND t.shop_name ILIKE $2 AND u.is_active = true`;
      params = [username, shopName];
    } else {
      query = `SELECT u.*, t.shop_name, t.id as tenant_id_val
               FROM users u JOIN tenants t ON t.id = u.tenant_id
               WHERE u.username = $1 AND u.is_active = true`;
      params = [username];
    }
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    // If multiple tenants have same username, require shopName
    if (rows.length > 1 && !shopName) {
      return res.status(400).json({ error: 'Multiple shops found. Please provide shopName.' });
    }
    const row = rows[0];
    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [row.id]);

    const tenant = { id: row.tenant_id, shop_name: row.shop_name };
    const user   = { id: row.id, role: row.role };

    res.json({
      token: makeToken(user, tenant),
      shopName: row.shop_name,
      username: row.username,
      role: row.role,
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/add-staff  (owner only)
router.post('/add-staff', require('../middleware/auth').requireAuth, require('../middleware/auth').requireOwner, async (req, res) => {
  const { username, password, role = 'staff', email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (tenant_id, username, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role`,
      [req.user.tenantId, username, email || null, hash, role]
    );
    res.status(201).json({ message: 'Staff added', user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error('Add staff error:', e);
    res.status(500).json({ error: 'Failed to add staff' });
  }
});

module.exports = router;
