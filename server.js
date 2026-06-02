'use strict';
require('dns').setDefaultResultOrder('ipv4first'); // Railway containers don't route IPv6
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
});

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Static data ───────────────────────────────────────────────────────────────

const STAGES = [
  {
    key: 'framing',
    name: 'Framing Stage',
    items: [
      { code: '1a', name: 'Doors, Windows' },
      { code: '1b', name: 'R. Plumb, Fans' },
      { code: '1c', name: 'HVAC Trim' },
      { code: '1d', name: 'Tile' },
      { code: '1e', name: 'Rec. Light' },
    ],
  },
  {
    key: 'warehouse',
    name: 'Warehouse Outbound',
    items: [
      { code: '2a', name: 'Millwork' },
      { code: '2b', name: 'Flooring' },
      { code: '2c', name: 'Decking' },
      { code: '2d', name: 'Appliances' },
      { code: '2e', name: 'Water Heater' },
    ],
  },
  {
    key: 'oneweek',
    name: '1 Week after Warehouse Outbound',
    items: [
      { code: '3a', name: 'Countertops' },
      { code: '3b', name: 'Fs. Plumb/Light/Hood' },
      { code: '3c', name: 'Hardware' },
      { code: '3d', name: 'Misc' },
      { code: '3e', name: 'Shower Doors' },
    ],
  },
];

const ALL_ITEMS = STAGES.flatMap(s => s.items);

// Keyword aliases for detecting materials mentioned in free-text email replies
const MATERIAL_ALIASES = {
  '1a': ['door', 'window'],
  '1b': ['rough plumb', 'rough-plumb', 'r. plumb', 'fans', 'fan'],
  '1c': ['hvac', 'hvac trim'],
  '1d': ['tile'],
  '1e': ['rec light', 'rec. light', 'recessed light', 'recessed lighting', 'can light'],
  '2a': ['millwork'],
  '2b': ['floor', 'flooring'],
  '2c': ['deck', 'decking'],
  '2d': ['appliance'],
  '2e': ['water heater'],
  '3a': ['countertop', 'counter top', 'counters'],
  '3b': ['finish plumb', 'finished plumb', 'finish plumbing', 'light fixture', 'hood'],
  '3c': ['hardware'],
  '3d': ['misc'],
  '3e': ['shower door', 'shower glass'],
};

function detectMaterials(text) {
  const lc = String(text || '').toLowerCase();
  const found = [];
  for (const item of ALL_ITEMS) {
    const aliases = MATERIAL_ALIASES[item.code] || [item.name.toLowerCase()];
    if (aliases.some(a => lc.includes(a))) found.push({ code: item.code, name: item.name });
  }
  return found;
}

const ITEM_STATUSES = [
  'Not yet placed',
  'RFQ sent',
  'Order Placed',
  'In Inventory',
  'Delivered',
  'Delivered from Inv.',
  'N/A',
  'Issue',
];

const PROJECT_STATUSES = ['Not Yet', 'In Progress', 'All Delivered', 'Draft - Contract', 'Fully Delivered'];

// ── Email (Resend) ──────────────────────────────────────────────────────────

const { Resend } = require('resend');
const { google } = require('googleapis');

// Prefer the Gmail API (HTTPS — works on Railway, which blocks SMTP) so mail
// sends from the user's real address. Falls back to Resend if not configured.
const gmailUser = process.env.GMAIL_USER;
const gClientId = process.env.GMAIL_CLIENT_ID;
const gClientSecret = process.env.GMAIL_CLIENT_SECRET;
const gRefreshToken = process.env.GMAIL_REFRESH_TOKEN;
const useGmail = !!(gmailUser && gClientId && gClientSecret && gRefreshToken);

let gmailClient = null;
if (useGmail) {
  const oauth2 = new google.auth.OAuth2(gClientId, gClientSecret);
  oauth2.setCredentials({ refresh_token: gRefreshToken });
  gmailClient = google.gmail({ version: 'v1', auth: oauth2 });
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = useGmail ? gmailUser : (process.env.FROM_EMAIL || 'onboarding@resend.dev');
const emailEnabled = useGmail || !!resend;

function buildRawMessage({ from, to, cc, subject, text, html, attachments, inReplyTo, references }) {
  attachments = attachments || [];
  const bodyType = html ? 'text/html' : 'text/plain';
  const bodyContent = html || text;
  const threadHeaders = [];
  if (cc) threadHeaders.push(`Cc: ${cc}`);
  if (inReplyTo) threadHeaders.push(`In-Reply-To: ${inReplyTo}`);
  if (references) threadHeaders.push(`References: ${references}`);
  let msg;
  if (attachments.length === 0) {
    msg = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      ...threadHeaders,
      'MIME-Version: 1.0',
      `Content-Type: ${bodyType}; charset=UTF-8`,
      '',
      bodyContent,
    ].join('\r\n');
  } else {
    const boundary = 'mo_boundary_' + Date.now();
    const parts = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      ...threadHeaders,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: ${bodyType}; charset=UTF-8`,
      '',
      bodyContent,
      '',
    ];
    for (const att of attachments) {
      const fileB64 = att.content.toString('base64').replace(/(.{76})/g, '$1\r\n');
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        fileB64,
        ''
      );
    }
    parts.push(`--${boundary}--`);
    msg = parts.join('\r\n');
  }
  return Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Fetch the user's Gmail signature (cached ~1h). API sends don't auto-add it.
let _sigCache = { html: null, at: 0 };
async function getSignature() {
  if (!useGmail) return '';
  const now = Date.now();
  if (_sigCache.html !== null && now - _sigCache.at < 3600000) return _sigCache.html;
  try {
    const r = await gmailClient.users.settings.sendAs.list({ userId: 'me' });
    const sendAs = r.data.sendAs || [];
    const mine = sendAs.find(s => s.sendAsEmail === gmailUser) || sendAs.find(s => s.isDefault);
    _sigCache = { html: (mine && mine.signature) || '', at: now };
  } catch (e) {
    _sigCache = { html: '', at: now };
  }
  return _sigCache.html;
}

async function getDefaultAttachment() {
  try {
    const { rows: [r] } = await pool.query('SELECT attachment_name, attachment_mime, attachment_data FROM app_settings WHERE id=1');
    if (!r || !r.attachment_data) return null;
    return { filename: r.attachment_name, mimeType: r.attachment_mime, content: r.attachment_data };
  } catch (e) {
    return null;
  }
}

// Status progression — only ever move forward
const STATUS_RANK = {
  'Not yet placed': 0, 'RFQ sent': 1, 'Order Placed': 2,
  'In Inventory': 3, 'Delivered from Inv.': 4, 'Delivered': 5,
};
const TYPE_TARGET = { quote: 'RFQ sent', order: 'Order Placed' }; // delivery → no change

// When a vendor email is sent, advance all that vendor's materials on the project
async function advanceVendorItems(projectId, clickedCode, emailType) {
  const target = TYPE_TARGET[emailType];
  if (!target) return [];
  const targetRank = STATUS_RANK[target];

  // Find the clicked material's supplier, then all materials sharing it
  const { rows: [sup] } = await pool.query('SELECT supplier_email, supplier_name FROM suppliers WHERE item_code=$1', [clickedCode]);
  let codes = [clickedCode];
  if (sup && (sup.supplier_email || sup.supplier_name)) {
    const { rows } = await pool.query(
      `SELECT item_code FROM suppliers WHERE (supplier_email IS NOT NULL AND supplier_email=$1) OR (supplier_name IS NOT NULL AND supplier_name=$2)`,
      [sup.supplier_email, sup.supplier_name]
    );
    if (rows.length) codes = rows.map(r => r.item_code);
  }

  // Load current statuses; advance only items that are behind (skip N/A / Issue)
  const { rows: current } = await pool.query(
    'SELECT item_code, status FROM project_items WHERE project_id=$1 AND item_code = ANY($2)', [projectId, codes]
  );
  const curMap = {};
  current.forEach(r => curMap[r.item_code] = r.status);

  const updated = [];
  for (const code of codes) {
    const cur = curMap[code] || 'Not yet placed';
    if (cur === 'N/A' || cur === 'Issue') continue;
    if ((STATUS_RANK[cur] ?? 0) >= targetRank) continue;
    await pool.query(
      `INSERT INTO project_items (project_id, item_code, status) VALUES ($1,$2,$3)
       ON CONFLICT (project_id, item_code) DO UPDATE SET status=$3`,
      [projectId, code, target]
    );
    updated.push({ code, status: target });
  }
  return updated;
}

// Move a specific list of materials forward to a target status (never backward)
async function bumpItemsForward(projectId, codes, target) {
  const targetRank = STATUS_RANK[target];
  if (targetRank == null || !codes.length) return;
  const { rows: current } = await pool.query(
    'SELECT item_code, status FROM project_items WHERE project_id=$1 AND item_code = ANY($2)', [projectId, codes]
  );
  const cur = {};
  current.forEach(r => cur[r.item_code] = r.status);
  for (const code of codes) {
    const c = cur[code] || 'Not yet placed';
    if (c === 'N/A' || c === 'Issue') continue;
    if ((STATUS_RANK[c] ?? 0) >= targetRank) continue;
    await pool.query(
      `INSERT INTO project_items (project_id, item_code, status) VALUES ($1,$2,$3)
       ON CONFLICT (project_id, item_code) DO UPDATE SET status=$3`,
      [projectId, code, target]
    );
  }
}

// ── Driving distance via OpenRouteService ─────────────────────────────────────
const ORS_KEY = process.env.ORS_API_KEY;
const drivingEnabled = !!ORS_KEY;
const _geocodeCache = {};

async function geocodeAddress(text) {
  if (_geocodeCache[text]) return _geocodeCache[text];
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_KEY}&text=${encodeURIComponent(text)}&boundary.country=US&size=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Geocoding failed for: ' + text);
  const data = await r.json();
  if (!data.features || !data.features.length) throw new Error('Address not found: ' + text);
  const coords = data.features[0].geometry.coordinates; // [lon, lat]
  _geocodeCache[text] = coords;
  return coords;
}

// Total driving miles for an ordered list of addresses (a full route)
async function routeMiles(addresses) {
  const coords = [];
  for (const a of addresses) coords.push(await geocodeAddress(a));
  const r = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
    method: 'POST',
    headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: coords }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Routing failed: ' + t.slice(0, 200));
  }
  const data = await r.json();
  const meters = data.routes[0].summary.distance;
  return Math.round((meters / 1609.344) * 10) / 10; // miles, 1 decimal
}

async function getHomeAddress() {
  const { rows: [r] } = await pool.query('SELECT home_address FROM app_settings WHERE id=1');
  return r ? r.home_address : null;
}

async function getSuppliers() {
  try {
    const { rows } = await pool.query('SELECT item_code, supplier_name, supplier_email FROM suppliers');
    const map = {};
    rows.forEach(r => map[r.item_code] = { name: r.supplier_name, email: r.supplier_email });
    return map;
  } catch (e) {
    return {};
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "2026-03-20" → "Friday (3/20)"
function formatOutboundDate(d) {
  const parts = String(d).split('-').map(Number);
  if (parts.length !== 3) return d;
  const [y, m, day] = parts;
  const dt = new Date(y, m - 1, day);
  const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dt.getDay()];
  return `${weekday} (${m}/${day})`;
}

// Clean a pasted HTML table (from Google Sheets) down to a simple styled table
function sanitizePastedHtml(html) {
  if (!html) return '';
  const m = html.match(/<table[\s\S]*<\/table>/i);
  let t = m ? m[0] : html;
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  // strip attributes from allowed structural tags
  t = t.replace(/<(\/?)(table|thead|tbody|tr|td|th|b|strong|i|em|br|p|span|div)\b[^>]*>/gi, (mm, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
  // remove any tags that aren't in the allow-list (keep inner text)
  t = t.replace(/<(?!\/?(?:table|thead|tbody|tr|td|th|b|strong|i|em|br|p|span|div)\b)[^>]*>/gi, '');
  // apply clean styling
  t = t.replace(/<table>/gi, '<table style="border-collapse:collapse;margin:12px 0">');
  t = t.replace(/<td>/gi, '<td style="border:1px solid #ccc;padding:6px 10px;font-size:14px">');
  t = t.replace(/<th>/gi, '<th style="border:1px solid #ccc;padding:6px 10px;font-size:14px;text-align:left">');
  return t;
}

// Turn pasted Google-Sheet cells (tab-separated rows) into an HTML table
function pastedDataToTable(text) {
  const rows = String(text || '').trim().split(/\r?\n/).filter(r => r.length).map(r => r.split('\t'));
  if (!rows.length) return '';
  const renderRow = (cells, tag) =>
    '<tr>' + cells.map(c => `<${tag} style="border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:14px">${escapeHtml(c)}</${tag}>`).join('') + '</tr>';
  const header = renderRow(rows[0], 'th');
  const bodyRows = rows.slice(1).map(r => renderRow(r, 'td')).join('');
  return `<table style="border-collapse:collapse;margin:12px 0">${header}${bodyRows}</table>`;
}

// Decode a Gmail base64url message part to text
function decodePart(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Pull the best-effort readable body out of a Gmail message payload
function extractBody(payload) {
  let plain = null, htmlBody = null;
  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data && !plain) plain = decodePart(part.body.data);
    else if (part.mimeType === 'text/html' && part.body && part.body.data && !htmlBody) htmlBody = decodePart(part.body.data);
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  if (plain) return { text: plain, isHtml: false };
  if (htmlBody) return { text: htmlBody, isHtml: true };
  return { text: '', isHtml: false };
}

function headerVal(headers, name) {
  const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// List file attachments (filename + Gmail attachmentId) in a message payload
function extractAttachments(payload) {
  const out = [];
  function walk(part) {
    if (!part) return;
    if (part.filename && part.body && part.body.attachmentId) {
      out.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

// Fetch and parse a Gmail thread into a list of messages
async function fetchThread(threadId) {
  const { data } = await gmailClient.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = (data.messages || []).map(m => {
    const headers = m.payload.headers;
    const body = extractBody(m.payload);
    return {
      id: m.id,
      from: headerVal(headers, 'From'),
      to: headerVal(headers, 'To'),
      date: headerVal(headers, 'Date'),
      subject: headerVal(headers, 'Subject'),
      messageIdHeader: headerVal(headers, 'Message-ID'),
      references: headerVal(headers, 'References'),
      snippet: m.snippet,
      body: body.text,
      isHtml: body.isHtml,
      attachments: extractAttachments(m.payload),
      fromMe: headerVal(headers, 'From').includes(gmailUser),
    };
  });
  return messages;
}

// Accepts one address or several separated by comma/semicolon → array of clean addresses
function parseRecipients(to) {
  return String(to || '').split(/[,;]+/).map(s => s.trim()).filter(Boolean);
}

async function sendMail({ to, cc, subject, text, html, attachments, threadId, inReplyTo, references }) {
  const recipients = parseRecipients(to);
  const ccList = parseRecipients(cc);
  if (useGmail) {
    const raw = buildRawMessage({ from: gmailUser, to: recipients.join(', '), cc: ccList.join(', ') || undefined, subject, text, html, attachments, inReplyTo, references });
    const requestBody = { raw };
    if (threadId) requestBody.threadId = threadId;
    const { data } = await gmailClient.users.messages.send({ userId: 'me', requestBody });
    return { threadId: data.threadId, messageId: data.id };
  }
  const payload = { from: FROM_EMAIL, to: recipients, subject };
  if (ccList.length) payload.cc = ccList;
  if (html) payload.html = html; else payload.text = text;
  if (attachments && attachments.length) payload.attachments = attachments.map(a => ({ filename: a.filename, content: a.content }));
  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message || 'Send failed.');
  return { threadId: null, messageId: data && data.id };
}

// Construction milestone payment-request email templates
const EMAIL_PHASES = [
  { key: 'foundation', label: 'Foundation', phaseName: 'Foundation',
    signoff: 'the Inspector has Signed off on the Foundation!' },
  { key: 'framing', label: 'Framing', phaseName: 'Framing',
    signoff: 'the Inspector has Signed off on the Framing!' },
  { key: 'rough', label: 'Rough Plumb & Elec', phaseName: 'Rough Plumbing and Electrical',
    signoff: 'the Inspector has Signed off on the Rough Plumbing and Electrical!' },
  { key: 'drywall', label: 'Drywall & Finishes', phaseName: 'Drywall and Finishes',
    signoff: 'the Inspector has Signed off on the Drywall and Finishes!' },
  { key: 'final', label: 'Final', phaseName: 'After Final Walkthrough and Inspection',
    signoff: 'the Inspector has Signed off on the Final Inspection and the project scope has been completed!' },
];

function buildEmail({ clientName, amount, phase, melioLink }) {
  const subject = `Milestone Payment Request — ${phase.phaseName}`;
  const body =
`HI ${clientName || 'there'},

At this time I'm writing to inform you that ${phase.signoff}

At this stage, I am requesting the milestone payment of $${amount} for the "${phase.phaseName}" phase. The Payment Link Will be sent to you shortly via Email—please arrange payment at your earliest convenience.

Please let me know if you have any questions.

We now offer Melio as a payment method which should allow you to pay by logging into your bank instead of having to enter account numbers.

You can use any of the following payment methods:
1. Melio (Bank ACH – no fees): Pay directly by logging in to your bank account through Melio.
2. Melio (Credit Card – 2.9% fee): Credit card payment option via Melio.
3. Wire or ACH (no fees): Use the attached bank details to send a direct transfer, manually from your bank.

Melio link: ${melioLink || ''}`;
  return { subject, body };
}

// ── DB init ───────────────────────────────────────────────────────────────────

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      address VARCHAR(255) NOT NULL,
      version VARCHAR(50),
      overall_status VARCHAR(50) DEFAULT 'Not Yet',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_email VARCHAR(255);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS full_address VARCHAR(500);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS sort_order INTEGER;

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      attachment_name VARCHAR(255),
      attachment_mime VARCHAR(255),
      attachment_data BYTEA,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    );

    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS home_address VARCHAR(500);

    CREATE TABLE IF NOT EXISTS driving_trips (
      id SERIAL PRIMARY KEY,
      trip_date DATE NOT NULL,
      route_text TEXT,
      miles NUMERIC(8,1),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS milestone_payments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      phase_key VARCHAR(50),
      phase_name VARCHAR(255),
      amount NUMERIC(12,2),
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      paid BOOLEAN DEFAULT FALSE,
      paid_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS project_documents (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      filename VARCHAR(255) NOT NULL,
      mime VARCHAR(255),
      data BYTEA,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;
    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;
    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS has_unread BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS suppliers (
      item_code VARCHAR(10) PRIMARY KEY,
      supplier_name VARCHAR(255),
      supplier_email VARCHAR(255)
    );

    CREATE TABLE IF NOT EXISTS vendor_emails (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      item_code VARCHAR(10),
      supplier_name VARCHAR(255),
      supplier_email TEXT,
      subject VARCHAR(500),
      email_type VARCHAR(50),
      gmail_thread_id VARCHAR(255),
      gmail_message_id VARCHAR(255),
      sent_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_items (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      item_code VARCHAR(10) NOT NULL,
      status VARCHAR(50) DEFAULT 'Not yet placed',
      delivery_date DATE,
      notes TEXT,
      UNIQUE(project_id, item_code)
    );

    CREATE TABLE IF NOT EXISTS vendor_orders (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      supplier_name VARCHAR(255),
      supplier_email TEXT,
      amount NUMERIC(12,2),
      gmail_thread_id VARCHAR(255),
      gmail_message_id VARCHAR(255),
      receipt_name VARCHAR(255),
      receipt_mime VARCHAR(255),
      receipt_data BYTEA,
      confirmed_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vendor_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES vendor_orders(id) ON DELETE CASCADE,
      item_code VARCHAR(10)
    );
  `);
}

// Auto-create all 13 item rows for a project
async function ensureProjectItems(projectId) {
  for (const item of ALL_ITEMS) {
    await pool.query(
      `INSERT INTO project_items (project_id, item_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [projectId, item.code]
    );
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const validUser = username === process.env.ADMIN_USERNAME;
  const validPass = validUser && await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH || '');
  if (!validUser || !validPass) return res.render('login', { error: 'Invalid username or password.' });
  req.session.authenticated = true;
  res.redirect('/');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ── Projects list ─────────────────────────────────────────────────────────────

app.get('/', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { status, search } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { params.push(status); where += ` AND overall_status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND address ILIKE $${params.length}`; }

    const { rows: projects } = await pool.query(
      `SELECT * FROM projects ${where} ORDER BY sort_order ASC NULLS LAST, created_at ASC`, params
    );
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE overall_status='In Progress') AS in_progress,
        COUNT(*) FILTER (WHERE overall_status='All Delivered' OR overall_status='Fully Delivered') AS delivered,
        COUNT(*) FILTER (WHERE overall_status='Not Yet') AS not_yet,
        COUNT(*) AS total
      FROM projects
    `);
    const projectIds = projects.map(p => p.id);
    let itemMaps = {};
    if (projectIds.length) {
      const { rows: allItems } = await pool.query(
        `SELECT * FROM project_items WHERE project_id = ANY($1)`, [projectIds]
      );
      allItems.forEach(item => {
        if (!itemMaps[item.project_id]) itemMaps[item.project_id] = {};
        itemMaps[item.project_id][item.item_code] = item;
      });
    }
    const { rows: unreadRows } = await pool.query('SELECT DISTINCT project_id FROM vendor_emails WHERE has_unread=true');
    const unread = {};
    unreadRows.forEach(r => unread[r.project_id] = true);
    res.render('index', { projects, stats, itemMaps, query: req.query, PROJECT_STATUSES, ITEM_STATUSES, unread });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

// ── New project ───────────────────────────────────────────────────────────────

app.get('/projects/new', requireAuth, (req, res) => {
  res.render('project-form', { project: null, error: null, PROJECT_STATUSES });
});

app.post('/projects', requireAuth, async (req, res) => {
  const { address, version, overall_status, notes, client_name, client_email, full_address } = req.body;
  if (!address) return res.render('project-form', { project: req.body, error: 'Address is required.', PROJECT_STATUSES });
  const { rows: [p] } = await pool.query(
    `INSERT INTO projects (address, version, overall_status, notes, client_name, client_email, full_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [address, version||null, overall_status||'Not Yet', notes||null, client_name||null, client_email||null, full_address||null]
  );
  await ensureProjectItems(p.id);
  res.redirect(`/projects/${p.id}`);
});

// ── Project detail ────────────────────────────────────────────────────────────

app.get('/projects/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.redirect('/');
    await ensureProjectItems(project.id);
    const { rows: items } = await pool.query('SELECT * FROM project_items WHERE project_id=$1', [project.id]);
    const itemMap = {};
    items.forEach(i => itemMap[i.item_code] = i);
    const suppliers = await getSuppliers();
    const { rows: documents } = await pool.query('SELECT id, filename, uploaded_at FROM project_documents WHERE project_id=$1 ORDER BY uploaded_at DESC', [project.id]);
    const { rows: payments } = await pool.query('SELECT * FROM milestone_payments WHERE project_id=$1 ORDER BY requested_at DESC', [project.id]);

    // Confirmed vendor orders, grouped by vendor
    const { rows: orderRows } = await pool.query(`
      SELECT vo.id, vo.supplier_name, vo.supplier_email, vo.amount, vo.gmail_thread_id, vo.confirmed_at,
             (vo.receipt_data IS NOT NULL) AS has_receipt,
             COALESCE(array_agg(voi.item_code ORDER BY voi.item_code) FILTER (WHERE voi.item_code IS NOT NULL), '{}') AS item_codes
      FROM vendor_orders vo
      LEFT JOIN vendor_order_items voi ON voi.order_id = vo.id
      WHERE vo.project_id=$1
      GROUP BY vo.id
      ORDER BY vo.supplier_name NULLS LAST, vo.confirmed_at DESC`, [project.id]);
    const itemNames = {};
    ALL_ITEMS.forEach(i => itemNames[i.code] = i.name);
    const ordersByVendor = [];
    const vmap = {};
    for (const o of orderRows) {
      const key = (o.supplier_name || '') + '|' + (o.supplier_email || '');
      if (!vmap[key]) { vmap[key] = { name: o.supplier_name, email: o.supplier_email, orders: [] }; ordersByVendor.push(vmap[key]); }
      vmap[key].orders.push(o);
    }

    res.render('project', { project, STAGES, itemMap, ITEM_STATUSES, PROJECT_STATUSES, EMAIL_PHASES, emailConfigured: emailEnabled, suppliers, documents, payments, ordersByVendor, itemNames });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Edit project info ─────────────────────────────────────────────────────────

app.get('/projects/:id/edit', requireAuth, async (req, res) => {
  const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.redirect('/');
  res.render('project-form', { project, error: null, PROJECT_STATUSES });
});

app.post('/projects/:id', requireAuth, async (req, res) => {
  const { address, version, overall_status, notes, client_name, client_email, full_address } = req.body;
  await pool.query(
    `UPDATE projects SET address=$1, version=$2, overall_status=$3, notes=$4, client_name=$5, client_email=$6, full_address=$7, updated_at=NOW() WHERE id=$8`,
    [address, version||null, overall_status, notes||null, client_name||null, client_email||null, full_address||null, req.params.id]
  );
  res.redirect(`/projects/${req.params.id}`);
});

// ── Reorder projects (drag and drop) ──────────────────────────────────────────

app.post('/reorder-projects', requireAuth, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: 'Bad order.' });
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE projects SET sort_order=$1 WHERE id=$2', [i, Number(order[i])]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Update overall project status (AJAX) ──────────────────────────────────────

app.post('/projects/:id/status', requireAuth, async (req, res) => {
  try {
    const { overall_status } = req.body;
    if (!PROJECT_STATUSES.includes(overall_status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status.' });
    }
    await pool.query(
      `UPDATE projects SET overall_status=$1, updated_at=NOW() WHERE id=$2`,
      [overall_status, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Update single item status (AJAX) ──────────────────────────────────────────

app.post('/projects/:id/items/:code', requireAuth, async (req, res) => {
  const { status, delivery_date, notes, statusOnly } = req.body;
  // Ensure the row exists first
  await pool.query(
    `INSERT INTO project_items (project_id, item_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.params.id, req.params.code]
  );
  if (statusOnly) {
    // Grid edit: only change status, preserve date/notes
    await pool.query(
      `UPDATE project_items SET status=$1 WHERE project_id=$2 AND item_code=$3`,
      [status, req.params.id, req.params.code]
    );
  } else {
    await pool.query(
      `UPDATE project_items SET status=$1, delivery_date=$2, notes=$3
       WHERE project_id=$4 AND item_code=$5`,
      [status, delivery_date||null, notes||null, req.params.id, req.params.code]
    );
  }
  res.json({ ok: true });
});

// ── Send milestone email ──────────────────────────────────────────────────────

app.post('/projects/:id/send-email', requireAuth, upload.single('attachment'), async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email is not configured.' });
    const { phaseKey, amount, melioLink, extraHtml, extraText } = req.body;
    const phase = EMAIL_PHASES.find(p => p.key === phaseKey);
    if (!phase) return res.status(400).json({ ok: false, error: 'Unknown phase.' });

    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    if (!project.client_email) return res.status(400).json({ ok: false, error: 'No client email on this project. Add one via Edit Project.' });

    const { subject, body } = buildEmail({
      clientName: project.client_name,
      amount: amount || 'xxx',
      phase,
      melioLink,
    });

    const attachments = [];
    const def = await getDefaultAttachment();
    if (def) attachments.push(def);
    if (req.file) attachments.push({ filename: req.file.originalname, mimeType: req.file.mimetype, content: req.file.buffer });

    // Render as HTML so the Gmail signature appears; preserve the body's line breaks
    const sig = await getSignature();
    // Optional pasted content goes directly below the Melio link
    let extraBlock = '';
    if (extraHtml && /<table/i.test(extraHtml)) extraBlock = `<div style="margin-top:12px">${sanitizePastedHtml(extraHtml)}</div>`;
    else if (extraText && extraText.trim()) extraBlock = `<div style="margin-top:12px;white-space:pre-wrap">${escapeHtml(extraText.trim())}</div>`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${escapeHtml(body)}</div>${extraBlock}${sig ? '<br>' + sig : ''}`;

    await sendMail({ to: project.client_email, subject, html, attachments });

    // Record the milestone payment request in the ledger
    const amountNum = parseFloat(String(amount || '').replace(/[^0-9.]/g, ''));
    if (!isNaN(amountNum)) {
      await pool.query(
        'INSERT INTO milestone_payments (project_id, phase_key, phase_name, amount) VALUES ($1,$2,$3,$4)',
        [req.params.id, phase.key, phase.phaseName, amountNum]
      );
    }
    res.json({ ok: true, sentTo: project.client_email });
  } catch (err) {
    console.error('Email send error:', err.code || '', '-', err.message, JSON.stringify({ command: err.command, response: err.response }));
    res.status(500).json({ ok: false, error: `${err.code || 'ERR'}: ${err.message}` });
  }
});

// ── Send RFQ to supplier ──────────────────────────────────────────────────────

app.post('/projects/:id/rfq', requireAuth, upload.single('attachment'), async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email is not configured.' });
    const { itemCode, supplierEmail, supplierName, note, items, itemsHtml, emailType, cc, outboundDate } = req.body;
    const item = ALL_ITEMS.find(i => i.code === itemCode);
    if (!item) return res.status(400).json({ ok: false, error: 'Unknown material.' });
    if (!supplierEmail) return res.status(400).json({ ok: false, error: 'No recipient email. Add one in Settings or type it in.' });

    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });

    const fullAddress = project.full_address || project.address;
    const addr = escapeHtml(fullAddress);
    const table = (itemsHtml && /<table/i.test(itemsHtml)) ? sanitizePastedHtml(itemsHtml) : pastedDataToTable(items);
    const sig = await getSignature();
    const signoff = sig ? `<br>${sig}` : '<p>Thank you,<br>Logan<br>Buildoly</p>';
    let subject, html;
    let sendCc = null;

    if (emailType === 'warehouse') {
      // Warehouse Outbound Request template
      subject = `${project.address}_Outbound Request`;
      sendCc = cc || null;
      const whenTxt = outboundDate ? formatOutboundDate(outboundDate) : '[date]';
      html =
`<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>Hi Grace and Brian,</p>
<p>We need an outbound for <strong>${escapeHtml(whenTxt)}</strong>. Please see below for outbound slip.</p>
<p>Grace, Please include this job BOL in this email thread once its ready, so Brian can use it for pickup.</p>
${table || '<p><em>(slip goes here)</em></p>'}
${note ? `<p>${escapeHtml(note).replace(/\n/g, '<br>')}</p>` : ''}
<p>Thank you,</p>
${signoff}
</div>`;
    } else {
      const subjectLine = `${fullAddress} RFQ`;
      const TYPES = {
        order: { subject: subjectLine, intro: `I'd like to place an order for delivery to <strong>${addr}</strong>. Please see the items below:`, closing: 'Please confirm pricing, availability, and lead time.' },
        delivery: { subject: subjectLine, intro: `We're ready for delivery to <strong>${addr}</strong> on the following items:`, closing: 'Please confirm the delivery date.' },
        quote: { subject: subjectLine, intro: `I'd like to request an RFQ for delivery to <strong>${addr}</strong>:`, closing: 'Please provide pricing, availability, and lead time at your earliest convenience.' },
      };
      const t = TYPES[emailType] || TYPES.order;
      const greeting = supplierName ? `Hi ${escapeHtml(supplierName)},` : 'Hi,';
      subject = t.subject;
      html =
`<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>${greeting}</p>
<p>${t.intro}</p>
${table || '<p><em>(items below)</em></p>'}
${note ? `<p>${escapeHtml(note).replace(/\n/g, '<br>')}</p>` : ''}
<p>${t.closing}</p>
${signoff}
</div>`;
    }

    const attachments = [];
    if (req.file) attachments.push({ filename: req.file.originalname, mimeType: req.file.mimetype, content: req.file.buffer });

    const sent = await sendMail({ to: supplierEmail, cc: sendCc, subject, html, attachments });
    await pool.query(
      `INSERT INTO vendor_emails (project_id, item_code, supplier_name, supplier_email, subject, email_type, gmail_thread_id, gmail_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.params.id, itemCode, supplierName || null, supplierEmail, subject, emailType || 'order', sent.threadId || null, sent.messageId || null]
    );

    // Auto-advance the status of all this vendor's materials on the project
    const updatedItems = await advanceVendorItems(req.params.id, itemCode, emailType);

    res.json({ ok: true, sentTo: supplierEmail, updatedItems });
  } catch (err) {
    console.error('RFQ send error:', err.code || '', '-', err.message);
    res.status(500).json({ ok: false, error: `${err.code || 'ERR'}: ${err.message}` });
  }
});

// ── Settings (default attachment + suppliers) ─────────────────────────────────

app.get('/settings', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: [r] } = await pool.query('SELECT attachment_name, updated_at FROM app_settings WHERE id=1');
    const suppliers = await getSuppliers();
    res.render('settings', { attachmentName: r ? r.attachment_name : null, updatedAt: r ? r.updated_at : null, STAGES, suppliers });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.post('/settings/attachment', requireAuth, upload.single('attachment'), async (req, res) => {
  if (!req.file) return res.redirect('/settings');
  await pool.query(
    `INSERT INTO app_settings (id, attachment_name, attachment_mime, attachment_data, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET attachment_name=EXCLUDED.attachment_name,
       attachment_mime=EXCLUDED.attachment_mime, attachment_data=EXCLUDED.attachment_data, updated_at=NOW()`,
    [req.file.originalname, req.file.mimetype, req.file.buffer]
  );
  res.redirect('/settings');
});

app.post('/settings/attachment/delete', requireAuth, async (req, res) => {
  await pool.query(`UPDATE app_settings SET attachment_name=NULL, attachment_mime=NULL, attachment_data=NULL, updated_at=NOW() WHERE id=1`);
  res.redirect('/settings');
});

// ── Vendor email threads ──────────────────────────────────────────────────────

// List stored threads for a project
app.get('/projects/:id/threads', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, item_code, supplier_name, supplier_email, subject, email_type, gmail_thread_id, sent_at
       FROM vendor_emails WHERE project_id=$1 AND gmail_thread_id IS NOT NULL ORDER BY sent_at DESC`,
      [req.params.id]
    );
    res.json({ ok: true, threads: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Fetch the full conversation for one thread
app.get('/threads/:threadId', requireAuth, async (req, res) => {
  try {
    if (!useGmail) return res.status(400).json({ ok: false, error: 'Gmail not configured.' });
    const messages = await fetchThread(req.params.threadId);
    // For each vendor (inbound) message, pre-detect which materials it mentions
    const withDetected = messages.map(m => ({ ...m, detected: m.fromMe ? [] : detectMaterials(m.body) }));
    // Mark this thread as read
    await pool.query('UPDATE vendor_emails SET has_unread=false, last_viewed_at=NOW() WHERE gmail_thread_id=$1', [req.params.threadId]);
    res.json({ ok: true, messages: withDetected });
  } catch (err) {
    console.error('Thread fetch error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reply within a thread
app.post('/threads/:threadId/reply', requireAuth, async (req, res) => {
  try {
    if (!useGmail) return res.status(400).json({ ok: false, error: 'Gmail not configured.' });
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ ok: false, error: 'Empty reply.' });

    const messages = await fetchThread(req.params.threadId);
    if (!messages.length) return res.status(404).json({ ok: false, error: 'Thread not found.' });
    const last = messages[messages.length - 1];

    // Reply to the other participants (strip ourselves out)
    const replyTo = last.fromMe ? last.to : last.from;
    let subject = last.subject || '';
    if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;
    const refs = [last.references, last.messageIdHeader].filter(Boolean).join(' ');

    await sendMail({
      to: replyTo,
      subject,
      text: body,
      threadId: req.params.threadId,
      inReplyTo: last.messageIdHeader,
      references: refs,
    });

    // Detect materials mentioned in the reply so the UI can offer a status update
    const detected = detectMaterials(body);
    const { rows: [ve] } = await pool.query(
      'SELECT project_id FROM vendor_emails WHERE gmail_thread_id=$1 ORDER BY sent_at LIMIT 1',
      [req.params.threadId]
    );
    res.json({ ok: true, detected, projectId: ve ? ve.project_id : null });
  } catch (err) {
    console.error('Reply error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Vendor order confirmations ────────────────────────────────────────────────

// Log a confirmed order from a vendor reply (materials + optional amount + receipt)
app.post('/projects/:id/orders', requireAuth, upload.single('receipt'), async (req, res) => {
  try {
    const { supplierName, supplierEmail, amount, gmailThreadId, gmailMessageId, attachmentId, attachmentName, attachmentMime } = req.body;
    const valid = new Set(ALL_ITEMS.map(i => i.code));
    const codes = [].concat(req.body.codes || []).filter(c => valid.has(c));
    if (!codes.length) return res.status(400).json({ ok: false, error: 'Pick at least one material.' });

    const amountNum = amount ? parseFloat(String(amount).replace(/[^0-9.]/g, '')) : NaN;

    // Receipt: an uploaded file wins; otherwise pull the chosen Gmail attachment
    let rName = null, rMime = null, rData = null;
    if (req.file) {
      rName = req.file.originalname; rMime = req.file.mimetype; rData = req.file.buffer;
    } else if (attachmentId && gmailMessageId && useGmail) {
      try {
        const { data } = await gmailClient.users.messages.attachments.get({ userId: 'me', messageId: gmailMessageId, id: attachmentId });
        if (data && data.data) {
          rData = Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
          rName = attachmentName || 'receipt'; rMime = attachmentMime || 'application/octet-stream';
        }
      } catch (e) { /* attachment fetch failed — save the order without it */ }
    }

    const { rows: [ord] } = await pool.query(
      `INSERT INTO vendor_orders (project_id, supplier_name, supplier_email, amount, gmail_thread_id, gmail_message_id, receipt_name, receipt_mime, receipt_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.params.id, supplierName || null, supplierEmail || null, isNaN(amountNum) ? null : amountNum,
       gmailThreadId || null, gmailMessageId || null, rName, rMime, rData]
    );
    for (const code of codes) {
      await pool.query('INSERT INTO vendor_order_items (order_id, item_code) VALUES ($1,$2)', [ord.id, code]);
    }
    // A confirmed order means these materials are at least "Order Placed" (forward only)
    await bumpItemsForward(req.params.id, codes, 'Order Placed');

    res.json({ ok: true });
  } catch (err) {
    console.error('Save order error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Download a stored order receipt
app.get('/orders/:id/receipt', requireAuth, async (req, res) => {
  const { rows: [o] } = await pool.query('SELECT receipt_name, receipt_mime, receipt_data FROM vendor_orders WHERE id=$1', [req.params.id]);
  if (!o || !o.receipt_data) return res.status(404).send('No receipt on this order.');
  res.setHeader('Content-Type', o.receipt_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${o.receipt_name || 'receipt'}"`);
  res.send(o.receipt_data);
});

// Delete an order record
app.post('/orders/:id/delete', requireAuth, async (req, res) => {
  const { rows: [o] } = await pool.query('SELECT project_id FROM vendor_orders WHERE id=$1', [req.params.id]);
  await pool.query('DELETE FROM vendor_orders WHERE id=$1', [req.params.id]);
  res.redirect(o ? `/projects/${o.project_id}` : '/');
});

// ── PDF exports ───────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit');

app.get('/driving/pdf', requireAuth, async (req, res) => {
  const { rows: trips } = await pool.query('SELECT * FROM driving_trips ORDER BY trip_date ASC');
  const { rows: [tot] } = await pool.query('SELECT COALESCE(SUM(miles),0) AS total FROM driving_trips');
  const rate = 0.725;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="driving-log.pdf"');
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  doc.pipe(res);
  doc.fontSize(18).text('Driving Log — Mileage Reimbursement', { align: 'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666').text('Buildoly · logan@buildoly.com');
  doc.moveDown(0.8).fillColor('#000');
  doc.fontSize(11);
  trips.forEach(t => {
    const d = new Date(t.trip_date).toLocaleDateString();
    doc.font('Helvetica-Bold').text(d + '   ' + Number(t.miles).toFixed(1) + ' mi   $' + (Number(t.miles)*rate).toFixed(2), { continued: false });
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(t.route_text || '', { indent: 10 });
    doc.fontSize(11).fillColor('#000').moveDown(0.4);
  });
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(13)
    .text('Total: ' + Number(tot.total).toFixed(1) + ' miles  ×  $' + rate + '/mi  =  $' + (Number(tot.total)*rate).toFixed(2));
  doc.end();
});

app.get('/projects/:id/status-pdf', requireAuth, async (req, res) => {
  const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.status(404).send('Not found');
  const { rows: items } = await pool.query('SELECT * FROM project_items WHERE project_id=$1', [project.id]);
  const itemMap = {}; items.forEach(i => itemMap[i.item_code] = i);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="status-${project.address.replace(/[^a-z0-9]+/gi,'-')}.pdf"`);
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  doc.pipe(res);
  doc.fontSize(18).text('Project Status — ' + project.address);
  doc.moveDown(0.2).fontSize(10).fillColor('#666').text((project.full_address || '') + '   ·   ' + project.overall_status);
  doc.moveDown(0.8).fillColor('#000');
  STAGES.forEach(stage => {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1d27').text(stage.name);
    doc.moveDown(0.2);
    stage.items.forEach(it => {
      const row = itemMap[it.code] || {};
      const st = row.status || 'Not yet placed';
      const dd = row.delivery_date ? '  (del: ' + new Date(row.delivery_date).toLocaleDateString() + ')' : '';
      doc.font('Helvetica').fontSize(10).fillColor('#000').text('• ' + it.name + ': ', { continued: true })
        .fillColor('#2563eb').text(st + dd);
    });
    doc.moveDown(0.6);
  });
  doc.end();
});

// ── Milestone payment ledger ──────────────────────────────────────────────────

app.get('/payments', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: payments } = await pool.query(`
      SELECT mp.*, p.address FROM milestone_payments mp
      JOIN projects p ON p.id = mp.project_id
      ORDER BY mp.paid ASC, mp.requested_at DESC
    `);
    const { rows: [tot] } = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE NOT paid), 0) AS outstanding,
        COALESCE(SUM(amount) FILTER (WHERE paid), 0) AS collected,
        COALESCE(SUM(amount), 0) AS total
      FROM milestone_payments
    `);
    res.render('payments', { payments, totals: tot });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.post('/payments/:id/toggle', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE milestone_payments SET paid = NOT paid, paid_at = CASE WHEN paid THEN NULL ELSE NOW() END WHERE id=$1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

app.post('/payments/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM milestone_payments WHERE id=$1', [req.params.id]);
  res.redirect('/payments');
});

// ── Deliveries dashboard ──────────────────────────────────────────────────────

const ITEM_NAME = {};
ALL_ITEMS.forEach(i => ITEM_NAME[i.code] = i.name);

app.get('/deliveries', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows } = await pool.query(`
      SELECT pi.item_code, pi.status, pi.delivery_date, p.id AS project_id, p.address
      FROM project_items pi JOIN projects p ON p.id = pi.project_id
      WHERE pi.delivery_date IS NOT NULL AND pi.status NOT IN ('Delivered','Delivered from Inv.','N/A')
      ORDER BY pi.delivery_date ASC
    `);
    const items = rows.map(r => ({ ...r, item_name: ITEM_NAME[r.item_code] || r.item_code }));
    res.render('deliveries', { items });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Document vault ────────────────────────────────────────────────────────────

app.post('/projects/:id/documents', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) return res.redirect(`/projects/${req.params.id}`);
  await pool.query(
    'INSERT INTO project_documents (project_id, filename, mime, data) VALUES ($1,$2,$3,$4)',
    [req.params.id, req.file.originalname, req.file.mimetype, req.file.buffer]
  );
  res.redirect(`/projects/${req.params.id}`);
});

app.get('/documents/:id', requireAuth, async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT filename, mime, data FROM project_documents WHERE id=$1', [req.params.id]);
  if (!d) return res.status(404).send('Not found');
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${d.filename}"`);
  res.send(d.data);
});

app.post('/documents/:id/delete', requireAuth, async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT project_id FROM project_documents WHERE id=$1', [req.params.id]);
  await pool.query('DELETE FROM project_documents WHERE id=$1', [req.params.id]);
  res.redirect(d ? `/projects/${d.project_id}` : '/');
});

// ── Driving log ───────────────────────────────────────────────────────────────

app.get('/driving', requireAuth, async (req, res) => {
  try {
    await initDb();
    const home = await getHomeAddress();
    const { rows: projects } = await pool.query(
      'SELECT id, address, full_address FROM projects ORDER BY address'
    );
    const { rows: trips } = await pool.query('SELECT * FROM driving_trips ORDER BY trip_date DESC, id DESC');
    const { rows: [tot] } = await pool.query('SELECT COALESCE(SUM(miles),0) AS total FROM driving_trips');
    const MILEAGE_RATE = 0.725; // IRS-style reimbursement per mile
    res.render('driving', { home, projects, trips, totalMiles: tot.total, rate: MILEAGE_RATE, drivingEnabled });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Save the home address
app.post('/driving/home', requireAuth, async (req, res) => {
  const { home_address } = req.body;
  await pool.query(
    `INSERT INTO app_settings (id, home_address) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET home_address = EXCLUDED.home_address`,
    [home_address || null]
  );
  res.redirect('/driving');
});

// Calculate miles for a route (home → stops → home) without saving
app.post('/driving/preview', requireAuth, async (req, res) => {
  try {
    if (!drivingEnabled) return res.status(400).json({ ok: false, error: 'Set ORS_API_KEY on Railway to enable mileage.' });
    const home = await getHomeAddress();
    if (!home) return res.status(400).json({ ok: false, error: 'Set your home address first.' });
    const { stops } = req.body; // array of addresses (full) in order
    if (!Array.isArray(stops) || !stops.length) return res.status(400).json({ ok: false, error: 'Add at least one stop.' });
    const route = [home, ...stops, home];
    const miles = await routeMiles(route);
    res.json({ ok: true, miles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/driving/save', requireAuth, async (req, res) => {
  try {
    const { trip_date, route_text, miles } = req.body;
    if (!trip_date || miles == null) return res.status(400).json({ ok: false, error: 'Missing date or miles.' });
    await pool.query(
      'INSERT INTO driving_trips (trip_date, route_text, miles) VALUES ($1,$2,$3)',
      [trip_date, route_text || null, miles]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/driving/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM driving_trips WHERE id=$1', [req.params.id]);
  res.redirect('/driving');
});

// ── Suppliers page ────────────────────────────────────────────────────────────

app.get('/suppliers', requireAuth, async (req, res) => {
  try {
    await initDb();
    const suppliers = await getSuppliers();
    res.render('suppliers', { STAGES, suppliers, saved: req.query.saved === '1' });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.post('/suppliers', requireAuth, async (req, res) => {
  for (const item of ALL_ITEMS) {
    const name = req.body[`name_${item.code}`] || null;
    const email = req.body[`email_${item.code}`] || null;
    await pool.query(
      `INSERT INTO suppliers (item_code, supplier_name, supplier_email) VALUES ($1,$2,$3)
       ON CONFLICT (item_code) DO UPDATE SET supplier_name=EXCLUDED.supplier_name, supplier_email=EXCLUDED.supplier_email`,
      [item.code, name, email]
    );
  }
  res.redirect('/suppliers?saved=1');
});

// ── Delete project ────────────────────────────────────────────────────────────

app.post('/projects/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM projects WHERE id=$1', [req.params.id]);
  res.redirect('/');
});

// ── Google Chat MCP connector (acts as logan@buildoly.com) ─────────────────────
require('./mcp-chat').mountChatMcp(app);

// ── Scheduled jobs (node-cron) ────────────────────────────────────────────────
const cron = require('node-cron');
const NOTIFY_TO = process.env.NOTIFY_EMAIL || gmailUser || 'logan@buildoly.com';

// Check Gmail vendor threads for new inbound replies → set has_unread flags
async function checkUnreadThreads() {
  if (!useGmail) return;
  try {
    const { rows } = await pool.query('SELECT DISTINCT gmail_thread_id FROM vendor_emails WHERE gmail_thread_id IS NOT NULL');
    for (const r of rows) {
      try {
        const msgs = await fetchThread(r.gmail_thread_id);
        const inbound = msgs.filter(m => !m.fromMe);
        if (!inbound.length) continue;
        const latestDate = new Date(inbound[inbound.length - 1].date);
        const { rows: [ve] } = await pool.query('SELECT last_viewed_at FROM vendor_emails WHERE gmail_thread_id=$1 LIMIT 1', [r.gmail_thread_id]);
        const lastViewed = ve && ve.last_viewed_at ? new Date(ve.last_viewed_at) : new Date(0);
        await pool.query('UPDATE vendor_emails SET has_unread=$1, last_inbound_at=$2 WHERE gmail_thread_id=$3',
          [latestDate > lastViewed, latestDate, r.gmail_thread_id]);
      } catch (e) { /* skip individual thread errors */ }
    }
  } catch (e) { console.error('checkUnreadThreads:', e.message); }
}

async function sendDeliveryReminder() {
  if (!emailEnabled) return;
  try {
    const { rows } = await pool.query(`
      SELECT pi.delivery_date, pi.item_code, pi.status, p.address FROM project_items pi
      JOIN projects p ON p.id = pi.project_id
      WHERE pi.delivery_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
        AND pi.status NOT IN ('Delivered','Delivered from Inv.','N/A')
      ORDER BY pi.delivery_date`);
    if (!rows.length) return;
    let html = '<div style="font-family:Arial,sans-serif;font-size:14px"><p>Deliveries due in the next 3 days:</p><table style="border-collapse:collapse">';
    html += '<tr><th style="border:1px solid #ccc;padding:5px 9px;text-align:left">Date</th><th style="border:1px solid #ccc;padding:5px 9px;text-align:left">Project</th><th style="border:1px solid #ccc;padding:5px 9px;text-align:left">Material</th><th style="border:1px solid #ccc;padding:5px 9px;text-align:left">Status</th></tr>';
    rows.forEach(r => { html += `<tr><td style="border:1px solid #ccc;padding:5px 9px">${new Date(r.delivery_date).toLocaleDateString()}</td><td style="border:1px solid #ccc;padding:5px 9px">${escapeHtml(r.address)}</td><td style="border:1px solid #ccc;padding:5px 9px">${escapeHtml(ITEM_NAME[r.item_code]||r.item_code)}</td><td style="border:1px solid #ccc;padding:5px 9px">${escapeHtml(r.status)}</td></tr>`; });
    html += '</table></div>';
    await sendMail({ to: NOTIFY_TO, subject: `${rows.length} delivery(s) due in the next 3 days`, html });
    console.log('Delivery reminder sent:', rows.length);
  } catch (e) { console.error('sendDeliveryReminder:', e.message); }
}

async function sendWeeklyDigest() {
  if (!emailEnabled) return;
  try {
    const { rows: [s] } = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE overall_status='In Progress') AS in_progress,
      COUNT(*) FILTER (WHERE overall_status='Not Yet') AS not_yet,
      COUNT(*) AS total FROM projects`);
    const { rows: deliv } = await pool.query(`SELECT COUNT(*) c FROM project_items WHERE delivery_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND status NOT IN ('Delivered','Delivered from Inv.','N/A')`);
    const { rows: overdue } = await pool.query(`SELECT COUNT(*) c FROM project_items WHERE delivery_date < CURRENT_DATE AND status NOT IN ('Delivered','Delivered from Inv.','N/A')`);
    const { rows: [pay] } = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE NOT paid),0) outstanding FROM milestone_payments`);
    const { rows: [unr] } = await pool.query(`SELECT COUNT(DISTINCT project_id) c FROM vendor_emails WHERE has_unread=true`);
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
      <h2 style="margin:0 0 10px">Weekly Material Orders Digest</h2>
      <ul style="line-height:1.7">
        <li><strong>${s.total}</strong> projects (${s.in_progress} in progress, ${s.not_yet} not started)</li>
        <li><strong>${deliv[0].c}</strong> deliveries due this week${Number(overdue[0].c) ? `, <span style="color:#cc0000"><strong>${overdue[0].c} overdue</strong></span>` : ''}</li>
        <li><strong>$${Number(pay.outstanding).toLocaleString(undefined,{minimumFractionDigits:2})}</strong> in outstanding milestone payments</li>
        <li><strong>${unr.c}</strong> project(s) with unread vendor replies</li>
      </ul>
      <p><a href="https://material-orders-production.up.railway.app">Open the app →</a></p></div>`;
    await sendMail({ to: NOTIFY_TO, subject: 'Weekly Material Orders Digest', html });
    console.log('Weekly digest sent');
  } catch (e) { console.error('sendWeeklyDigest:', e.message); }
}

function startCron() {
  // Times are UTC on Railway. 15:00 UTC ≈ 7-8am Pacific.
  cron.schedule('*/20 * * * *', checkUnreadThreads);   // every 20 min
  cron.schedule('0 15 * * *', sendDeliveryReminder);    // daily ~7am PT
  cron.schedule('0 15 * * 1', sendWeeklyDigest);        // Mondays ~7am PT
  console.log('Cron jobs scheduled');
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
initDb().then(() => { console.log('DB ready'); startCron(); checkUnreadThreads(); }).catch(err => console.error('DB init failed:', err.message));
