require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const pool       = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (needed behind Nginx on DirectAdmin) ──
app.set('trust proxy', 1);

// ── CORS ──
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ── Body parsing ──
app.use(express.json({ limit: '10mb' })); // 10 MB for large DB blobs

// ── Rate limiting ──
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts. Try after 15 minutes.' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000,       max: 120 });

// ── Routes ──
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/data', apiLimiter,  require('./routes/data'));

// ── Serve frontend static files ──
// Place your built HTML in server/public/
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const index = path.join(__dirname, 'public', 'index.html');
  res.sendFile(index, err => {
    if (err) res.status(404).send('Not found');
  });
});

// ── Health check ──
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Start ──
async function start() {
  try {
    await pool.query('SELECT 1'); // test DB connection
    console.log('✅ PostgreSQL connected');
    app.listen(PORT, () => console.log(`🚀 ShopERP Pro server running on port ${PORT}`));
  } catch (e) {
    console.error('❌ Cannot connect to PostgreSQL:', e.message);
    process.exit(1);
  }
}

start();
