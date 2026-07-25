const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, tenantId, role, shopName }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token expired or invalid. Please log in again.' });
  }
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

module.exports = { requireAuth, requireOwner };
