'use strict';
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'change-me-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON user_sessions (expire);

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      material VARCHAR(255) NOT NULL,
      supplier VARCHAR(255),
      quantity VARCHAR(100) NOT NULL,
      unit VARCHAR(50),
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      order_date DATE,
      delivery_date DATE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const validUser = username === process.env.ADMIN_USERNAME;
  const validPass = validUser && await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH || '');
  if (!validUser || !validPass) {
    return res.render('login', { error: 'Invalid username or password.' });
  }
  req.session.authenticated = true;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Orders list ───────────────────────────────────────────────────────────────

app.get('/', requireAuth, async (req, res) => {
  const { status, search, sort } = req.query;
  const sortMap = { date_asc: 'delivery_date ASC NULLS LAST', date_desc: 'delivery_date DESC NULLS LAST', created: 'created_at DESC' };
  const orderBy = sortMap[sort] || 'created_at DESC';

  let where = 'WHERE 1=1';
  const params = [];
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (search) { params.push(`%${search}%`); where += ` AND (material ILIKE $${params.length} OR supplier ILIKE $${params.length} OR notes ILIKE $${params.length})`; }

  const { rows: orders } = await pool.query(`SELECT * FROM orders ${where} ORDER BY ${orderBy}`, params);
  const { rows: [{ pending, in_transit, delivered, total }] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='pending') AS pending,
      COUNT(*) FILTER (WHERE status='in_transit') AS in_transit,
      COUNT(*) FILTER (WHERE status='delivered') AS delivered,
      COUNT(*) AS total
    FROM orders
  `);
  res.render('index', { orders, stats: { pending, in_transit, delivered, total }, query: req.query });
});

// ── New order ─────────────────────────────────────────────────────────────────

app.get('/orders/new', requireAuth, (req, res) => {
  res.render('form', { order: null, error: null });
});

app.post('/orders', requireAuth, async (req, res) => {
  const { material, supplier, quantity, unit, status, order_date, delivery_date, notes } = req.body;
  if (!material || !quantity) return res.render('form', { order: req.body, error: 'Material and quantity are required.' });
  await pool.query(
    `INSERT INTO orders (material,supplier,quantity,unit,status,order_date,delivery_date,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [material, supplier||null, quantity, unit||null, status||'pending', order_date||null, delivery_date||null, notes||null]
  );
  res.redirect('/');
});

// ── Edit order ────────────────────────────────────────────────────────────────

app.get('/orders/:id/edit', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.redirect('/');
  res.render('form', { order: rows[0], error: null });
});

app.post('/orders/:id', requireAuth, async (req, res) => {
  const { material, supplier, quantity, unit, status, order_date, delivery_date, notes } = req.body;
  if (!material || !quantity) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    return res.render('form', { order: { ...rows[0], ...req.body }, error: 'Material and quantity are required.' });
  }
  await pool.query(
    `UPDATE orders SET material=$1,supplier=$2,quantity=$3,unit=$4,status=$5,order_date=$6,delivery_date=$7,notes=$8,updated_at=NOW()
     WHERE id=$9`,
    [material, supplier||null, quantity, unit||null, status, order_date||null, delivery_date||null, notes||null, req.params.id]
  );
  res.redirect('/');
});

// ── Delete order ──────────────────────────────────────────────────────────────

app.post('/orders/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
  res.redirect('/');
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
