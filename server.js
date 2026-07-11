'use strict';
require('dns').setDefaultResultOrder('ipv4first'); // Railway containers don't route IPv6
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

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
// Log anything slow so perf regressions show up in the Railway logs immediately.
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > 400) console.log('SLOW ' + Math.round(ms) + 'ms ' + req.method + ' ' + req.originalUrl);
  });
  next();
});
app.use(require('compression')());   // gzip every response — the grid HTML shrinks ~10x
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Static assets get a browser cache (views already cache-bust with ?v=N on change).
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
const pgSession = require('connect-pg-simple')(session);
app.use(session({
  // Store sessions in Postgres so logins survive deploys/restarts
  // (the old in-memory store wiped every session on each deploy)
  store: new pgSession({ pool, createTableIfMissing: true }),
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
      { code: '2d', name: 'Fs. Plumb/Light/Hood' },
      { code: '2e', name: 'Water Heater' },
    ],
  },
  {
    key: 'oneweek',
    name: '1 Week after Warehouse Outbound',
    items: [
      { code: '3a', name: 'Countertops' },
      { code: '3b', name: 'Appliances' },
      { code: '3c', name: 'Cabinet Hardware' },
      { code: '3d', name: 'Misc' },
      { code: '3e', name: 'Shower Doors' },
    ],
  },
  {
    key: 'roofing',
    name: 'Roofing',
    items: [
      { code: '4a', name: 'Roofing' },
    ],
  },
  {
    key: 'solar',
    name: 'Solar',
    items: [
      { code: '5a', name: 'Solar' },
    ],
  },
];

const ALL_ITEMS = STAGES.flatMap(s => s.items);
// Canonical code -> display name (the master numbering this app uses)
const CODE_NAME = Object.fromEntries(ALL_ITEMS.map(it => [it.code, it.name]));

// Finish schedules sometimes use a DIFFERENT number for the same bucket
// (e.g. a sheet labels Hardware as "3d" while our master code for Hardware is 3c,
// and labels Misc as "3e" while our Shower Doors is 3e). The category NAME the
// schedule author typed is the reliable signal, so map by name and ignore the
// possibly-wrong number prefix. Falls back to the literal code if no name matches.
function canonicalCodeFromCategory(rawCat) {
  const raw = String(rawCat || '');
  const t = raw.toLowerCase().replace(/^\s*[123][a-e]\.?\s*/, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t) {
    if (/shower door|shower glass|shower enclosure/.test(t)) return '3e';
    if (/water heater/.test(t)) return '2e';
    if (/rec light|recessed|can light|down ?light/.test(t)) return '1e';
    if (/hvac/.test(t)) return '1c';
    if (/countertop/.test(t)) return '3a';
    if (/appliance/.test(t)) return '3b';
    if (/decking|deck board/.test(t)) return '2c';
    if (/flooring|floor/.test(t)) return '2b';
    if (/millwork/.test(t)) return '2a';
    if (/tile/.test(t)) return '1d';
    if (/hardware/.test(t)) return '3c';
    if (/\bmisc/.test(t)) return '3d';
    if (/fs plumb|finish plumb|finished plumb|light|hood/.test(t)) return '2d';
    if (/r plumb|rough plumb|fan/.test(t)) return '1b';
    if (/door|window/.test(t)) return '1a';
  }
  const m = raw.match(/^\s*([123][a-e])\b/i);
  return m ? m[1].toLowerCase() : null;
}

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
  '2d': ['finish plumb', 'finished plumb', 'finish plumbing', 'light fixture', 'hood'],
  '2e': ['water heater'],
  '3a': ['countertop', 'counter top', 'counters'],
  '3b': ['appliance'],
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

// ── Receipt categorization (keyword rules) ─────────────────────────────────────
// Map a free-text line-item description to a material code. Order matters
// (more specific buckets first). The upload review screen lets users fix misses.
const CATEGORY_KEYWORDS = [
  ['2e', ['water heater', 'tankless', 'wtr htr', 'water htr']],
  ['3b', ['refrigerator', 'refrig', 'fridge', 'range', 'rnge', 'stove', 'wall oven', 'oven', 'cooktop', 'cook top', 'dishwasher', 'dishwshr', 'dishwash', ' dw ', 'dw ext', 'microwave', 'micro hood', ' mw ', 'washer', 'wshr', ' wm ', 'wm hose', 'dryer', 'dryr', 'freezer', 'frzr', 'wine cooler', 'ice maker', 'icemaker', 'im conn', 'range cord', 'dryer cord', 'stack kit', 'ldry stack', 'appliance']],
  ['1b', ['rough-in', 'rough in', 'ri vlv', 'rough vlv', 'shower drain', 'shwr flr', 'shower flr', 'shower floor', 'shower pan', 'shower base', 'shr flr', 'vent fan', 'exhaust fan', 'exh fan', 'ceiling fan', 'bath fan']],
  ['1d', ['tile', 'grout', 'thinset']],
  ['1e', ['recessed', 'rec light', 'rec. light', 'can light', 'downlight']],
  ['2a', ['millwork', 'cabinet', 'crown mold', 'baseboard', 'casing']],
  ['2b', ['flooring', 'hardwood floor', 'laminate', 'lvp', 'vinyl plank', 'underlayment']],
  ['2c', ['decking', 'deck board', 'composite deck']],
  ['3a', ['countertop', 'counter top', 'quartz', 'granite slab']],
  ['3c', ['handleset', 'lever', 'strike', 'privacy set', 'deadbolt', 'door knob', 'cabinet pull', 'cabinet knob', 'hinge', 'door hardware']],
  ['3e', ['shower door', 'shower glass', 'shower enclosure']],
  ['2d', ['faucet', 'fct', 'toilet', 'tlt', 'sink', 'shower trim', 'shower', 'disposal', 'disposer', 'air gap', 'flange', 'sconce', 'wall light', 'vanity light', 'light', 'mirror', 'range hood', 'hood', 'thermostat', 'tstat', 'p-trap', 'supply line', 'tub', 'lav', 'drain', 'valve', 'trim']],
];
function categorizeItem(desc) {
  const d = ' ' + String(desc || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const [code, kws] of CATEGORY_KEYWORDS) {
    if (kws.some(k => d.includes(k))) return code;
  }
  return '3d'; // Misc fallback
}

// Extract { vendor, amount, lines[] } from a receipt PDF buffer
async function parseReceiptPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text = '';
  try { const r = await parser.getText(); text = (r && r.text) || ''; }
  finally { if (parser.destroy) { try { await parser.destroy(); } catch (e) {} } }
  const rawLines = text.split(/\r?\n/);

  // Vendor = first line with letters (skip generic document-type headers like "Sales Order")
  let vendor = '';
  for (const l of rawLines) {
    const t = l.trim();
    if (t.length > 3 && /[a-z]/i.test(t) && !/^(sales order|invoice|purchase order|quote|estimate|receipt|order|packing slip)\b/i.test(t)) {
      vendor = t.replace(/\s+#\d+.*$/, '').slice(0, 120); break;
    }
  }

  // Grand total — prefer an inline "Total: $X"; else the largest standalone dollar amount.
  let amount = null;
  for (const l of rawLines) {
    if (/sub\s*total|net\s*total|sales\s*tax/i.test(l)) continue;
    const m = l.match(/\btotal\b\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
    if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(v)) amount = v; }
  }
  if (amount == null) {
    let max = 0;
    for (const l of rawLines) { const m = l.match(/\$\s*([\d,]+\.\d{2})/); if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (v > max) max = v; } }
    if (max > 0) amount = max;
  }

  // Line items — primary: join wrapped lines and match a "<qty> <U/M> <unit> <amount>[T]"
  // tail at the end of a logical row. Handles QuickBooks/single-spaced/tax-suffix receipts.
  const BOUNDARY = /^(total|subtotal|sales\s*tax|freight|service\s*charge|return\s*policy|thank you|item\s+description|project\s*name|p\.?o\.?\s*no|ship\b|terms|rep\b|date\b|name\s*\/|qty\b|--)/i;
  const TAIL = /(\d{1,4})\s+(ea|each|pc|pcs|lf|sf|box|cs|ctn|kit|set|pr|roll|gal|bag)\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s*[A-Za-z]?\s*$/i;
  const NEWITEM = /^[A-Z0-9]+-[A-Z0-9\-\/]+\s/i;          // a real SKU at the line start (has a hyphen)
  const CODELIKE = /^[A-Z0-9][A-Z0-9\-\/]{2,}$/i;
  const lines = [];
  let buf = '';
  for (const raw of rawLines) {
    const t = raw.trim();
    if (!t) continue;
    if (BOUNDARY.test(t)) { buf = ''; continue; }
    if (NEWITEM.test(t) && buf && !TAIL.test(buf)) buf = '';   // a new item began; drop the incomplete buffer
    buf = buf ? buf + ' ' + t : t;
    const m = buf.match(TAIL);
    if (m) {
      const qty = parseInt(m[1], 10) || 1;
      const price = parseFloat(m[4].replace(/,/g, ''));        // line amount
      const head = buf.slice(0, m.index).trim();
      const ft = head.split(/\s+/)[0] || '';
      const product_code = CODELIKE.test(ft) ? ft : '';
      const description = (product_code ? head.slice(ft.length).trim() : head).replace(/\s+/g, ' ').slice(0, 200) || product_code;
      if (description && !isNaN(price) && price > 0) {
        lines.push({ product_code, description, qty, price, item_code: categorizeItem(description + ' ' + product_code) });
      }
      buf = '';
    }
  }

  // Fallback: the old tab / 2-space column parser, for receipts that don't use that tail layout.
  if (!lines.length) {
    for (const raw of rawLines) {
      if (/total|tax|freight|page \d|^item\b|description|warranty|warning|notice|payment|assigned|p65|lead law|water flow|terms|\d{1,2}\/\d{1,2}\/\d{2,4}|\b(mc|visa|amex|disc)\s+\d{4}\b|^\s*$/i.test(raw)) continue;
      const parts = raw.split(/\t+|\s{2,}/).map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) continue;
      const last = parts[parts.length - 1].replace(/[$,]/g, '');
      if (!/^\d+\.\d{2}$/.test(last)) continue;
      const price = parseFloat(last);
      if (isNaN(price) || price <= 0) continue;
      let qty = 1;
      for (let i = 1; i < parts.length - 1; i++) { if (/^\d{1,3}$/.test(parts[i])) { qty = parseInt(parts[i], 10); break; } }
      const product_code = CODELIKE.test(parts[0]) ? parts[0] : '';
      const description = (product_code ? parts.slice(1) : parts)
        .filter(p => !/^[\d.,]+$/.test(p) && !/^(ea|each|pc|pcs|lf|sf|box|cs)$/i.test(p))
        .join(' ').slice(0, 200) || product_code;
      if (!description) continue;
      lines.push({ product_code, description, qty, price, item_code: categorizeItem(description + ' ' + product_code) });
    }
  }
  return { vendor, amount, lines };
}

const ITEM_STATUSES = [
  'Not yet placed',
  'Delivery Requested',
  'RFQ sent',
  'Order Placed',
  'In Inventory',
  'Delivered',
  'Delivered from Inv.',
  'N/A',
  'Issue',
];

const PROJECT_STATUSES = ['Not Yet', 'In Progress', 'All Delivered', 'Draft - Contract', 'Fully Delivered'];
// Lifecycle phases — THE project status (single dropdown, in pipeline order).
// The legacy overall_status above is kept in sync behind the scenes so the
// dashboard/digest/portal queries built on it keep working.
const PROJECT_PHASES = ['In Permitting', 'Pre-Construction', 'Under Construction', 'Under Warranty', 'Complete'];
function statusForPhase(phase, current) {
  if (phase === 'Complete' || phase === 'Under Warranty') return 'Fully Delivered';
  if (phase === 'In Permitting' || phase === 'Pre-Construction') return 'Not Yet';
  // Under Construction: keep a meaningful delivery status if it already has one
  return (current === 'In Progress' || current === 'All Delivered') ? current : 'In Progress';
}

// Office-stock lifecycle for held items (no RFQ/order — you already own them).
const HELD_STATUSES = ['In Office', 'Delivered'];

// How many of an item's `allocated` units are delivered for a project, given its
// held_item_status row. Supports partial delivery (delivered_qty) with a fallback to
// the old binary status for rows saved before partial tracking existed.
function deliveredQtyOf(hs, allocated) {
  const alloc = Math.max(0, Number(allocated) || 0);
  if (hs && hs.delivered_qty != null) return Math.max(0, Math.min(Number(hs.delivered_qty) || 0, alloc));
  if (hs && hs.status === 'Delivered') return alloc;   // legacy fully-delivered
  return 0;
}

// ── Email (Resend) ──────────────────────────────────────────────────────────

const { Resend } = require('resend');
const { google } = require('googleapis');
const chrono = require('chrono-node');   // natural-language date parsing of vendor replies

// Prefer the Gmail API (HTTPS — works on Railway, which blocks SMTP) so mail
// sends from the user's real address. Falls back to Resend if not configured.
const gmailUser = process.env.GMAIL_USER;
const gClientId = process.env.GMAIL_CLIENT_ID;
const gClientSecret = process.env.GMAIL_CLIENT_SECRET;
const gRefreshToken = process.env.GMAIL_REFRESH_TOKEN;
const useGmail = !!(gmailUser && gClientId && gClientSecret && gRefreshToken);

let gmailClient = null;
let sheetsClient = null;
let gOauth2 = null; // also used to mint Chat API access tokens (needs chat.messages.create in the refresh token's scopes)
if (useGmail) {
  const oauth2 = new google.auth.OAuth2(gClientId, gClientSecret);
  oauth2.setCredentials({ refresh_token: gRefreshToken });
  gmailClient = google.gmail({ version: 'v1', auth: oauth2 });
  sheetsClient = google.sheets({ version: 'v4', auth: oauth2 }); // read finish schedules as the user (private sheets OK)
  gOauth2 = oauth2;
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = useGmail ? gmailUser : (process.env.FROM_EMAIL || 'onboarding@resend.dev');
const emailEnabled = useGmail || !!resend;

function encodeHeader(s) {
  if (!/[^\x00-\x7F]/.test(String(s))) return s;
  return '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';
}

function buildRawMessage({ from, to, cc, subject, text, html, attachments, inReplyTo, references }) {
  attachments = attachments || [];
  subject = encodeHeader(subject);
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
  if (targetRank == null || !codes.length) return [];
  const { rows: current } = await pool.query(
    'SELECT item_code, status FROM project_items WHERE project_id=$1 AND item_code = ANY($2)', [projectId, codes]
  );
  const cur = {};
  current.forEach(r => cur[r.item_code] = r.status);
  const updated = [];
  for (const code of codes) {
    const c = cur[code] || 'Not yet placed';
    if (c === 'N/A' || c === 'Issue') continue;
    if ((STATUS_RANK[c] ?? 0) >= targetRank) continue;
    await pool.query(
      `INSERT INTO project_items (project_id, item_code, status) VALUES ($1,$2,$3)
       ON CONFLICT (project_id, item_code) DO UPDATE SET status=$3`,
      [projectId, code, target]
    );
    updated.push({ code, status: target });
  }
  return updated;
}

// ── Driving distance via OpenRouteService ─────────────────────────────────────
const ORS_KEY = process.env.ORS_API_KEY;
const drivingEnabled = !!ORS_KEY;
const _geocodeCache = {};

async function geocodeAddress(text) {
  if (_geocodeCache[text]) return _geocodeCache[text];
  // Bias results toward the LA / Southern California area so a vague address that's
  // missing a city/state (e.g. "10111 Topeka Dr") resolves locally instead of jumping
  // to the literal city match (Topeka, KS). focus.point only ranks — it never excludes.
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_KEY}&text=${encodeURIComponent(text)}&boundary.country=US&focus.point.lon=-118.2437&focus.point.lat=34.0522&size=1`;
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

// Per-user home/base address (each person's own starting point for mileage).
async function getHomeAddress(key) {
  if (!key) return null;
  try {
    const { rows: [r] } = await pool.query('SELECT home_address FROM user_prefs WHERE user_key=$1', [key]);
    return (r && r.home_address) || null;
  } catch (e) { return null; }
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

// ── Finish-schedule (Google Sheets) reading ────────────────────────────────────
const SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
function sheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
// Fix known supplier-name misspellings coming from the schedules (sheets are
// hand-typed, so e.g. "Freguson" shows up for Ferguson). Keep this list explicit
// and conservative so we never merge two genuinely different vendors.
const SUPPLIER_FIXES = [
  [/^fre?gus?on$/i, 'Ferguson'],   // Freguson / Fregusn / Frguson → Ferguson
  [/^fergusson$/i, 'Ferguson'],
  [/^furguson$/i, 'Ferguson'],
];
function normalizeSupplier(s) {
  const t = String(s || '').trim();
  for (const [re, val] of SUPPLIER_FIXES) if (re.test(t)) return val;
  return t;
}

// Per-project overrides applied to a schedule row's (category, supplier).
// 1) Normalize the category by NAME (schedule numbering is inconsistent with our master codes).
// 2) Item-name override: shower doors are sometimes filed under finish plumbing → force 3e.
// 3) recSource='oncall' → move Contractor-procured recessed lighting to 1e / On Call LED.
function applyRowOverrides(row, opts = {}) {
  const rawCat = (row[4] || '').trim();
  let supplier = normalizeSupplier((row[14] || '').trim());
  const text = ((row[0] || '') + ' ' + (row[6] || '')).toLowerCase();

  // 1) Trust the category name, not the (possibly-wrong) number prefix.
  let code = canonicalCodeFromCategory(rawCat);

  // 2) Some items are unmistakable by name; pull them into the right bucket even
  //    when the schedule files them elsewhere.
  if (/shower door|shower glass|shower enclosure/.test(text)) code = '3e';        // Shower Doors
  if (/water heater|wtr htr|water htr|tankless/.test(text)) code = '2e';          // Water Heater

  // 3) Recessed lighting supplier toggle (recessed only — never dimmer switches).
  if (opts.recSource === 'oncall' && /contractor to proc/i.test(supplier)) {
    if (!/dimmer|\bswitch\b/.test(text) && /recess|down ?light|canless|\bled\b|lighting/.test(text)) {
      code = '1e'; supplier = 'On Call LED';
    }
  }

  // 4) Range hood supplier toggle: 'buildoly' → supply the hood from Buildoly office stock.
  if (opts.rangeHoodSource === 'buildoly' && /range hood|\bhood\b/.test(text)) {
    supplier = 'Buildoly Stock';
  }

  // 5) Jedco supplier toggle: 'buildoly' → supply Jedco items from Buildoly office stock.
  if (opts.jedcoSource === 'buildoly' && /jedco/i.test(supplier)) {
    supplier = 'Buildoly Stock';
  }

  // 6) Door stock toggles (1a): the 3-panel bifold is carried in Buildoly stock by
  //    DEFAULT (set the project to 'vendor' to order it instead); the sliding glass
  //    door is vendor-supplied by default (set 'buildoly' if we start stocking it).
  if (opts.bifoldSource !== 'vendor' && /bi-?fold/.test(text)) {
    supplier = 'Buildoly Stock';
  }
  if (opts.slidingSource === 'buildoly' && /sliding\s*(glass\s*)?door|\bslider\b/.test(text)) {
    supplier = 'Buildoly Stock';
  }

  const cat = code ? (code + '. ' + (CODE_NAME[code] || '')) : rawCat;
  // Classify held stock: Office = Jedco items + range hoods; Warehouse = everything
  // else we hold as Buildoly Stock (vanities, closets, decking, LVP, cabinets, etc.).
  let location = null;
  if (isHeldSupplier(supplier)) {
    const isHood = /range hood|\bhood\b/.test(text);
    const isJedco = /jedco/i.test((row[14] || '').trim());
    location = (isHood || isJedco) ? 'office' : 'warehouse';
  }
  return { cat, supplier, location };
}
// True when a schedule row is the range hood (single, unmistakable by name).
function isRangeHoodRow(row) {
  const text = ((row[0] || '') + ' ' + (row[6] || '')).toLowerCase();
  return /range hood|\bhood\b/.test(text);
}
// Read the "Fin Sched" tab and group orderable items by their Supplier
async function readScheduleVendors(scheduleUrl, opts = {}) {
  // Read via the same authenticated + cached path as every other schedule reader
  // (works for sheets shared to logan@buildoly.com; doesn't require a public API key).
  const rows = await fetchScheduleValues(scheduleUrl);
  const CATRE = /^(1[a-e]|2[a-e]|3[a-e])\b/i;
  const SKIP = /contractor to proc|^n\/a$|^#/i;  // skip contractor-procured / N/A / spreadsheet errors (#N/A, #REF!, …) — keep Buildoly Stock (ships from the warehouse)
  const vendors = {};
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const { cat, supplier } = applyRowOverrides(row, opts);
    if (!CATRE.test(cat)) continue;
    if (!supplier || SKIP.test(supplier)) continue;
    const prodCode = (row[2] || '').trim();
    if (/not in scope/i.test(prodCode)) continue;
    const name = (row[0] || '').replace(/\n/g, ' ').trim() || (row[6] || '').trim();
    if (!name) continue;
    const item = {
      name, product: (row[6] || '').trim(), brand: (row[5] || '').trim(), model: (row[7] || '').trim(),
      finishColor: (row[8] || '').trim(),
      qty: (row[9] || '').trim() || '1', code: (cat.match(CATRE) || [])[1].toLowerCase(),
      planTag: (row[1] || '').trim(), prodCode,
      itemKey: itemKeyFor(prodCode, (row[7] || '').trim(), name),   // matches the Materials checklist key
    };
    if (!vendors[supplier]) vendors[supplier] = { name: supplier, items: [] };
    vendors[supplier].items.push(item);
  }
  return Object.values(vendors).sort((a, b) => a.name.localeCompare(b.name));
}

// Read the whole "Fin Sched" tab as a flat list (sections, items, subtotals) for display
function parseScheduleRows(rows) {
  const out = [];
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i];
    const A = (r[0] || '').replace(/\n/g, ' ').trim();
    const B = (r[1] || '').trim();  // Plan Tag
    const C = (r[2] || '').trim();  // Prod. Code
    if (/^subtotal/i.test(A)) { out.push({ type: 'subtotal', total: (r[13] || '').trim() }); continue; }
    if (B || C) {
      out.push({
        type: 'item', name: A, planTag: B, prodCode: C, category: (r[4] || '').trim(),
        brand: (r[5] || '').trim(), product: (r[6] || '').trim(), model: (r[7] || '').trim(),
        color: (r[8] || '').trim(), qty: (r[9] || '').trim(), cost: (r[13] || '').trim(),
        supplier: normalizeSupplier((r[14] || '').trim()), deliveryDate: (r[16] || '').trim(),
      });
    } else if (A) {
      out.push({ type: 'section', name: A });
    }
  }
  return out;
}
// Cache raw sheet values per sheet id for a few minutes — avoids re-hitting the
// Google Sheets API on every inventory/materials load (overrides are applied after).
const _sheetCache = new Map(); // id -> { at, values }
const _sheetFail = new Map();  // id -> at (negative cache for unreadable sheets)
const SHEET_TTL_MS = 5 * 60 * 1000;
const SHEET_FAIL_TTL_MS = 5 * 60 * 1000;
async function fetchScheduleValues(scheduleUrl) {
  const id = sheetIdFromUrl(scheduleUrl);
  if (!id) throw new Error('Invalid finish-schedule link.');
  const hit = _sheetCache.get(id);
  if (hit && (Date.now() - hit.at) < SHEET_TTL_MS) return hit.values;
  // Don't keep re-hitting a sheet that just failed (e.g. wrong tab name / not shared) —
  // those network round-trips were making every Inventory load slow.
  const failAt = _sheetFail.get(id);
  if (failAt && (Date.now() - failAt) < SHEET_FAIL_TTL_MS) {
    throw new Error('Schedule unreadable (cached — will retry in a few minutes).');
  }
  try {
    return await _fetchScheduleValuesUncached(id);
  } catch (e) {
    _sheetFail.set(id, Date.now());
    throw e;
  }
}
async function _fetchScheduleValuesUncached(id) {
  let values;
  // Preferred: read AS the user (sheets can stay private; only logan@buildoly.com needs access)
  if (sheetsClient) {
    try {
      const { data } = await sheetsClient.spreadsheets.values.get({ spreadsheetId: id, range: 'Fin Sched!A1:S400' });
      values = data.values || [];
    } catch (e) {
      const code = e.code || (e.response && e.response.status);
      // During the transition, fall back to the public API key if the sheet isn't
      // shared to logan@buildoly.com yet but is still "Anyone with the link".
      if ((code === 403 || code === 404) && SHEETS_API_KEY) {
        const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Fin%20Sched!A1:S400?key=${SHEETS_API_KEY}`);
        if (r.ok) { values = ((await r.json()).values) || []; _sheetCache.set(id, { at: Date.now(), values }); return values; }
        throw new Error('Sheet not accessible by logan@buildoly.com and not link-shared — share it with that account.');
      }
      if (code === 403 || code === 404) throw new Error('Sheet not accessible by logan@buildoly.com — share it with that account (or check the link).');
      throw new Error('Could not read the schedule: ' + (e.message || code));
    }
  } else if (SHEETS_API_KEY) {
    // Fallback: public API key (requires "Anyone with the link → Viewer")
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Fin%20Sched!A1:S400?key=${SHEETS_API_KEY}`);
    if (!r.ok) {
      if (r.status === 403) throw new Error('Sheet not shared — set it to "Anyone with the link → Viewer".');
      throw new Error('Could not read the schedule (HTTP ' + r.status + ').');
    }
    values = ((await r.json()).values) || [];
  } else {
    throw new Error('No Google Sheets access configured.');
  }
  _sheetCache.set(id, { at: Date.now(), values });
  return values;
}
async function readScheduleRows(scheduleUrl) {
  return parseScheduleRows(await fetchScheduleValues(scheduleUrl));
}
// Schedule items grouped by material category code (1a..3e) — for the Materials tab drill-down
async function readScheduleByCategory(scheduleUrl, opts = {}) {
  const rows = await fetchScheduleValues(scheduleUrl);
  const CATRE = /^(1[a-e]|2[a-e]|3[a-e])\b/i;
  const ROOMRE = /\s-\s[A-Za-z]{1,4}\d*\s*$/;   // a room header like "Bath 1 - BA", "Kitchen - KT"
  const byCode = {};
  let currentRoom = '';
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const { cat, supplier } = applyRowOverrides(row, opts);
    const m = cat.match(CATRE);
    if (!m) {
      const c0 = (row[0] || '').replace(/\n/g, ' ').trim();
      if (c0 && ROOMRE.test(c0)) currentRoom = c0.replace(ROOMRE, '').trim();   // remember which room we're in
      continue;
    }
    const name = (row[0] || '').replace(/\n/g, ' ').trim() || (row[6] || '').trim();
    if (!name) continue;
    const code = m[1].toLowerCase();
    const hood = isRangeHoodRow(row);
    const origSupplier = (row[14] || '').trim();
    const jedco = /jedco/i.test(origSupplier);
    const prodCode = (row[2] || '').trim();
    const model = (row[7] || '').trim();
    const held = isHeldSupplier(supplier);
    (byCode[code] = byCode[code] || []).push({
      name, room: currentRoom, product: (row[6] || '').trim(), brand: (row[5] || '').trim(),
      finishColor: (row[8] || '').trim(), prodCode,
      model, qty: (row[9] || '').trim() || '1', supplier,
      hood, jedco, defaultSupplier: (hood || jedco) ? origSupplier : undefined,
      held, itemKey: held ? heldItemKey(prodCode, model, name) : undefined,
      location: held ? ((hood || jedco) ? 'office' : 'warehouse') : undefined,
    });
  }
  return byCode;
}

// Suppliers whose materials count as office/warehouse stock ("in use" against inventory).
// Only Buildoly Stock counts — a Jedco item is "in use" only once it's toggled to
// Buildoly Stock (office), which rewrites its supplier to 'Buildoly Stock' in applyRowOverrides.
const HELD_SUPPLIERS = ['Buildoly Stock'];
function isHeldSupplier(supplier) {
  const s = String(supplier || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return HELD_SUPPLIERS.some(h => s === h.toLowerCase().replace(/[^a-z0-9]/g, ''));
}
// Stable per-line key for a held item within a project (for office-stock status).
// Prefer Prod. Code, else Model #, else name.
function heldItemKey(prodCode, model, name) {
  const v = (prodCode && !/^custom$/i.test(prodCode) ? prodCode : (model || name)) || '';
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Scan every linked finish schedule (WITH per-project overrides applied, so a
// range hood toggled to Buildoly Stock counts) and return every line whose
// resolved supplier is held stock. These are what draw inventory items down.
//   [{ project, name, prodCode, model, supplier, qty, text }]
// Cached held-usage computation. Reading every project's finish schedule live on each
// inventory load hammered the Sheets API (31 parallel reads → rate-limited → ~3 min).
// We now read in small concurrent batches, cache the result, and refresh in the background,
// so the inventory page serves instantly from a warm cache.
let _heldUsagesCache = { at: 0, usages: [], fails: [] };
async function refreshHeldUsages() {
  const raw = await _computeHeldUsagesRaw();
  _heldUsagesCache = { at: Date.now(), usages: raw.usages, fails: raw.fails };
  return _heldUsagesCache;
}
let _heldRefreshing = false;
// Force a fresh read: drop the per-sheet cache so the very latest schedule values (and any
// source-toggle changes) are re-read, then recompute held usages.
async function forceRefreshHeldUsages() {
  _sheetCache.clear(); _sheetFail.clear();
  return refreshHeldUsages();
}
async function computeHeldUsages(maxAgeMs = 30 * 60 * 1000) {
  // Never block a page load on the (slow, variable) sheet reads. Serve whatever's cached
  // immediately; if it's stale, kick a background refresh so the NEXT load is current.
  const stale = !(_heldUsagesCache.usages.length && (Date.now() - _heldUsagesCache.at) < maxAgeMs);
  if (stale && !_heldRefreshing) {
    _heldRefreshing = true;
    refreshHeldUsages().catch(e => console.error('held usages refresh:', e.message)).finally(() => { _heldRefreshing = false; });
  }
  return _heldUsagesCache.usages;
}
async function _computeHeldUsagesRaw() {
  const { rows: projects } = await pool.query(
    "SELECT id, COALESCE(full_address, address) AS address, finish_schedule_url, rec_lighting_source, range_hood_source, jedco_source, bifold_source, sliding_door_source FROM projects WHERE finish_schedule_url IS NOT NULL AND finish_schedule_url <> '' ORDER BY address"
  );
  // Read in concurrent batches of 6 — big parallel bursts get throttled and stall.
  const fetched = []; const fails = [];
  const BATCH = 6;
  for (let i = 0; i < projects.length; i += BATCH) {
    const part = await Promise.all(projects.slice(i, i + BATCH).map(async proj => {
      try { return { proj, rows: await fetchScheduleValues(proj.finish_schedule_url) }; }
      catch (e) { fails.push({ address: proj.address, error: String(e.message || e).slice(0, 80) }); return null; }
    }));
    fetched.push(...part);
  }
  const usages = [];
  for (const f of fetched) {
    if (!f) continue;
    const { proj, rows } = f;
    const opts = { recSource: proj.rec_lighting_source, rangeHoodSource: proj.range_hood_source, jedcoSource: proj.jedco_source, bifoldSource: proj.bifold_source, slidingSource: proj.sliding_door_source };
    for (let i = 5; i < rows.length; i++) {
      const row = rows[i];
      const { cat, supplier, location } = applyRowOverrides(row, opts);
      if (!isHeldSupplier(supplier)) continue;
      const name = (row[0] || '').replace(/\n/g, ' ').trim() || (row[6] || '').trim();
      if (!name) continue;
      const prodCode = (row[2] || '').trim();
      const model = (row[7] || '').trim();
      const product = (row[6] || '').trim();
      const code = (String(cat).match(/^(1[a-e]|2[a-e]|3[a-e])\b/i) || [])[1];
      usages.push({
        projectId: proj.id, project: proj.address, name, product, prodCode, model, supplier,
        location,                              // 'office' (Jedco/hood) or 'warehouse'
        code: code ? code.toLowerCase() : null,
        itemKey: heldItemKey(prodCode, model, name),
        qty: parseFloat((row[9] || '').trim()) || 1,
        text: [name, product, model, prodCode].join(' ').toLowerCase(),
      });
    }
  }
  return { usages, fails };
}

// When a project grid category is marked "Delivered from Inv." (or moved back to
// "In Inventory"), sync the matching held-stock items so the Inventory tab draws
// them down (delivered) / restores them (in office). Reads just this one project's
// schedule (cached) rather than all of them.
async function syncHeldStockForCode(projectId, code, delivered) {
  try {
    const { rows: [proj] } = await pool.query(
      'SELECT finish_schedule_url, rec_lighting_source, range_hood_source, jedco_source, bifold_source, sliding_door_source FROM projects WHERE id=$1', [projectId]);
    if (!proj || !proj.finish_schedule_url) return 0;
    let rows;
    try { rows = await fetchScheduleValues(proj.finish_schedule_url); } catch (e) { return 0; }
    const opts = { recSource: proj.rec_lighting_source, rangeHoodSource: proj.range_hood_source, jedcoSource: proj.jedco_source, bifoldSource: proj.bifold_source, slidingSource: proj.sliding_door_source };
    const keys = new Set();
    for (let i = 5; i < rows.length; i++) {
      const row = rows[i];
      const { cat, supplier } = applyRowOverrides(row, opts);
      if (!isHeldSupplier(supplier)) continue;
      const rcode = (String(cat).match(/^(1[a-e]|2[a-e]|3[a-e])\b/i) || [])[1];
      if (!rcode || rcode.toLowerCase() !== String(code).toLowerCase()) continue;
      const name = (row[0] || '').replace(/\n/g, ' ').trim() || (row[6] || '').trim();
      keys.add(heldItemKey((row[2] || '').trim(), (row[7] || '').trim(), name));
    }
    if (!keys.size) return 0;
    const status = delivered ? 'Delivered' : 'In Office';
    for (const k of keys) {
      await pool.query(
        `INSERT INTO held_item_status (project_id, item_key, status, delivered_qty, updated_at) VALUES ($1,$2,$3,NULL,NOW())
         ON CONFLICT (project_id, item_key) DO UPDATE SET status=EXCLUDED.status, delivered_qty=NULL, updated_at=NOW()`,
        [projectId, k, status]
      );
    }
    return keys.size;
  } catch (e) { return 0; }
}

// Load manual inventory items (name · product · qty).
async function getInventoryItems() {
  const { rows } = await pool.query('SELECT id, name, product, qty, notes FROM inventory_items ORDER BY name');
  return rows;
}

// Distinct item catalog across all linked schedules — powers the Add-item search
// so picking a name auto-fills its Model #. Deduped by name + model.
async function readScheduleCatalog() {
  const { rows: projects } = await pool.query(
    "SELECT finish_schedule_url FROM projects WHERE finish_schedule_url IS NOT NULL AND finish_schedule_url <> ''"
  );
  const seen = new Map();
  // Read all schedules in parallel (cached) instead of one-at-a-time
  const fetched = await Promise.all(projects.map(async proj => {
    try { return await fetchScheduleValues(proj.finish_schedule_url); }
    catch (e) { return null; }
  }));
  for (const rows of fetched) {
    if (!rows) continue;
    for (let i = 5; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[0] || '').replace(/\n/g, ' ').trim() || (r[6] || '').trim();
      if (!name) continue;
      const model = (r[7] || '').trim();
      const prodCode = (r[2] || '').trim();
      const key = (name + '|' + model + '|' + prodCode).toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, {
          name, model, prodCode, brand: (r[5] || '').trim(),
          product: (r[6] || '').trim(), supplier: normalizeSupplier((r[14] || '').trim()),
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Outgoing email bodies support **bold** (used by the bid-request templates)
function emailBodyHtml(body) {
  return escapeHtml(body).replace(/\*\*([^*\n][^*]*?)\*\*/g, '<strong>$1</strong>');
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

// Clean a pasted HTML table (from Google Sheets) into an email-safe table,
// PRESERVING merged cells (colspan/rowspan) and fill colors so it looks like the sheet.
function sanitizePastedHtml(html) {
  if (!html) return '';
  const m = html.match(/<table[\s\S]*<\/table>/i);
  let t = m ? m[0] : html;
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');

  // Rebuild each cell: keep colspan/rowspan + background-color/text-align/font-weight
  t = t.replace(/<(td|th)\b([^>]*)>/gi, (mm, tag, attrs) => {
    const grab = re => { const x = attrs.match(re); return x ? x[1].trim() : null; };
    const colspan = grab(/colspan\s*=\s*["']?(\d+)/i);
    const rowspan = grab(/rowspan\s*=\s*["']?(\d+)/i);
    const sm = attrs.match(/style\s*=\s*"([^"]*)"/i) || attrs.match(/style\s*=\s*'([^']*)'/i);
    const style = sm ? sm[1] : '';
    const bg = (style.match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1] || grab(/bgcolor\s*=\s*["']?([^"'\s>]+)/i);
    const align = (style.match(/text-align\s*:\s*([^;]+)/i) || [])[1];
    const weight = (style.match(/font-weight\s*:\s*([^;]+)/i) || [])[1];
    let css = 'border:1px solid #ccc;padding:5px 8px;font-size:13px;';
    if (bg && !/transparent|#ffffff|#fff\b|(^|\s)white/i.test(bg)) css += `background-color:${bg};`;
    if (align) css += `text-align:${align};`;
    if (weight && /bold|[6-9]00/i.test(weight)) css += 'font-weight:bold;';
    let out = `<${tag.toLowerCase()} style="${css}"`;
    if (colspan) out += ` colspan="${colspan}"`;
    if (rowspan) out += ` rowspan="${rowspan}"`;
    return out + '>';
  });

  // Column widths from <col> tags (Google Sheets sizing) — keeps the table from smushing
  const colWidths = [];
  (t.match(/<col\b[^>]*>/gi) || []).forEach(c => {
    const w = (c.match(/width\s*=\s*["']?(\d+)/i) || [])[1] || (c.match(/width\s*:\s*(\d+)/i) || [])[1];
    if (w) colWidths.push(parseInt(w, 10));
  });
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  const haveWidths = colWidths.length > 0 && totalW > 0;

  // Preserve <col> widths; if no widths exist, stop cells from wrapping (so they don't cram)
  t = t.replace(/<col\b[^>]*>/gi, c => {
    const w = (c.match(/width\s*=\s*["']?(\d+)/i) || [])[1] || (c.match(/width\s*:\s*(\d+)/i) || [])[1];
    return w ? `<col style="width:${w}px">` : '<col>';
  });
  t = t.replace(/<(\/?)colgroup\b[^>]*>/gi, (mm, slash) => `<${slash}colgroup>`);
  if (!haveWidths) t = t.replace(/font-size:13px;/g, 'font-size:13px;white-space:nowrap;');

  // Strip attributes from the other allowed tags (cells already handled above)
  t = t.replace(/<(\/?)(table|thead|tbody|tr|b|strong|i|em|br|p|span|div)\b[^>]*>/gi, (mm, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
  // Remove any tags not in the allow-list (keep inner text)
  t = t.replace(/<(?!\/?(?:table|thead|tbody|tr|td|th|colgroup|col|b|strong|i|em|br|p|span|div)\b)[^>]*>/gi, '');
  // Style the table — fixed layout + total width when the sheet provided column widths
  const tstyle = 'border-collapse:collapse;margin:12px 0;font-family:Arial,sans-serif' + (haveWidths ? `;table-layout:fixed;width:${totalW}px` : '');
  t = t.replace(/<table>/gi, `<table style="${tstyle}">`);
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
  return { plain, html: htmlBody };
}

function headerVal(headers, name) {
  const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Phrases from OUR own RFQ/outbound templates — when a vendor reply quotes our
// original inline (no "On … wrote:" marker), the quote starts at one of these.
const OUR_QUOTE_MARKERS = [
  /i'?d like to place an order for delivery to/i,
  /we'?re ready for delivery to/i,
  /i'?d like to request an rfq/i,
  /please see the items below/i,
  /we need an outbound for/i,
  /please reply to this email thread directly/i,
];
// Trim the quoted reply history from a plain-text body (keep just the latest message,
// like Gmail collapses). For inbound mail we also cut where our own quoted email begins.
function stripQuotedPlain(text, fromMe) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const stdMarker = /^(on .+ wrote:|>+\s?|-{2,}\s*original message|from:\s.+|sent from my |________+|_{5,})/i;
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (stdMarker.test(t)) break;
    if (!fromMe && OUR_QUOTE_MARKERS.some(re => re.test(t))) break;   // start of our quoted original
    out.push(line);
  }
  const s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return s || String(text || '').trim();
}
// Turn a cleaned plain-text body into safe display HTML (line breaks preserved).
function plainToDisplayHtml(text, fromMe) {
  return escapeHtml(stripQuotedPlain(text, fromMe)).replace(/\n/g, '<br>');
}
// Clean an HTML body: drop the Gmail/Outlook quoted history, then sanitize.
// Sanitize a FULL email HTML body for safe display (keeps text + tables/boxes; strips
// scripts, event handlers, and js: URLs). Unlike sanitizePastedHtml, it keeps everything,
// not just the first table.
function sanitizeEmailHtml(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(script|style|meta|link|base)\b[^>]*>/gi, '');
  s = s.replace(/<\/?(html|body|head)\b[^>]*>/gi, '');
  s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, '').replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  return s.trim();
}
function htmlToDisplayHtml(html) {
  let s = String(html || '');
  s = s.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, '');
  s = s.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
  return sanitizeEmailHtml(s);
}

// List file attachments (filename + Gmail attachmentId) in a message payload
function extractAttachments(payload) {
  const out = [];
  function walk(part) {
    if (!part) return;
    if (part.filename && part.body && part.body.attachmentId) {
      // Flag inline parts (embedded in the HTML body, e.g. signature logos) so callers
      // can hide them — a real attached file has Content-Disposition: attachment.
      const hdrs = part.headers || [];
      const dispo = hdrs.find(h => /^content-disposition$/i.test(h.name));
      const cid = hdrs.find(h => /^content-id$/i.test(h.name));
      const inline = (dispo && /inline/i.test(dispo.value)) || !!cid;
      out.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size, inline });
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
    const fromMe = headerVal(headers, 'From').includes(gmailUser);
    const { plain, html } = extractBody(m.payload);
    // Our own messages: render the HTML so the items table/boxes show. Vendor replies:
    // prefer cleaned plain text so the quoted history gets stripped (HTML quotes are
    // harder to strip reliably). Fall back to whichever part exists.
    let bodyHtml;
    if (fromMe && html) bodyHtml = htmlToDisplayHtml(html);
    else if (plain) bodyHtml = plainToDisplayHtml(plain, fromMe);
    else if (html) bodyHtml = htmlToDisplayHtml(html);
    else bodyHtml = '';
    return {
      id: m.id,
      from: headerVal(headers, 'From'),
      to: headerVal(headers, 'To'),
      date: headerVal(headers, 'Date'),
      subject: headerVal(headers, 'Subject'),
      messageIdHeader: headerVal(headers, 'Message-ID'),
      references: headerVal(headers, 'References'),
      snippet: m.snippet,
      body: plain || html || '',   // raw text for material detection
      bodyHtml,                    // display HTML (table preserved for our messages)
      isHtml: !plain && !!html,
      attachments: extractAttachments(m.payload),
      fromMe,
    };
  });
  return messages;
}

// Vendors sometimes reply in a NEW Gmail thread (their mail client drops the
// In-Reply-To headers), so the reply has the same subject but a different thread id.
// Find every thread that belongs to the same conversation by subject + participant.
async function relatedThreadIds(subject, supplierEmail) {
  if (!gmailClient) return [];
  const cleanSubj = String(subject || '').replace(/["\\]/g, '').replace(/^\s*(re|fwd):\s*/i, '').trim();
  const parts = [];
  if (cleanSubj) parts.push(`subject:"${cleanSubj}"`);
  if (supplierEmail) parts.push(`(from:${supplierEmail} OR to:${supplierEmail})`);
  if (!parts.length) return [];
  try {
    const { data } = await gmailClient.users.threads.list({ userId: 'me', q: parts.join(' '), maxResults: 15 });
    return (data.threads || []).map(t => t.id);
  } catch (e) { return []; }
}
// Full vendor conversation for a stored thread — merges the original thread with any
// split-off reply threads (same subject + vendor), deduped and sorted by date.
async function fetchConversation(threadId) {
  const ids = new Set([threadId]);
  try {
    const { rows: [ve] } = await pool.query('SELECT subject, supplier_email FROM vendor_emails WHERE gmail_thread_id=$1 LIMIT 1', [threadId]);
    if (ve) (await relatedThreadIds(ve.subject, ve.supplier_email)).forEach(id => ids.add(id));
  } catch (e) { /* fall back to just the one thread */ }
  const all = [];
  for (const id of ids) { try { all.push(...await fetchThread(id)); } catch (e) { /* skip */ } }
  const seen = new Set();
  const merged = all.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  merged.sort((a, b) => new Date(a.date) - new Date(b.date));
  return merged;
}

// Accepts one address or several separated by comma/semicolon → array of clean addresses
function parseRecipients(to) {
  return String(to || '').split(/[,;]+/).map(s => s.trim()).filter(Boolean);
}

// ── Isolation / test mode ────────────────────────────────────────────────────────
// When MAIL_REDIRECT_ALL is set to an address, every outbound email is rewritten to
// that single inbox and the intended recipient is shown in the subject — nothing can
// reach a real client, sub, or vendor. Threading is stripped so test copies don't land
// inside real Gmail conversations. Delivery-chat pings are diverted to the Bids space.
const MAIL_REDIRECT_ALL = (process.env.MAIL_REDIRECT_ALL || '').trim();
const ISOLATION_ON = !!MAIL_REDIRECT_ALL;
if (ISOLATION_ON) console.log('⚠ ISOLATION MODE ON — all outbound email redirected to ' + MAIL_REDIRECT_ALL);
// Global pause for ALL Google Chat posts (delivery alerts + Bids space). Set CHAT_PAUSED=on
// to silence every chat message app-wide; unset (or =off) to resume. Email is unaffected.
const CHAT_PAUSED = String(process.env.CHAT_PAUSED || '').toLowerCase() === 'on';
if (CHAT_PAUSED) console.log('⏸ CHAT PAUSED — all Google Chat posts suppressed (CHAT_PAUSED=on)');

async function sendMail({ to, cc, subject, text, html, attachments, threadId, inReplyTo, references }) {
  if (MAIL_REDIRECT_ALL) {
    const intended = [to, cc].filter(Boolean).join(', ') || '(no recipient)';
    subject = `[TEST → ${intended}] ${subject || ''}`;
    to = MAIL_REDIRECT_ALL; cc = undefined;
    threadId = undefined; inReplyTo = undefined; references = undefined;
  }
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

// Read the user's Gmail signature (the HTML block they set in Gmail settings) so we can
// append it to app-sent emails — the Gmail API does NOT add it automatically the way the
// web compose UI does. Cached for the process; falls back to '' if the scope is missing.
let _cachedSignature = null;
async function getGmailSignature() {
  if (!useGmail) return '';
  if (_cachedSignature !== null) return _cachedSignature;
  try {
    const { data } = await gmailClient.users.settings.sendAs.list({ userId: 'me' });
    const list = data.sendAs || [];
    const mine = list.find(s => s.isDefault) ||
      list.find(s => (s.sendAsEmail || '').toLowerCase() === String(gmailUser).toLowerCase()) || list[0];
    _cachedSignature = (mine && mine.signature) ? mine.signature : '';
  } catch (e) { console.error('getGmailSignature:', e.message); _cachedSignature = ''; }
  return _cachedSignature;
}

// Superintendents — each project can be assigned a super, who gets @mentioned on
// that project's delivery alerts. chatId is the Google Chat user ID (numeric) used
// for the <users/ID> mention. Add more here as needed (look up their Chat user ID).
const SUPERS = [
  { email: 'bobby@buildoly.com', username: 'bobby', name: 'Bobby Li', chatId: '111280454403124522893', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },
  { email: 'kevin@buildoly.com', username: 'kevin', name: 'Kevin Leon', chatId: '114651669878031315273', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },
  { email: 'eddie@buildoly.com', username: 'eddie', name: 'Eddie Solorzano', chatId: '105599791425178916274', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },
];
// Added site contacts (extra supers + outsourced GCs) managed from the UI. These are
// contacts only — assignable to a project and able to receive the delivery notice — but
// have NO login and NO Chat mention (only the built-in SUPERS above do). Cached in memory
// and refreshed on edit so the sync helpers below stay synchronous.
let DYNAMIC_PEOPLE = [];
async function loadPeople() {
  try {
    const { rows } = await pool.query("SELECT id, name, email, phone, role FROM people WHERE active = TRUE ORDER BY name");
    DYNAMIC_PEOPLE = rows.filter(r => r.email).map(r => ({ id: r.id, email: String(r.email).toLowerCase(), name: r.name, phone: r.phone || '', role: r.role || 'super', dynamic: true }));
  } catch (e) { DYNAMIC_PEOPLE = []; }
}
// Everyone assignable as a job-site contact: built-in supers + added people (deduped by email).
function allContacts() {
  const seen = new Set(SUPERS.map(s => s.email.toLowerCase()));
  return [...SUPERS.map(s => ({ ...s, role: 'super' })), ...DYNAMIC_PEOPLE.filter(p => !seen.has(p.email))];
}
function findSuper(email) {
  const e = String(email || '').trim().toLowerCase();
  return allContacts().find(s => s.email.toLowerCase() === e) || null;
}
// Additional full-access (admin) logins beyond the env ADMIN account (Logan).
// Default password is "buildoly" — ask to have it changed to something specific.
const ADMINS = [
  { username: 'jeff', name: 'Jeff', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },  // CEO
  { username: 'aziz', name: 'Aziz', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },  // Ops manager
  { username: 'rick', name: 'Rick', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },  // Sales — limited access (see defaultPagesFor)
  { username: 'dennis', name: 'Dennis', passwordHash: '$2b$10$173Eyl/DlwQh.iOhmzIZk.a/80Shd8ksxO7qVEW5dk1MIKV0zk0PW' },  // Sales — Driving Log (mileage) only (see defaultPagesFor)
];
// Team members Logan adds from the /team hub — dynamic office logins (same access model as ADMINS;
// page permissions managed on /team). Loaded from the team_logins table.
let DB_ADMINS = [];
async function loadTeamLogins() {
  try {
    const { rows } = await pool.query('SELECT user_key, name, password_hash FROM team_logins ORDER BY name');
    DB_ADMINS = rows.map(r => ({ username: String(r.user_key).toLowerCase(), name: r.name, passwordHash: r.password_hash, dynamic: true }));
  } catch (e) { DB_ADMINS = []; }
}
function findAdminByLogin(login) {
  const l = String(login || '').trim().toLowerCase();
  return ADMINS.find(a => a.username.toLowerCase() === l) || DB_ADMINS.find(a => a.username.toLowerCase() === l) || null;
}

// ── Page permissions (managed in the /team hub) ───────────────────────────────
// Logan (the env admin) is always full-access and can't be restricted. Everyone
// else's page access is configurable and defaults to their current access.
const PAGE_META = [
  { key: 'projects', label: 'Projects', path: '/projects' },
  { key: 'deliveries', label: 'Deliveries', path: '/deliveries' },
  { key: 'ordering', label: 'Order Planner', path: '/ordering' },
  { key: 'requests', label: 'Requests', path: '/requests' },
  { key: 'request_form', label: 'Request Materials', path: '/request-materials' },
  { key: 'issues', label: 'Issues', path: '/issues' },
  { key: 'warranty', label: 'Warranty', path: '/warranty-claims' },
  { key: 'notices', label: 'Delivery Notices', path: '/delivery-notices' },
  { key: 'subs', label: 'Subs', path: '/subs' },
  { key: 'suppliers', label: 'Suppliers', path: '/suppliers' },
  { key: 'inventory', label: 'Inventory', path: '/inventory' },
  { key: 'catalog', label: 'Master Catalog', path: '/catalog' },
  { key: 'driving', label: 'Driving Log', path: '/driving' },
  { key: 'settings', label: 'Settings', path: '/settings' },
];
const PAGE_KEYS = PAGE_META.map(p => p.key);
function teamMembers() {
  return [
    ...ADMINS.map(a => ({ key: a.username, name: a.name, role: 'Admin' })),
    ...DB_ADMINS.map(a => ({ key: a.username, name: a.name, role: 'Admin', dynamic: true })),
    ...SUPERS.map(s => ({ key: s.email, name: s.name, role: 'Super' })),
  ];
}
let ACCESS = {};   // user_key -> Set(pageKeys)
async function loadAccess() {
  try {
    const { rows } = await pool.query('SELECT user_key, pages FROM user_access');
    const m = {};
    rows.forEach(r => { m[r.user_key] = new Set(String(r.pages || '').split(',').map(s => s.trim()).filter(Boolean)); });
    ACCESS = m;
  } catch (e) { /* table may not exist yet */ }
}
// Pages every SUPERINTENDENT gets by ROLE (on top of their /my portal, which already has
// the material-request + issue forms). The Team page can grant extras, but these role
// pages can never be un-ticked away — being a super IS the access.
const SUPER_ROLE_PAGES = ['driving'];
function defaultPagesFor(key, role) {
  if (key === 'rick') return new Set(['subs']);               // Sales: Subs/bidding only (tune on the Team page)
  if (key === 'dennis') return new Set(['driving']);          // Dennis (sales): mileage calculator (Driving Log) only
  if (role === 'admin') return new Set(PAGE_KEYS);            // Jeff/Aziz default to everything
  if (canSuperViewSubs(key)) return new Set(['subs', 'warranty', ...SUPER_ROLE_PAGES]);  // Bobby keeps his extras
  if (role === 'super') return new Set(SUPER_ROLE_PAGES);     // every super: role pages
  return new Set();
}
function sessionKey(req) { return (req.session && (req.session.userKey || req.session.superEmail)) || ''; }
function allowedPagesFor(key, role) {
  if (key === 'logan') return new Set(PAGE_KEYS);            // Logan: full, locked
  const base = ACCESS[key] ? new Set(ACCESS[key]) : defaultPagesFor(key, role);
  if (role === 'super') SUPER_ROLE_PAGES.forEach(pg => base.add(pg));   // role floor — supers always keep these
  return base;
}
function pageForPath(p) {
  if (p === '/') return null;   // dashboard — open to every admin; supers get sent to /my
  if (p.startsWith('/projects') || p === '/reorder-projects') return 'projects';
  if (p.startsWith('/deliveries')) return 'deliveries';
  if (p.startsWith('/ordering')) return 'ordering';
  if (p.startsWith('/driving')) return 'driving';
  if (p.startsWith('/inventory') || p === '/stock-status') return 'inventory';
  if (p.startsWith('/catalog')) return 'catalog';
  if (p.startsWith('/requests')) return 'requests';
  if (p.startsWith('/request-materials')) return 'request_form';
  if (p.startsWith('/issues')) return 'issues';
  if (p.startsWith('/warranty-claims')) return 'warranty';
  if (p.startsWith('/delivery-notices')) return 'notices';
  if (p.startsWith('/suppliers')) return 'suppliers';
  if (p.startsWith('/subs') || p.startsWith('/sub-photo')) return 'subs';
  if (p.startsWith('/settings')) return 'settings';
  if (p.startsWith('/team')) return 'team';
  return null;
}
function firstAllowedPath(allowed) {
  for (const m of PAGE_META) if (allowed.has(m.key)) return m.path;
  return null;
}
// Login lookup: match by email OR a short username (first name).
function findSuperByLogin(login) {
  const l = String(login || '').trim().toLowerCase();
  return SUPERS.find(s => s.email.toLowerCase() === l || (s.username && s.username.toLowerCase() === l)) || null;
}
// A super's effective password hash: their own custom one if set, else the built-in default.
async function superPasswordHash(sup) {
  if (!sup) return null;
  try {
    const { rows: [r] } = await pool.query('SELECT password_hash FROM super_passwords WHERE email=$1', [sup.email]);
    if (r && r.password_hash) return r.password_hash;
  } catch (e) { /* table may not exist yet on first boot */ }
  return sup.passwordHash || null;
}
// An admin's custom password hash if they've set one (else null → use the built-in/env hash).
async function getAdminCustomHash(username) {
  try {
    const { rows: [r] } = await pool.query('SELECT password_hash FROM admin_passwords WHERE username=$1', [username]);
    return (r && r.password_hash) || null;
  } catch (e) { return null; }
}
// Which supers may view the Subcontractor directory (read-only). Bobby only.
const SUBS_SUPER_EMAILS = ['bobby@buildoly.com'];
function canSuperViewSubs(email) {
  return SUBS_SUPER_EMAILS.includes(String(email || '').trim().toLowerCase());
}
// Which supers may report on ALL projects (not just assigned ones). Bobby only.
const ALL_PROJECTS_SUPER_EMAILS = ['bobby@buildoly.com'];
function canSuperViewAllProjects(email) {
  return ALL_PROJECTS_SUPER_EMAILS.includes(String(email || '').trim().toLowerCase());
}
// Which supers may see the Warranty claims tab. Bobby (add Aziz's email here once he has a login).
const WARRANTY_SUPER_EMAILS = ['bobby@buildoly.com'];
function canSuperViewWarranty(email) {
  return WARRANTY_SUPER_EMAILS.includes(String(email || '').trim().toLowerCase());
}
// A project's super_email holds a comma-separated list (multiple supers per project).
function parseSuperEmails(str) {
  const set = String(str || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return allContacts().filter(s => set.includes(s.email.toLowerCase()));
}
// Editable super phone numbers (stored in DB, managed on the Settings page).
async function getSuperPhones() {
  try {
    const { rows } = await pool.query('SELECT email, phone FROM super_contacts');
    const m = {};
    for (const r of rows) m[String(r.email).toLowerCase()] = r.phone || '';
    return m;
  } catch (e) { return {}; }
}
// "On-site delivery contact" block for a project's assigned super(s), for outgoing emails.
async function deliveryContactHtml(project) {
  const sups = project ? parseSuperEmails(project.super_email) : [];
  if (!sups.length) return '';
  const phones = await getSuperPhones();
  const lines = sups.map(s => {
    const ph = phones[s.email.toLowerCase()];
    return escapeHtml(s.name) + (ph ? ' — ' + escapeHtml(ph) : '');
  });
  return `<p style="margin-top:14px"><strong>On-site delivery contact:</strong><br>${lines.join('<br>')}</p>`;
}

// Post a message to a Google Chat space via its incoming webhook URL.
// The &token=... is stored separately (CHAT_WEBHOOK_TOKEN) to avoid shell-quoting issues.
let CHAT_WEBHOOK_URL = process.env.CHAT_WEBHOOK_URL;
if (CHAT_WEBHOOK_URL && process.env.CHAT_WEBHOOK_TOKEN && !/[?&]token=/.test(CHAT_WEBHOOK_URL)) {
  CHAT_WEBHOOK_URL += (CHAT_WEBHOOK_URL.includes('?') ? '&' : '?') + 'token=' + process.env.CHAT_WEBHOOK_TOKEN;
}
// Short street address for chat headers: "4137 Milton Ave, Culver City, CA" -> "4137 Milton"
function shortAddress(addr) {
  let s = String(addr || '').split(',')[0].trim();
  s = s.replace(/\s+(ave|avenue|st|street|blvd|boulevard|dr|drive|ln|lane|rd|road|way|ct|court|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|parkway|sq|square|trl|trail)\.?$/i, '');
  return s.trim();
}
// Post to Google Chat. Pass a threadKey to group messages into one thread
// (e.g. an issue + its responses) — works in spaces that are organized by thread.
async function postToChat(text, threadKey) {
  if (CHAT_PAUSED) return;
  if (MAIL_REDIRECT_ALL) { return postBidsText('[TEST · would post to delivery chat]\n' + text, threadKey); }
  if (!CHAT_WEBHOOK_URL) { console.log('postToChat: no CHAT_WEBHOOK_URL set'); return; }
  try {
    let url = CHAT_WEBHOOK_URL;
    const body = { text };
    if (threadKey) {
      url += (url.includes('?') ? '&' : '?') + 'messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
      body.thread = { threadKey: String(threadKey) };
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
    });
    console.log('postToChat status:', r.status);
    if (!r.ok) console.log('postToChat error body:', (await r.text()).slice(0, 200));
  } catch (e) { console.error('postToChat:', e.message); }
}

// Create a Gmail draft (instead of sending) so the user can review/send from Gmail
async function createDraft({ to, cc, subject, text, html, attachments }) {
  if (!useGmail) throw new Error('Drafts require Gmail to be configured.');
  if (MAIL_REDIRECT_ALL) {
    const intended = [to, cc].filter(Boolean).join(', ') || '(no recipient)';
    subject = `[TEST → ${intended}] ${subject || ''}`;
    to = MAIL_REDIRECT_ALL; cc = undefined;
  }
  const recipients = parseRecipients(to);
  const ccList = parseRecipients(cc);
  const raw = buildRawMessage({ from: gmailUser, to: recipients.join(', '), cc: ccList.join(', ') || undefined, subject, text, html, attachments });
  const { data } = await gmailClient.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return { draftId: data.id, threadId: data.message && data.message.threadId, messageId: data.message && data.message.id };
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

// Schema DDL runs ONCE per process — not on every request (it was being awaited at the
// top of ~14 routes, re-running ~570 lines of CREATE/ALTER every page load → multi-second loads).
let _initDbPromise = null;
async function initDb() {
  if (_initDbPromise) return _initDbPromise;
  _initDbPromise = pool.query(`
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
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS finish_schedule_url TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS rec_lighting_source VARCHAR(20);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS range_hood_source VARCHAR(20);
    -- Doors (1a) stock toggles: 3-panel bifold is Buildoly stock by default;
    -- the sliding glass door is vendor-supplied by default.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS bifold_source VARCHAR(20);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS sliding_door_source VARCHAR(20);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS jedco_source VARCHAR(20);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS super_email TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS phase TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS warranty_started_at TIMESTAMPTZ;
    -- When each phase started ({"Pre-Construction":"2026-07-02", ...}) — drives the Order Planner
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS phase_dates JSONB DEFAULT '{}'::jsonb;
    -- Order Planner rules: when to place each material order, relative to a milestone
    CREATE TABLE IF NOT EXISTS order_rules (
      item_code VARCHAR(8) PRIMARY KEY,
      anchor TEXT NOT NULL DEFAULT 'construction',   -- 'precon' | 'construction'
      offset_weeks INTEGER NOT NULL DEFAULT 0,
      lead_note TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO order_rules (item_code, anchor, offset_weeks, lead_note) VALUES
      ('1a','precon',0,'2-4 week lead time - order as soon as pre-construction starts'),
      ('1b','construction',3,''),('1c','construction',4,''),('1d','construction',4,''),('1e','construction',4,''),
      ('2a','construction',6,''),('2b','construction',8,''),('2c','construction',8,''),('2d','construction',8,''),('2e','construction',8,''),
      ('3a','construction',10,''),('3b','construction',10,''),('3c','construction',10,''),('3d','construction',10,''),('3e','construction',10,'')
    ON CONFLICT (item_code) DO NOTHING;
    ALTER TABLE held_item_status ADD COLUMN IF NOT EXISTS delivered_qty INTEGER;
    ALTER TABLE project_items ADD COLUMN IF NOT EXISTS delivery_date_end DATE;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS sort_order INTEGER;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS referenced_by TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS recent_add BOOLEAN DEFAULT FALSE;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS reject_reason TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS bid_status VARCHAR(40);
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS bid_price VARCHAR(40);
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS licensed BOOLEAN;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_number VARCHAR(80);
    CREATE TABLE IF NOT EXISTS super_contacts (
      email TEXT PRIMARY KEY,
      phone TEXT
    );
    -- Added site contacts: extra supers + outsourced GCs, assignable as a job-site contact.
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      role VARCHAR(12) DEFAULT 'super',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS super_passwords (
      email TEXT PRIMARY KEY,
      password_hash TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Per-admin custom passwords (so admins can change their own from the Account tab)
    CREATE TABLE IF NOT EXISTS admin_passwords (
      username TEXT PRIMARY KEY,
      password_hash TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Team members Logan adds from the /team hub (dynamic office logins).
    CREATE TABLE IF NOT EXISTS team_logins (
      user_key TEXT PRIMARY KEY,
      name TEXT,
      password_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS material_requests (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      super_email TEXT,
      codes TEXT,
      note TEXT,
      needed_by DATE,
      fulfilled BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Material issues reported by superintendents (photo optional) → office inbox.
    CREATE TABLE IF NOT EXISTS material_issues (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      super_email TEXT,
      item_code VARCHAR(10),
      item_label TEXT,
      note TEXT,
      photo_data BYTEA,
      photo_mime TEXT,
      photo_name TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
    -- Office responses to an issue (also posted to the chat thread).
    CREATE TABLE IF NOT EXISTS material_issue_replies (
      id SERIAL PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES material_issues(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subcontractors (
      id SERIAL PRIMARY KEY,
      company TEXT, location TEXT, type TEXT, status TEXT,
      owner TEXT, email TEXT, phone TEXT, projects TEXT, notes TEXT,
      group_label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sub_photos (
      id SERIAL PRIMARY KEY,
      sub_id INTEGER REFERENCES subcontractors(id) ON DELETE CASCADE,
      filename TEXT, mime TEXT, data BYTEA,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Emails sent to a subcontractor (logged under each sub)
    CREATE TABLE IF NOT EXISTS sub_emails (
      id SERIAL PRIMARY KEY,
      sub_id INTEGER REFERENCES subcontractors(id) ON DELETE CASCADE,
      to_email TEXT, subject TEXT, body TEXT, sent_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Link each sub email to its Gmail thread so we can pull the sub's replies back
    -- into the log. direction: 'out' = we sent it, 'in' = the sub replied.
    ALTER TABLE sub_emails ADD COLUMN IF NOT EXISTS gmail_thread_id VARCHAR(255);
    ALTER TABLE sub_emails ADD COLUMN IF NOT EXISTS gmail_message_id VARCHAR(255);
    ALTER TABLE sub_emails ADD COLUMN IF NOT EXISTS direction VARCHAR(8) DEFAULT 'out';
    ALTER TABLE sub_emails ADD COLUMN IF NOT EXISTS from_email TEXT;
    ALTER TABLE sub_emails ADD COLUMN IF NOT EXISTS body_html TEXT;
    -- Per-sub "unread reply" badge state
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS reply_unread BOOLEAN DEFAULT false;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS replies_viewed_at TIMESTAMPTZ;
    -- QuickBooks ingester: every Intuit notification email we've already processed
    CREATE TABLE IF NOT EXISTS qb_seen (
      gmail_message_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Supplier directory (candidates found via the Supplier Finder — separate from
    -- the per-material RFQ contacts, which stay in the suppliers table)
    CREATE TABLE IF NOT EXISTS supplier_directory (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      address TEXT,
      rating TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- CSLB license verification results (License Watchdog)
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_status TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_expire DATE;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_classes TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_flags TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_business TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_checked_at TIMESTAMPTZ;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS license_report TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS ins_expires DATE;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS email_bounced_at TIMESTAMPTZ;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS email_bounce_note TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS ins_note TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS ins_checked_at TIMESTAMPTZ;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS ins_chased_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS item_catalog (
      id SERIAL PRIMARY KEY,
      prod_code VARCHAR(40) UNIQUE,
      item_role VARCHAR(120),
      category_code VARCHAR(4),
      brand VARCHAR(120),
      product_name TEXT,
      model_no VARCHAR(120),
      model_norm VARCHAR(120),
      finish VARCHAR(120),
      qty_default INTEGER DEFAULT 1,
      supplier VARCHAR(120),
      cost NUMERIC(12,2),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE item_catalog ADD COLUMN IF NOT EXISTS section VARCHAR(80);
    ALTER TABLE item_catalog ADD COLUMN IF NOT EXISTS subsection VARCHAR(80);
    ALTER TABLE item_catalog ADD COLUMN IF NOT EXISTS sheet_row INTEGER;
    ALTER TABLE item_catalog ADD COLUMN IF NOT EXISTS item_url TEXT;
    ALTER TABLE item_catalog ADD COLUMN IF NOT EXISTS alt_models TEXT;

    CREATE TABLE IF NOT EXISTS project_expected_items (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      prod_code VARCHAR(40),
      name TEXT,
      category_code VARCHAR(4),
      model_no VARCHAR(120),
      model_norm VARCHAR(120),
      qty INTEGER DEFAULT 1,
      supplier VARCHAR(120),
      synced_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ferg_order_seen (
      gmail_message_id VARCHAR(255) PRIMARY KEY,
      seen_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_bounces (
      gmail_message_id VARCHAR(255) PRIMARY KEY,
      recipient TEXT,
      orig_subject TEXT,
      sub_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_item_marks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      item_key TEXT,
      state VARCHAR(12),
      sched_when TEXT,
      marked_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (project_id, item_key)
    );

    CREATE TABLE IF NOT EXISTS project_order_lines (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      model_norm VARCHAR(120),
      prod_code VARCHAR(40),
      supplier VARCHAR(60) DEFAULT 'Ferguson',
      filename VARCHAR(255),
      gmail_message_id VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Per-item "ordered" marks from vendor order emails, keyed by the same item key the
    -- Materials checklist uses, so 📦 lights up on exactly the items ordered (not the category).
    CREATE TABLE IF NOT EXISTS project_item_orders (
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      item_key TEXT,
      ordered_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, item_key)
    );

    CREATE TABLE IF NOT EXISTS ferguson_updates (
      id SERIAL PRIMARY KEY,
      gmail_message_id VARCHAR(255) UNIQUE,
      kind VARCHAR(16),
      order_no VARCHAR(60),
      po VARCHAR(120),
      tracking VARCHAR(60),
      address TEXT,
      project_id INTEGER,
      scheduled_for VARCHAR(160),
      items TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE ferguson_updates ADD COLUMN IF NOT EXISTS applied VARCHAR(200);
    ALTER TABLE ferguson_updates ADD COLUMN IF NOT EXISTS order_base VARCHAR(40);
    ALTER TABLE ferguson_updates ADD COLUMN IF NOT EXISTS auto_done_at TIMESTAMPTZ;
    UPDATE ferguson_updates SET order_base = SPLIT_PART(order_no, '_', 1) WHERE order_base IS NULL AND order_no IS NOT NULL;

    CREATE TABLE IF NOT EXISTS delivery_confirms (
      id SERIAL PRIMARY KEY,
      project_item_id INTEGER,
      delivery_date DATE,
      supplier_email TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (project_item_id, delivery_date)
    );
    -- Log of branded delivery-notice emails sent to the on-site contact (for the
    -- "Last delivery" column on the Projects grid). Populated going forward.
    CREATE TABLE IF NOT EXISTS delivery_notices (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      method VARCHAR(12),
      codes TEXT,
      items TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Delivery notices waiting for the office to approve before they email the on-site
    -- contact. Ferguson triggers now queue here instead of auto-sending.
    CREATE TABLE IF NOT EXISTS pending_delivery_notices (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      codes TEXT,
      delivery_window TEXT,
      method VARCHAR(12),
      tracking TEXT,
      manifest_blob TEXT,
      except_blob TEXT,
      job_name TEXT,
      status VARCHAR(12) DEFAULT 'pending',
      source VARCHAR(12),
      source_date DATE,
      reminded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    );
    -- No DEFAULT on source: backfilling old pending rows as 'email' would wrongly arm reminders.
    ALTER TABLE pending_delivery_notices ADD COLUMN IF NOT EXISTS source VARCHAR(12);
    ALTER TABLE pending_delivery_notices ADD COLUMN IF NOT EXISTS source_date DATE;
    ALTER TABLE pending_delivery_notices ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
    ALTER TABLE pending_delivery_notices ADD COLUMN IF NOT EXISTS vendor_email_id INTEGER;

    CREATE TABLE IF NOT EXISTS bids (
      id SERIAL PRIMARY KEY,
      sub_id INTEGER REFERENCES subcontractors(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      amount NUMERIC,
      estimate_no VARCHAR(40),
      subject TEXT,
      job_hint TEXT,
      gmail_message_id VARCHAR(255),
      filename TEXT,
      gmail_attachment_id TEXT,
      status VARCHAR(24) DEFAULT 'received',
      auto_matched BOOLEAN DEFAULT FALSE,
      received_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE bids ADD COLUMN IF NOT EXISTS seen BOOLEAN DEFAULT FALSE;
    -- Files a sub attaches to a reply (license PDF, COI, insurance, photos). We store
    -- metadata + the Gmail ids and stream the bytes on demand via the attachment route.
    CREATE TABLE IF NOT EXISTS sub_email_attachments (
      id SERIAL PRIMARY KEY,
      sub_email_id INTEGER REFERENCES sub_emails(id) ON DELETE CASCADE,
      filename TEXT, mime TEXT, size INTEGER,
      gmail_message_id VARCHAR(255), gmail_attachment_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Office/warehouse stock counts (Buildoly Stock + JEDCO). Keyed by Prod. Code
    -- (or item name when no code). Demand is derived live from the finish schedules;
    -- we only persist the on-hand count the user maintains.
    CREATE TABLE IF NOT EXISTS inventory_counts (
      prod_key TEXT PRIMARY KEY,
      qty_on_hand INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS qty_on_order INTEGER NOT NULL DEFAULT 0;

    -- Manually-added office stock items (e.g. "Range Hood"). match_keyword decides
    -- which finish-schedule lines draw this item down (only when their supplier is
    -- held stock: Buildoly Stock / JEDCO).
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      match_keyword VARCHAR(200) NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS product VARCHAR(200);
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE inventory_items ALTER COLUMN match_keyword DROP NOT NULL;

    -- Office-stock status per held item per project (In Office / Delivered).
    -- item_key = Prod. Code / Model # / name of the schedule line.
    CREATE TABLE IF NOT EXISTS held_item_status (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'In Office',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, item_key)
    );
    -- Each purchase batch for an item (date, qty, price) — the dropdown history.
    CREATE TABLE IF NOT EXISTS inventory_purchases (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      qty INTEGER NOT NULL DEFAULT 0,
      unit_price NUMERIC(10,2),
      purchased_on DATE,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      attachment_name VARCHAR(255),
      attachment_mime VARCHAR(255),
      attachment_data BYTEA,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    );

    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS home_address VARCHAR(500);
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS emergency_phone VARCHAR(40);
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS warranty_doc_name VARCHAR(255);
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS warranty_doc_mime VARCHAR(255);
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS warranty_doc_data BYTEA;

    -- Client-facing warranty claims (submitted via the public /warranty page)
    CREATE TABLE IF NOT EXISTS warranty_claims (
      id SERIAL PRIMARY KEY,
      client_name TEXT,
      client_contact TEXT,
      project_address TEXT,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      rooms TEXT,
      description TEXT,
      status TEXT DEFAULT 'Open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS warranty_photos (
      id SERIAL PRIMARY KEY,
      claim_id INTEGER REFERENCES warranty_claims(id) ON DELETE CASCADE,
      mime TEXT, data BYTEA,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Permit tracking board (mirrors the Monday "Permits" board)
    CREATE TABLE IF NOT EXISTS permits (
      id SERIAL PRIMARY KEY,
      monday_id BIGINT,
      name TEXT, owner TEXT, adu_address TEXT,
      project_start TEXT, project_end TEXT, permit_start TEXT, permit_end TEXT,
      scope TEXT, soils TEXT, survey TEXT, sd TEXT, permit_set TEXT, eng TEXT,
      planning TEXT, dbs TEXT, fees TEXT, update_col TEXT, corrections TEXT,
      clearances TEXT, resub TEXT, rti TEXT, precon_mtg TEXT, client_verify TEXT, permit_issued TEXT,
      timeline_num INTEGER,
      grp TEXT DEFAULT 'Active Permits',
      sort_order INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Idle tracking for permit notifications
    ALTER TABLE permits ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ;
    ALTER TABLE permits ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
    UPDATE permits SET last_activity = COALESCE(last_activity, created_at, NOW()) WHERE last_activity IS NULL;
    -- Permit idle-notification settings (configured on the Permits → Notifications page)
    CREATE TABLE IF NOT EXISTS permit_notif (
      id INT PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN DEFAULT TRUE,
      idle_days INT DEFAULT 7,
      channel TEXT DEFAULT 'both',
      email_to TEXT,
      active_only BOOLEAN DEFAULT TRUE,
      last_run TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO permit_notif (id, email_to) VALUES (1, 'aziz@buildoly.com') ON CONFLICT (id) DO NOTHING;
    -- Per-box (per status column) notification rules + per-cell change/alert tracking
    ALTER TABLE permit_notif ADD COLUMN IF NOT EXISTS col_rules JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE permits ADD COLUMN IF NOT EXISTS cell_activity JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE permits ADD COLUMN IF NOT EXISTS cell_notified JSONB DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS driving_trips (
      id SERIAL PRIMARY KEY,
      trip_date DATE NOT NULL,
      route_text TEXT,
      miles NUMERIC(8,1),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE driving_trips ADD COLUMN IF NOT EXISTS owner TEXT;
    UPDATE driving_trips SET owner='logan' WHERE owner IS NULL;

    -- Per-user page permissions (managed in the Team hub by Logan)
    CREATE TABLE IF NOT EXISTS user_access (
      user_key TEXT PRIMARY KEY,
      pages TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Per-user home-dashboard choice (each person picks their own landing view)
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_key TEXT PRIMARY KEY,
      home_dashboard TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Per-user home/base address for the driving log (was a single global value)
    ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS home_address TEXT;
    INSERT INTO user_prefs (user_key, home_address)
      SELECT 'logan', home_address FROM app_settings WHERE id=1 AND home_address IS NOT NULL
      ON CONFLICT (user_key) DO UPDATE SET home_address = COALESCE(user_prefs.home_address, EXCLUDED.home_address);

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
    -- Every material category an email covers (CSV) — one thread can span several
    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS item_codes TEXT;
    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;
    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS has_unread BOOLEAN DEFAULT FALSE;
    -- Delivery-request threads waiting on the vendor's confirmed date; once their reply is parsed
    -- into an initial notice, notice_created flips true so we don't re-create it.
    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS awaiting_delivery_date BOOLEAN DEFAULT FALSE;
    ALTER TABLE vendor_emails ADD COLUMN IF NOT EXISTS notice_created BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS suppliers (
      item_code VARCHAR(10) PRIMARY KEY,
      supplier_name VARCHAR(255),
      supplier_email VARCHAR(255)
    );

    CREATE TABLE IF NOT EXISTS vendor_emails (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      item_code VARCHAR(10),
      item_codes TEXT,
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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      delivery_outcome VARCHAR(20)   -- ontime / late / wrong / missed (vendor reliability)
    );
    ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS delivery_outcome VARCHAR(20);

    CREATE TABLE IF NOT EXISTS vendor_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES vendor_orders(id) ON DELETE CASCADE,
      item_code VARCHAR(10)
    );

    CREATE TABLE IF NOT EXISTS vendor_order_lines (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES vendor_orders(id) ON DELETE CASCADE,
      item_code VARCHAR(10),
      product_code VARCHAR(100),
      description TEXT,
      qty NUMERIC(10,2),
      price NUMERIC(12,2)
    );

    ALTER TABLE project_items ADD COLUMN IF NOT EXISTS delivery_requested_at TIMESTAMPTZ;
    ALTER TABLE project_items ADD COLUMN IF NOT EXISTS order_date DATE;

    -- Indexes on the hot per-project lookup columns (queried on every page render).
    CREATE INDEX IF NOT EXISTS idx_project_items_pid ON project_items (project_id);
    CREATE INDEX IF NOT EXISTS idx_project_expected_pid ON project_expected_items (project_id);
    CREATE INDEX IF NOT EXISTS idx_project_item_marks_pid ON project_item_marks (project_id);
    CREATE INDEX IF NOT EXISTS idx_project_item_orders_pid ON project_item_orders (project_id);
    CREATE INDEX IF NOT EXISTS idx_project_order_lines_pid ON project_order_lines (project_id);
    CREATE INDEX IF NOT EXISTS idx_ferguson_updates_pid ON ferguson_updates (project_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_emails_pid ON vendor_emails (project_id);
    CREATE INDEX IF NOT EXISTS idx_material_requests_pid ON material_requests (project_id);
    CREATE INDEX IF NOT EXISTS idx_material_issues_pid ON material_issues (project_id);
    CREATE INDEX IF NOT EXISTS idx_sub_emails_sub ON sub_emails (sub_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_notices_pid ON delivery_notices (project_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_notices_pid_sent ON delivery_notices (project_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_held_item_status_pid ON held_item_status (project_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_orders_pid ON vendor_orders (project_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_order_items_oid ON vendor_order_items (order_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_order_lines_oid ON vendor_order_lines (order_id);
    CREATE INDEX IF NOT EXISTS idx_item_catalog_alt ON item_catalog (prod_code) WHERE alt_models IS NOT NULL AND alt_models <> '';
  `).catch(e => { _initDbPromise = null; throw e; });
  return _initDbPromise;
}

// Auto-create all item rows for a project — one batched INSERT (was 17 sequential round-trips)
async function ensureProjectItems(projectId) {
  const values = ALL_ITEMS.map((_, i) => `($1, $${i + 2})`).join(',');
  await pool.query(
    `INSERT INTO project_items (project_id, item_code) VALUES ${values} ON CONFLICT DO NOTHING`,
    [projectId, ...ALL_ITEMS.map(it => it.code)]
  );
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}
// Admin-only: blocks logged-in supers from the full app.
function requireAdmin(req, res, next) {
  if (req.session && req.session.authenticated && req.session.role !== 'super') return next();
  if (req.session && req.session.role === 'super') return res.redirect('/my');
  res.redirect('/login');
}
// Super portal access.
function requireSuper(req, res, next) {
  if (req.session && req.session.authenticated && req.session.role === 'super') return next();
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.redirect('/login');
}
// Global gate: a logged-in super may only reach their portal + logout (+ static is
// already served above). Everything else bounces to /my so they never see admin pages.
app.use((req, res, next) => {
  if (!req.session || !req.session.authenticated) return next();
  const key = sessionKey(req);
  if (key === 'logan') return next();   // Logan: full access, can't be restricted
  const p = req.path;
  if (p === '/logout' || p === '/login') return next();
  if (p === '/account' || p.startsWith('/account/')) return next();      // personal Account: everyone
  if (p.startsWith('/threads/messages/')) return next();                 // email-attachment downloads — ids only appear on pages the user can already see
  const isSuper = req.session.role === 'super';
  if (isSuper && (p === '/my' || p.startsWith('/my/'))) return next();   // supers keep their portal
  const area = pageForPath(p);
  if (area === 'team') return res.redirect(isSuper ? '/my' : '/');       // Team hub is Logan-only
  const allowed = allowedPagesFor(key, req.session.role);
  if (area && !allowed.has(area)) {
    return res.redirect(isSuper ? '/my' : (firstAllowedPath(allowed) || '/login'));
  }
  if (area === null && isSuper) return res.redirect('/my');              // supers stay locked to allowed pages
  // Send them straight to their one page instead.
  if (p === '/' && !isSuper && !allowed.has('projects')) {
    return res.redirect(firstAllowedPath(allowed) || '/login');
  }
  next();
});

// Expose pending counts to every admin page so the nav can show badges (Issues + Requests).
// Counts are fetched in ONE parallel batch and cached ~30s — they were 4 sequential DB
// round-trips on every single GET, which added noticeable latency to every page.
let _navCache = { at: 0, data: null };
app.use(async (req, res, next) => {
  if (req.method === 'GET' && req.session && req.session.authenticated) {
    const key = sessionKey(req);
    res.locals.isLogan = (key === 'logan');
    res.locals.isSuperNav = (req.session.role === 'super');   // supers get a "My Projects" link back to their portal
    res.locals.navPages = res.locals.isLogan ? '*' : [...allowedPagesFor(key, req.session.role)];
    if (req.session.role === 'admin') {
      try {
        if (!_navCache.data || (Date.now() - _navCache.at) > 30000) {
          const [pi, pr, ow, dn] = await Promise.all([
            getPendingIssueCount(), getPendingRequestCount(), getOpenWarrantyCount(), getPendingDeliveryNoticeCount(),
          ]);
          _navCache = { at: Date.now(), data: { pi, pr, ow, dn } };
        }
        res.locals.pendingIssues = _navCache.data.pi;
        res.locals.pendingRequests = _navCache.data.pr;
        res.locals.openWarranty = _navCache.data.ow;
        res.locals.pendingDeliveryNotices = _navCache.data.dn;
      } catch (e) { /* tables may not exist yet */ }
    }
  }
  next();
});

// ── Short-TTL page cache for the hottest pages ─────────────────────────────────
// Serves the rendered HTML from memory for a few seconds (per user, per URL), so
// bouncing between the grid and a project is instant. ANY write (POST/PUT/DELETE)
// clears the whole cache, so edits always show immediately.
const PAGE_CACHE_TTL_MS = 8000;
const _pageCache = new Map();   // `${user}|${url}` -> { at, body }
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    if (req.method !== 'HEAD' && req.method !== 'OPTIONS') _pageCache.clear();
    return next();
  }
  if (!req.session || !req.session.authenticated) return next();
  const p = req.path;
  const cacheable = p === '/' || p === '/projects' || /^\/projects\/\d+$/.test(p) || /^\/projects\/\d+\/checklist$/.test(p);
  if (!cacheable) return next();
  const key = sessionKey(req) + '|' + req.originalUrl;
  const hit = _pageCache.get(key);
  if (hit && (Date.now() - hit.at) < PAGE_CACHE_TTL_MS) {
    res.set('X-Page-Cache', 'hit');
    return res.type('html').send(hit.body);
  }
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (res.statusCode === 200 && typeof body === 'string' && body.startsWith('<')) {
      _pageCache.set(key, { at: Date.now(), body });
      if (_pageCache.size > 200) _pageCache.clear();   // tiny office app — crude but safe bound
    }
    return origSend(body);
  };
  next();
});

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect(req.session.role === 'super' ? '/my' : '/');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  // Admin (env account — Logan). Honor a custom password if Logan set one, else the env hash.
  if (username && username === process.env.ADMIN_USERNAME) {
    const loganHash = (await getAdminCustomHash('logan')) || process.env.ADMIN_PASSWORD_HASH || '';
    if (await bcrypt.compare(password || '', loganHash)) {
      req.session.authenticated = true; req.session.role = 'admin'; req.session.superEmail = null; req.session.userKey = 'logan';
      return res.redirect('/');
    }
  }
  // Additional admin accounts (CEO / ops manager) — full office access. Custom password if set, else built-in.
  const adm = findAdminByLogin(username);
  if (adm) {
    const admHash = (await getAdminCustomHash(adm.username)) || adm.passwordHash;
    if (await bcrypt.compare(password || '', admHash)) {
      req.session.authenticated = true; req.session.role = 'admin'; req.session.superEmail = null; req.session.userKey = adm.username;
      // Restricted office users land on their first allowed page; full-access admins get the dashboard
      const allowed = allowedPagesFor(adm.username, 'admin');
      const landing = (allowed.size < PAGE_KEYS.length) ? (firstAllowedPath(allowed) || '/') : '/';
      return res.redirect(landing);
    }
  }
  // Superintendent (logs in with their email or first-name username)
  const sup = findSuperByLogin(username);
  if (sup) {
    const hash = await superPasswordHash(sup);   // custom password if they set one, else the default
    if (hash && await bcrypt.compare(password || '', hash)) {
      req.session.authenticated = true; req.session.role = 'super'; req.session.superEmail = sup.email; req.session.userKey = sup.email;
      return res.redirect('/my');
    }
  }
  return res.render('login', { error: 'Invalid username or password.' });
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ── Superintendent portal (read-only: their projects + delivery status) ────────
app.get('/my', requireSuper, async (req, res) => {
  try {
    await initDb();
    const email = req.session.superEmail;
    const sup = findSuper(email) || { name: 'Super', email };
    const canAll = canSuperViewAllProjects(email);
    // Visible projects: all (Bobby) or just assigned (others)
    const { rows: allRows } = await pool.query(
      "SELECT id, address, full_address, overall_status, phase, super_email FROM projects ORDER BY address"
    );
    const isAssigned = p => parseSuperEmails(p.super_email).some(s => s.email.toLowerCase() === String(email).toLowerCase());
    const visible = canAll ? allRows : allRows.filter(isAssigned);
    visible.forEach(p => p.assigned = isAssigned(p));   // controls the Request-Material button
    const mine = visible;
    const DELIV = new Set(['Delivered', 'Delivered from Inv.']);
    const ids = mine.map(p => p.id);
    const itemsByProject = {};
    if (ids.length) {
      const { rows: items } = await pool.query(
        'SELECT project_id, item_code, status, delivery_date, delivery_date_end FROM project_items WHERE project_id = ANY($1::int[])', [ids]
      );
      const OUTSTANDING = new Set(['RFQ sent', 'Order Placed', 'In Inventory', 'Issue']);
      for (const it of items) {
        const delivered = DELIV.has(it.status);
        // Outstanding = anything moving (ordered / in inventory / scheduled / issue) but not delivered
        const outstanding = !delivered && (OUTSTANDING.has(it.status) || !!it.delivery_date);
        if (!delivered && !outstanding) continue;
        (itemsByProject[it.project_id] = itemsByProject[it.project_id] || []).push({
          name: CODE_NAME[it.item_code] || it.item_code,
          status: it.status, delivered: !!delivered,
          deliveryDate: it.delivery_date ? new Date(it.delivery_date) : null,
          deliveryDateEnd: it.delivery_date_end ? new Date(it.delivery_date_end) : null,
        });
      }
      for (const k of Object.keys(itemsByProject)) {
        itemsByProject[k].sort((a, b) => {
          if (a.delivered !== b.delivered) return a.delivered ? 1 : -1;   // scheduled first
          const ad = a.deliveryDate ? a.deliveryDate.getTime() : Infinity;
          const bd = b.deliveryDate ? b.deliveryDate.getTime() : Infinity;
          return ad - bd;
        });
      }
    }
    res.render('my-projects', { sup, projects: mine, itemsByProject, canViewSubs: canSuperViewSubs(email), canViewWarranty: canSuperViewWarranty(email), requested: req.query.requested === '1', issued: req.query.issued === '1', pw: req.query.pw || '' });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Super: change their own password
app.post('/my/password', requireSuper, async (req, res) => {
  try {
    await initDb();
    const sup = findSuper(req.session.superEmail);
    if (!sup) return res.redirect('/my');
    const { current, new1, new2 } = req.body;
    const hash = await superPasswordHash(sup);
    if (!hash || !(await bcrypt.compare(current || '', hash))) return res.redirect('/my/settings?pw=bad');
    if (!new1 || String(new1).length < 4) return res.redirect('/my/settings?pw=short');
    if (new1 !== new2) return res.redirect('/my/settings?pw=mismatch');
    const newHash = await bcrypt.hash(String(new1), 10);
    await pool.query(
      `INSERT INTO super_passwords (email, password_hash, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=NOW()`,
      [sup.email, newHash]
    );
    res.redirect('/my/settings?pw=ok');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ── Personal Account (every signed-in user: admins + supers) ──────────────────
app.get('/account', requireAuth, async (req, res) => {
  try {
    await initDb();
    const role = req.session.role === 'super' ? 'super' : 'admin';
    const key = sessionKey(req);
    let name = '', login = '', roleLabel = '', phone = '';
    if (role === 'super') {
      const sup = findSuper(req.session.superEmail) || { name: 'Super', email: req.session.superEmail };
      name = sup.name || 'Super'; login = sup.email || ''; roleLabel = 'Superintendent';
      try { const { rows: [c] } = await pool.query('SELECT phone FROM super_contacts WHERE email=$1', [sup.email]); phone = (c && c.phone) || ''; } catch (e) {}
    } else {
      if (key === 'logan') { name = 'Logan'; login = process.env.ADMIN_USERNAME || 'logan'; }
      else { const a = ADMINS.find(x => x.username === key); name = a ? a.name : key; login = key; }
      roleLabel = 'Admin';
    }
    const allowedSet = allowedPagesFor(key, role);
    const accessLabels = PAGE_META.filter(m => allowedSet.has(m.key)).map(m => m.label);
    const home = null;   // single dashboard now - no home-view picker
    res.render('account', { name, login, roleLabel, role, isLogan: key === 'logan', phone, accessLabels, home, pw: req.query.pw || '' });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Change my own password (admins → admin_passwords, supers → super_passwords)
app.post('/account/password', requireAuth, async (req, res) => {
  try {
    await initDb();
    const role = req.session.role === 'super' ? 'super' : 'admin';
    const key = sessionKey(req);
    const { current, new1, new2 } = req.body;
    if (!new1 || String(new1).length < 4) return res.redirect('/account?pw=short');
    if (new1 !== new2) return res.redirect('/account?pw=mismatch');
    const newHash = await bcrypt.hash(String(new1), 10);
    if (role === 'super') {
      const sup = findSuper(req.session.superEmail);
      if (!sup) return res.redirect('/account?pw=bad');
      const hash = await superPasswordHash(sup);
      if (!hash || !(await bcrypt.compare(current || '', hash))) return res.redirect('/account?pw=bad');
      await pool.query(
        `INSERT INTO super_passwords (email, password_hash, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=NOW()`,
        [sup.email, newHash]
      );
      return res.redirect('/account?pw=ok');
    }
    let curHash = '';
    if (key === 'logan') curHash = (await getAdminCustomHash('logan')) || process.env.ADMIN_PASSWORD_HASH || '';
    else { const a = ADMINS.find(x => x.username === key); curHash = (await getAdminCustomHash(key)) || (a ? a.passwordHash : ''); }
    if (!curHash || !(await bcrypt.compare(current || '', curHash))) return res.redirect('/account?pw=bad');
    await pool.query(
      `INSERT INTO admin_passwords (username, password_hash, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=NOW()`,
      [key, newHash]
    );
    return res.redirect('/account?pw=ok');
  } catch (err) { return res.redirect('/account?pw=bad'); }
});

// Super: settings page (change password, contact info)
app.get('/my/settings', requireSuper, async (req, res) => {
  try {
    await initDb();
    const email = req.session.superEmail;
    const sup = findSuper(email) || { name: 'Super', email };
    const { rows: [c] } = await pool.query('SELECT phone FROM super_contacts WHERE email=$1', [email]);
    res.render('my-settings', { sup, phone: (c && c.phone) || '', canViewSubs: canSuperViewSubs(email), pw: req.query.pw || '' });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Helper: is this super assigned to this project?
function superOwnsProject(email, project) {
  return project && parseSuperEmails(project.super_email).some(s => s.email.toLowerCase() === String(email).toLowerCase());
}

// Super: the "Request Material" form for one of their projects
app.get('/my/request/:id', requireSuper, async (req, res) => {
  try {
    await initDb();
    const email = req.session.superEmail;
    const { rows: [project] } = await pool.query('SELECT id, address, full_address, super_email, finish_schedule_url, rec_lighting_source, range_hood_source, bifold_source, sliding_door_source FROM projects WHERE id=$1', [req.params.id]);
    if (!superOwnsProject(email, project)) return res.redirect('/my');
    // Already-delivered items can't be requested again
    const { rows: pit } = await pool.query('SELECT item_code, status FROM project_items WHERE project_id=$1', [req.params.id]);
    const deliveredCodes = pit.filter(r => ['Delivered', 'Delivered from Inv.'].includes(r.status)).map(r => r.item_code);
    // Schedule items per category — so each row can "Expand" to show what's in that delivery
    let byCode = {};
    if (project.finish_schedule_url) {
      try { byCode = await readScheduleByCategory(project.finish_schedule_url, { recSource: project.rec_lighting_source, rangeHoodSource: project.range_hood_source, bifoldSource: project.bifold_source, slidingSource: project.sliding_door_source }); }
      catch (e) { byCode = {}; }
    }
    res.render('my-request', { project, STAGES, sup: findSuper(email) || { name: 'Super' }, err: req.query.err === '1', delivered: deliveredCodes, byCode });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Super: submit a material request → store + ping the office in chat
app.post('/my/request/:id', requireSuper, async (req, res) => {
  try {
    await initDb();
    const email = req.session.superEmail;
    const { rows: [project] } = await pool.query('SELECT id, address, super_email FROM projects WHERE id=$1', [req.params.id]);
    if (!superOwnsProject(email, project)) return res.redirect('/my');
    const valid = new Set(ALL_ITEMS.map(i => i.code));
    const codes = [].concat(req.body.codes || []).filter(c => valid.has(c));
    if (!codes.length) return res.redirect('/my/request/' + project.id + '?err=1');
    const note = String(req.body.note || '').trim().slice(0, 500);
    const neededBy = String(req.body.needed_by || '').trim() || null;
    const { rows: [reqRow] } = await pool.query(
      'INSERT INTO material_requests (project_id, super_email, codes, note, needed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [project.id, email, codes.join(','), note || null, neededBy]
    );
    // Reflect the request on the project: bump each item's stage to "Delivery Requested"
    // (only if nothing's happened yet — never override an order already in motion or delivered)
    for (const c of codes) await pool.query('INSERT INTO project_items (project_id, item_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [project.id, c]);
    await pool.query(
      `UPDATE project_items SET status='Delivery Requested'
       WHERE project_id=$1 AND item_code = ANY($2) AND (status IS NULL OR status='' OR status='Not yet placed')`,
      [project.id, codes]
    );
    const sup = findSuper(email) || { name: email };
    const names = codes.map(c => CODE_NAME[c] || c);
    const LOGAN = '106404376271648731086';
    const lines = [`📥 *Material request* <users/${LOGAN}>`, `*${shortAddress(project.address)}* — ${sup.name}`, `Needs: ${names.join(', ')}`];
    if (neededBy) { const d = neededBy.split('-').map(Number); lines.push('Needed by: ' + (d.length === 3 ? new Date(d[0], d[1] - 1, d[2]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : neededBy)); }
    if (note) lines.push('Note: ' + note);
    postBidsText(lines.join('\n'), 'request-' + reqRow.id, true);   // ping Logan's private Bids chat, even while chat is paused
    res.redirect('/my?requested=1');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Request Materials (office form — grantable on the Team page) ───────────────
// The same form supers fill out, for office users granted the 'request_form' page.
// They can request on ANY project; requests land in the same office inbox + chat ping.
app.get('/request-materials', requireAuth, async (req, res) => {
  try {
    const { rows: projects } = await pool.query(
      "SELECT id, address, full_address, phase FROM projects WHERE COALESCE(phase,'') NOT IN ('Complete','Under Warranty') ORDER BY address");
    res.render('request-materials', { projects, requested: req.query.requested === '1' });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
app.get('/request-materials/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT id, address, full_address, super_email, finish_schedule_url, rec_lighting_source, range_hood_source, bifold_source, sliding_door_source FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.redirect('/request-materials');
    const { rows: pit } = await pool.query('SELECT item_code, status FROM project_items WHERE project_id=$1', [req.params.id]);
    const deliveredCodes = pit.filter(r => ['Delivered', 'Delivered from Inv.'].includes(r.status)).map(r => r.item_code);
    let byCode = {};
    if (project.finish_schedule_url) {
      try { byCode = await readScheduleByCategory(project.finish_schedule_url, { recSource: project.rec_lighting_source, rangeHoodSource: project.range_hood_source, bifoldSource: project.bifold_source, slidingSource: project.sliding_door_source }); }
      catch (e) { byCode = {}; }
    }
    const key = sessionKey(req);
    const who = (findAdminByLogin(key) || {}).name || (findSuper(key) || {}).name || key;
    res.render('my-request', { project, STAGES, sup: { name: who }, err: req.query.err === '1', delivered: deliveredCodes, byCode, basePath: '/request-materials', backPath: '/request-materials', backLabel: '← All projects' });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
app.post('/request-materials/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT id, address, super_email FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.redirect('/request-materials');
    const valid = new Set(ALL_ITEMS.map(i => i.code));
    const codes = [].concat(req.body.codes || []).filter(c => valid.has(c));
    if (!codes.length) return res.redirect('/request-materials/' + project.id + '?err=1');
    const note = String(req.body.note || '').trim().slice(0, 500);
    const neededBy = String(req.body.needed_by || '').trim() || null;
    const key = sessionKey(req);
    const who = (findAdminByLogin(key) || {}).name || (findSuper(key) || {}).name || key;
    const { rows: [reqRow] } = await pool.query(
      'INSERT INTO material_requests (project_id, super_email, codes, note, needed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [project.id, who, codes.join(','), note || null, neededBy]
    );
    for (const c of codes) await pool.query('INSERT INTO project_items (project_id, item_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [project.id, c]);
    await pool.query(
      `UPDATE project_items SET status='Delivery Requested'
       WHERE project_id=$1 AND item_code = ANY($2) AND (status IS NULL OR status='' OR status='Not yet placed')`,
      [project.id, codes]
    );
    const names = codes.map(c => CODE_NAME[c] || c);
    const LOGAN = '106404376271648731086';
    const lines = [`📥 *Material request* <users/${LOGAN}>`, `*${shortAddress(project.address)}* — ${who}`, `Needs: ${names.join(', ')}`];
    if (neededBy) { const d = neededBy.split('-').map(Number); lines.push('Needed by: ' + (d.length === 3 ? new Date(d[0], d[1] - 1, d[2]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : neededBy)); }
    if (note) lines.push('Note: ' + note);
    postBidsText(lines.join('\n'), 'request-' + reqRow.id, true);   // ping Logan's private chat, even while chat is paused
    res.redirect('/request-materials?requested=1');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Super: report a material issue (with optional photo) — form
app.get('/my/issue/:id', requireSuper, async (req, res) => {
  try {
    await initDb();
    const email = req.session.superEmail;
    // Bobby can report on ANY project; other supers only on their assigned ones
    const { rows: [project] } = await pool.query('SELECT id, address, full_address, super_email, finish_schedule_url, rec_lighting_source, range_hood_source, jedco_source, bifold_source, sliding_door_source FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.redirect('/my');
    if (!canSuperViewAllProjects(email) && !superOwnsProject(email, project)) return res.redirect('/my');
    let byCode = {};
    if (project.finish_schedule_url) {
      try { byCode = await readScheduleByCategory(project.finish_schedule_url, { recSource: project.rec_lighting_source, rangeHoodSource: project.range_hood_source, jedcoSource: project.jedco_source, bifoldSource: project.bifold_source, slidingSource: project.sliding_door_source }); }
      catch (e) { byCode = {}; }
    }
    res.render('my-issue', { project, STAGES, sup: findSuper(email) || { name: 'Super' }, err: req.query.err === '1', byCode });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Super: submit a material issue → store (+ photo) and ping the office
app.post('/my/issue/:id', requireSuper, upload.single('photo'), async (req, res) => {
  try {
    await initDb();
    const email = req.session.superEmail;
    const { rows: [project] } = await pool.query('SELECT id, address, super_email FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.redirect('/my');
    if (!canSuperViewAllProjects(email) && !superOwnsProject(email, project)) return res.redirect('/my');   // non-Bobby: assigned only
    const note = String(req.body.note || '').trim().slice(0, 1000);
    const valid = new Set(ALL_ITEMS.map(i => i.code));
    // Multi-select: the form sends a JSON list of {code,label}. (Fall back to the old single fields.)
    let selected = [];
    try { selected = JSON.parse(req.body.selected || '[]'); } catch (e) {}
    if (!Array.isArray(selected)) selected = [];
    if (!selected.length && (req.body.item_code || req.body.item_label)) selected = [{ code: req.body.item_code, label: req.body.item_label }];
    selected = selected
      .map(s => ({ code: valid.has(s && s.code) ? s.code : null, label: String((s && s.label) || '').trim().slice(0, 200) || null }))
      .filter(s => s.code || s.label);
    // Need at least one item, a description, or a photo
    if (!selected.length && !note && !req.file) return res.redirect('/my/issue/' + project.id + '?err=1');
    if (!selected.length) selected.push({ code: null, label: null });   // general issue, no specific item
    const photo = req.file ? { data: req.file.buffer, mime: req.file.mimetype, name: req.file.originalname } : {};
    const ids = [];
    for (const s of selected) {
      const { rows: [issue] } = await pool.query(
        `INSERT INTO material_issues (project_id, super_email, item_code, item_label, note, photo_data, photo_mime, photo_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [project.id, email, s.code, s.label, note || null, photo.data || null, photo.mime || null, photo.name || null]
      );
      ids.push(issue.id);
      if (s.code) {   // flag that item's stage as "Issue" (unless delivered / N/A)
        await pool.query('INSERT INTO project_items (project_id, item_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [project.id, s.code]);
        await pool.query(`UPDATE project_items SET status='Issue' WHERE project_id=$1 AND item_code=$2 AND status NOT IN ('Delivered','Delivered from Inv.','N/A')`, [project.id, s.code]);
      }
    }
    const sup = findSuper(email) || { name: email };
    const what = selected.map(s => s.label || (s.code ? (CODE_NAME[s.code] || s.code) : null)).filter(Boolean).join(', ') || 'a material';
    const LOGAN = '106404376271648731086';
    const lines = [`⚠️ *Material issue* <users/${LOGAN}>`, `*${shortAddress(project.address)}* — ${sup.name}`, `Item${selected.length > 1 ? 's' : ''}: ${what}`];
    if (note) lines.push('Issue: ' + note);
    if (req.file) lines.push('📷 Photo attached (see Issues inbox)');
    postToChat(lines.join('\n'), 'issue-' + ids[0]);
    res.redirect('/my?issued=1');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Admin: material-issue inbox ───────────────────────────────────────────────
async function getPendingIssueCount() {
  try { const { rows: [r] } = await pool.query("SELECT COUNT(*) c FROM material_issues WHERE status='pending'"); return Number(r.c) || 0; }
  catch (e) { return 0; }
}
async function getPendingDeliveryNoticeCount() {
  try { const { rows: [r] } = await pool.query("SELECT COUNT(*) c FROM pending_delivery_notices WHERE status='pending'"); return Number(r.c) || 0; }
  catch (e) { return 0; }
}

// ── Delivery-notice approval queue ─────────────────────────────────────────────
// Ferguson triggers queue a notice here; the office previews and approves before it
// emails the on-site contact (and, for truck deliveries, pings them in chat).
app.get('/delivery-notices', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows } = await pool.query(
      `SELECT n.*, p.address, p.super_email
         FROM pending_delivery_notices n LEFT JOIN projects p ON p.id = n.project_id
        WHERE n.status='pending' ORDER BY n.created_at DESC`);
    const _cn = {}; STAGES.forEach(g => g.items.forEach(it => _cn[it.code] = it.name));
    const notices = rows.map(n => {
      const codes = String(n.codes || '').split(',').map(c => c.trim()).filter(Boolean);
      const sups = parseSuperEmails(n.super_email);
      return {
        id: n.id, address: n.address || ('Project ' + n.project_id),
        jobName: n.job_name || n.address || ('Project ' + n.project_id),
        method: n.method, window: n.delivery_window, tracking: n.tracking, createdAt: n.created_at,
        sourceDate: n.source_date ? new Date(n.source_date).toISOString().slice(0, 10) : '',
        codeLabels: codes.map(c => _cn[c] || c),
        recipients: sups.filter(s => s.email).map(s => s.name),
        noRecipient: !sups.some(s => s.email),
      };
    });
    // Delivery requests still waiting on the vendor's date (no parseable reply yet).
    const { rows: awaitRows } = await pool.query(
      `SELECT v.id, v.project_id, v.subject, v.supplier_name, v.supplier_email, v.item_codes, v.item_code,
              v.sent_at, v.has_unread, p.address, p.full_address
         FROM vendor_emails v LEFT JOIN projects p ON p.id = v.project_id
        WHERE v.awaiting_delivery_date=true AND v.notice_created=false
        ORDER BY v.has_unread DESC, v.sent_at DESC`);
    const awaiting = awaitRows.map(v => {
      const codes = String(v.item_codes || v.item_code || '').split(',').map(c => c.trim()).filter(Boolean);
      return {
        id: v.id, jobName: shortAddress(v.full_address || v.address) || ('Project ' + v.project_id),
        vendor: v.supplier_name || v.supplier_email || 'vendor', hasReply: !!v.has_unread,
        codeLabels: codes.map(c => _cn[c] || c), sentAt: v.sent_at,
      };
    });
    res.render('delivery-notices', { notices, awaiting });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
// Manually create the initial notice for an awaiting delivery request (parser couldn't read the
// reply, or Logan got the date by text/phone). He supplies the confirmed date; it queues for review.
app.post('/delivery-notices/awaiting/:id/create', requireAuth, async (req, res) => {
  try {
    const { date } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ ok: false, error: 'Enter a valid date.' });
    const { rows: [v] } = await pool.query('SELECT * FROM vendor_emails WHERE id=$1 AND awaiting_delivery_date=true AND notice_created=false', [req.params.id]);
    if (!v) return res.status(404).json({ ok: false, error: 'Not found or already handled.' });
    const codes = String(v.item_codes || v.item_code || '').split(',').map(c => c.trim()).filter(Boolean);
    if (!codes.length) return res.status(400).json({ ok: false, error: 'This thread has no linked materials.' });
    const q = await enqueueDeliveryNotice({ projectId: v.project_id, codes, window: chatDate(date), method: 'truck', source: 'email', sourceDate: date, vendorEmailId: v.id });
    if (!q.ok) return res.json({ ok: false, error: q.reason || 'Could not create the notice.' });
    // Board date is written on approval, not here (so an unreviewed notice never mutates it).
    await pool.query('UPDATE vendor_emails SET notice_created=true, awaiting_delivery_date=false WHERE id=$1', [v.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// Stop watching an awaiting delivery request (e.g. cancelled) without creating a notice.
app.post('/delivery-notices/awaiting/:id/dismiss', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE vendor_emails SET awaiting_delivery_date=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get('/delivery-notices/:id/preview', requireAuth, async (req, res) => {
  try {
    const { rows: [n] } = await pool.query("SELECT * FROM pending_delivery_notices WHERE id=$1 AND status='pending'", [req.params.id]);
    if (!n) return res.status(404).json({ ok: false, error: 'Not found or already handled.' });
    const codes = String(n.codes || '').split(',').map(c => c.trim()).filter(Boolean);
    const b = await buildDeliveryNotice({ projectId: n.project_id, codes, window: n.delivery_window, method: n.method, tracking: n.tracking, manifestBlob: n.manifest_blob, exceptBlob: n.except_blob });
    if (!b.ok) return res.json({ ok: false, error: b.reason || 'Could not build the notice.' });
    res.json({ ok: true, subject: b.subject, html: b.html, to: b.recipients });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// Let Logan correct the method / tracking / window on a queued notice before approving,
// so the email is exactly right (the auto path defaults to truck with no tracking).
app.post('/delivery-notices/:id/update', requireAuth, async (req, res) => {
  try {
    const { method, tracking, window, date } = req.body;
    const m = method === 'ups' ? 'ups' : 'truck';
    const sd = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null;   // confirmed delivery date drives the reminder
    const r = await pool.query(
      "UPDATE pending_delivery_notices SET method=$1, tracking=$2, delivery_window=$3, source_date=COALESCE($4, source_date) WHERE id=$5 AND status='pending' RETURNING id",
      [m, tracking || null, window || null, sd, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Not found or already handled.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/delivery-notices/:id/approve', requireAuth, async (req, res) => {
  try {
    // Atomically claim the row so a double-submit / two operators can't send twice.
    const { rows: [n] } = await pool.query("UPDATE pending_delivery_notices SET status='sending' WHERE id=$1 AND status='pending' RETURNING *", [req.params.id]);
    if (!n) return res.status(404).json({ ok: false, error: 'Not found or already handled.' });
    const codes = String(n.codes || '').split(',').map(c => c.trim()).filter(Boolean);
    const dn = await sendDeliveryNotice({ projectId: n.project_id, codes, window: n.delivery_window, method: n.method, tracking: n.tracking, manifestBlob: n.manifest_blob, exceptBlob: n.except_blob });
    if (!dn || !dn.ok) {
      await pool.query("UPDATE pending_delivery_notices SET status='pending' WHERE id=$1", [n.id]);  // release so it can be retried/rejected
      return res.json({ ok: false, error: (dn && dn.reason) || 'Could not send the notice.' });
    }
    await pool.query("UPDATE pending_delivery_notices SET status='sent', decided_at=NOW() WHERE id=$1", [n.id]);
    // Now that Logan approved it, write the confirmed date onto the board (never on an unreviewed parse).
    if (n.source_date) { try { await pool.query("UPDATE project_items SET delivery_date=$3 WHERE project_id=$1 AND item_code = ANY($2) AND status NOT IN ('Delivered','Delivered from Inv.','N/A')", [n.project_id, codes, n.source_date]); } catch (e) {} }
    if (n.method === 'truck') { try { await postDeliveryScheduled(n.project_id, dn.jobName); } catch (e) {} }  // now ping the super in chat
    res.json({ ok: true, to: dn.to });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/delivery-notices/:id/reject', requireAuth, async (req, res) => {
  try {
    const r = await pool.query("UPDATE pending_delivery_notices SET status='rejected', decided_at=NOW() WHERE id=$1 AND status='pending' RETURNING vendor_email_id", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Not found or already handled.' });
    // Re-arm the source thread so a corrected vendor reply can be re-parsed (a wrong date is recoverable).
    if (r.rows[0].vendor_email_id) { try { await pool.query('UPDATE vendor_emails SET awaiting_delivery_date=true, notice_created=false WHERE id=$1', [r.rows[0].vendor_email_id]); } catch (e) {} }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/issues', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows } = await pool.query(`
      SELECT mi.id, mi.project_id, mi.super_email, mi.item_code, mi.item_label, mi.note,
             mi.status, mi.created_at, mi.resolved_at, (mi.photo_data IS NOT NULL) AS has_photo,
             p.address
      FROM material_issues mi LEFT JOIN projects p ON p.id = mi.project_id
      ORDER BY (mi.status='pending') DESC, mi.created_at DESC`);
    const { rows: replyRows } = await pool.query('SELECT id, issue_id, body, created_at FROM material_issue_replies ORDER BY created_at ASC');
    const repliesByIssue = {};
    for (const rep of replyRows) (repliesByIssue[rep.issue_id] = repliesByIssue[rep.issue_id] || []).push(rep);
    const issues = rows.map(r => ({
      ...r,
      superName: (findSuper(r.super_email) || {}).name || r.super_email || 'Super',
      itemName: r.item_code ? (CODE_NAME[r.item_code] || r.item_code) : (r.item_label || ''),
      replies: repliesByIssue[r.id] || [],
    }));
    res.render('issues', { issues, pendingIssues: issues.filter(i => i.status === 'pending').length });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Serve an issue photo
app.get('/issues/:id/photo', requireAuth, async (req, res) => {
  try {
    const { rows: [r] } = await pool.query('SELECT photo_data, photo_mime, photo_name FROM material_issues WHERE id=$1', [req.params.id]);
    if (!r || !r.photo_data) return res.status(404).send('No photo.');
    res.setHeader('Content-Type', r.photo_mime || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${(r.photo_name || 'photo').replace(/[^\w.\- ]/g, '_')}"`);
    res.send(r.photo_data);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Resolve / reopen an issue
app.post('/issues/:id/resolve', requireAuth, async (req, res) => {
  try {
    const reopen = req.body.action === 'reopen';
    if (reopen) await pool.query("UPDATE material_issues SET status='pending', resolved_at=NULL WHERE id=$1", [req.params.id]);
    else await pool.query("UPDATE material_issues SET status='resolved', resolved_at=NOW() WHERE id=$1", [req.params.id]);
    res.json({ ok: true, status: reopen ? 'pending' : 'resolved' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Respond to an issue → log it + post into the issue's chat thread
app.post('/issues/:id/respond', requireAuth, async (req, res) => {
  try {
    const body = String(req.body.body || '').trim().slice(0, 1000);
    if (!body) return res.status(400).json({ ok: false, error: 'Write a response first.' });
    const { rows: [iss] } = await pool.query(
      `SELECT mi.id, mi.item_code, mi.item_label, mi.super_email, p.address
       FROM material_issues mi LEFT JOIN projects p ON p.id = mi.project_id WHERE mi.id=$1`, [req.params.id]);
    if (!iss) return res.status(404).json({ ok: false, error: 'Issue not found.' });
    await pool.query('INSERT INTO material_issue_replies (issue_id, body) VALUES ($1,$2)', [req.params.id, body]);
    const what = iss.item_code ? (CODE_NAME[iss.item_code] || iss.item_code) : (iss.item_label || 'material issue');
    const sup = findSuper(iss.super_email);
    const mention = sup && sup.chatId ? `<users/${sup.chatId}> ` : '';   // @ the super who opened the ticket
    const lines = [`💬 *Office response* — ${shortAddress(iss.address || '')} (${what})`, mention + body];
    postToChat(lines.join('\n'), 'issue-' + iss.id);   // same thread key as the original issue
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete an issue
app.post('/issues/:id/delete', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM material_issues WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Admin: material-request inbox (supers' "Request Material" submissions) ─────
async function getPendingRequestCount() {
  try { const { rows: [r] } = await pool.query('SELECT COUNT(*) c FROM material_requests WHERE fulfilled = FALSE'); return Number(r.c) || 0; }
  catch (e) { return 0; }
}
// Mark a project's pending requests fulfilled once all their items are delivered
async function autoFulfillRequests(projectId) {
  try {
    const { rows: reqs } = await pool.query('SELECT id, codes FROM material_requests WHERE project_id=$1 AND fulfilled=FALSE', [projectId]);
    if (!reqs.length) return;
    const { rows: pit } = await pool.query('SELECT item_code, status FROM project_items WHERE project_id=$1', [projectId]);
    const delivered = new Set(pit.filter(i => ['Delivered', 'Delivered from Inv.'].includes(i.status)).map(i => i.item_code));
    for (const r of reqs) {
      const codes = String(r.codes || '').split(',').map(c => c.trim()).filter(Boolean);
      if (codes.length && codes.every(c => delivered.has(c))) await pool.query('UPDATE material_requests SET fulfilled=TRUE WHERE id=$1', [r.id]);
    }
  } catch (e) { /* non-fatal */ }
}

app.get('/requests', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows } = await pool.query(`
      SELECT mr.id, mr.project_id, mr.super_email, mr.codes, mr.note, mr.needed_by,
             mr.fulfilled, mr.created_at, p.address
      FROM material_requests mr LEFT JOIN projects p ON p.id = mr.project_id
      ORDER BY (mr.fulfilled = FALSE) DESC, mr.created_at DESC`);
    // Pull live item statuses from the projects involved
    const projIds = [...new Set(rows.map(r => r.project_id).filter(Boolean))];
    const statusMap = {};
    if (projIds.length) {
      const { rows: pit } = await pool.query('SELECT project_id, item_code, status FROM project_items WHERE project_id = ANY($1::int[])', [projIds]);
      pit.forEach(i => { statusMap[i.project_id + ':' + i.item_code] = i.status; });
    }
    const DELIV = new Set(['Delivered', 'Delivered from Inv.']);
    const requests = rows.map(r => {
      const codes = String(r.codes || '').split(',').map(c => c.trim()).filter(Boolean);
      const items = codes.map(c => ({ code: c, name: CODE_NAME[c] || c, status: statusMap[r.project_id + ':' + c] || 'Not yet placed' }));
      const allDelivered = items.length > 0 && items.every(it => DELIV.has(it.status));
      return {
        ...r,
        superName: (findSuper(r.super_email) || {}).name || r.super_email || 'Super',
        items, allDelivered,
      };
    });
    // Auto-fulfill any pending request whose items are now all delivered
    for (const r of requests) {
      if (!r.fulfilled && r.allDelivered) {
        await pool.query('UPDATE material_requests SET fulfilled=TRUE WHERE id=$1', [r.id]);
        r.fulfilled = true;
      }
    }
    res.render('requests', { requests, pendingRequests: requests.filter(r => !r.fulfilled).length });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Mark a request fulfilled / reopen it
app.post('/requests/:id/fulfill', requireAuth, async (req, res) => {
  try {
    const reopen = req.body.action === 'reopen';
    await pool.query('UPDATE material_requests SET fulfilled=$1 WHERE id=$2', [!reopen, req.params.id]);
    res.json({ ok: true, fulfilled: !reopen });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Reply to a request → ping the super who asked, in chat
app.post('/requests/:id/respond', requireAuth, async (req, res) => {
  try {
    const body = String(req.body.body || '').trim().slice(0, 1000);
    if (!body) return res.status(400).json({ ok: false, error: 'Write a response first.' });
    const { rows: [r] } = await pool.query(
      'SELECT mr.super_email, p.address FROM material_requests mr LEFT JOIN projects p ON p.id = mr.project_id WHERE mr.id=$1', [req.params.id]);
    if (!r) return res.status(404).json({ ok: false, error: 'Request not found.' });
    const sup = findSuper(r.super_email);
    const mention = sup && sup.chatId ? `<users/${sup.chatId}> ` : '';
    postToChat(`📦 *Office update* — ${shortAddress(r.address || '')}\n${mention}${body}`, 'request-' + req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/requests/:id/delete', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM material_requests WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Projects list ─────────────────────────────────────────────────────────────

// ── Dashboard (home) ──────────────────────────────────────────────────────────
app.get('/', requireAuth, async (req, res) => {
  try {
    await initDb();
    const _key = sessionKey(req);
    let displayName = '';
    if (_key === 'logan') displayName = 'Logan';
    else { const a = ADMINS.find(x => x.username === _key); if (a) displayName = (a.name || '').split(' ')[0]; }


    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE overall_status='In Progress') AS in_progress,
        COUNT(*) FILTER (WHERE overall_status='All Delivered' OR overall_status='Fully Delivered') AS delivered,
        COUNT(*) FILTER (WHERE overall_status='Not Yet') AS not_yet,
        COUNT(*) AS total
      FROM projects
    `);
    const pendingRequests = await getPendingRequestCount();
    const pendingIssues = await getPendingIssueCount();
    const openWarranty = await getOpenWarrantyCount();

    // Most recent open items for each "needs attention" lane
    const { rows: recentRequests } = await pool.query(`
      SELECT mr.id, mr.super_email, mr.codes, mr.needed_by, mr.created_at, p.address
      FROM material_requests mr LEFT JOIN projects p ON p.id = mr.project_id
      WHERE mr.fulfilled = FALSE ORDER BY mr.created_at DESC LIMIT 5`);
    const { rows: recentIssues } = await pool.query(`
      SELECT mi.id, mi.super_email, mi.item_label, mi.note, mi.created_at, p.address
      FROM material_issues mi LEFT JOIN projects p ON p.id = mi.project_id
      WHERE mi.status = 'pending' ORDER BY mi.created_at DESC LIMIT 5`);
    const { rows: recentWarranty } = await pool.query(`
      SELECT wc.id, wc.client_name, wc.rooms, wc.created_at,
             COALESCE(p.address, wc.project_address) AS address
      FROM warranty_claims wc LEFT JOIN projects p ON p.id = wc.project_id
      WHERE wc.status <> 'Resolved' ORDER BY wc.created_at DESC LIMIT 5`);

    const supByEmail = {};
    SUPERS.forEach(s => supByEmail[s.email] = s.name);
    const nm = (e) => supByEmail[e] || String(e || '').split('@')[0] || 'Super';
    recentRequests.forEach(r => { r.who = nm(r.super_email); r.codeCount = String(r.codes || '').split(',').map(c => c.trim()).filter(Boolean).length; });
    recentIssues.forEach(r => r.who = nm(r.super_email));

    // Active-project snapshot (read-only; full editable grid lives at /projects)
    const { rows: projects } = await pool.query(
      `SELECT * FROM projects ORDER BY sort_order ASC NULLS LAST, created_at ASC`);
    const projectIds = projects.map(p => p.id);
    const itemMaps = {};
    if (projectIds.length) {
      const { rows: allItems } = await pool.query(
        `SELECT project_id, item_code, status FROM project_items WHERE project_id = ANY($1)`, [projectIds]);
      allItems.forEach(it => { (itemMaps[it.project_id] = itemMaps[it.project_id] || {})[it.item_code] = it; });
    }
    const { rows: unreadRows } = await pool.query('SELECT DISTINCT project_id FROM vendor_emails WHERE has_unread=true');
    const unread = {}; unreadRows.forEach(r => unread[r.project_id] = true);
    const DELIVERED = new Set(['Delivered', 'Delivered from Inv.']);
    const projCards = projects
      .filter(p => p.overall_status !== 'Fully Delivered')
      .map(p => {
        const codes = Object.values(itemMaps[p.id] || {});
        const total = codes.length;
        const delivered = codes.filter(it => DELIVERED.has(it.status)).length;
        return { id: p.id, address: p.address, version: p.version, status: p.overall_status, total, delivered, unread: !!unread[p.id] };
      });

    res.render('index', {
      stats, pendingRequests, pendingIssues, openWarranty,
      recentRequests, recentIssues, recentWarranty,
      projCards, activeCount: projCards.length, displayName, homeDashboard: 'office',
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Projects grid (moved off the home page) ───────────────────────────────────
app.get('/projects', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { status, search } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { params.push(status); where += ` AND phase = $${params.length}`; }   // toolbar filters by the single phase status
    if (search) { params.push(`%${search}%`); where += ` AND address ILIKE $${params.length}`; }

    // Wave 1 — everything that doesn't need the project ids, in ONE parallel batch.
    const [
      { rows: projects },
      { rows: unreadRows },
      { rows: _ruleRows0 },
      { rows: _allP },
    ] = await Promise.all([
      pool.query(`SELECT * FROM projects ${where} ORDER BY sort_order ASC NULLS LAST, created_at ASC`, params),
      pool.query('SELECT DISTINCT project_id FROM vendor_emails WHERE has_unread=true'),
      pool.query('SELECT * FROM order_rules'),
      pool.query('SELECT phase, overall_status, super_email FROM projects'),
    ]);
    const projectIds = projects.map(p => p.id);

    // Wave 2 — the per-project lookups, also in ONE parallel batch.
    const _empty = { rows: [] };
    const [itemsQ, reqQ, issQ, lastDelivQ, lastNoticeQ] = projectIds.length ? await Promise.all([
      pool.query('SELECT project_id, item_code, status, delivery_date FROM project_items WHERE project_id = ANY($1)', [projectIds]),
      pool.query('SELECT project_id, COUNT(*) c FROM material_requests WHERE fulfilled=FALSE AND project_id = ANY($1) GROUP BY project_id', [projectIds]).catch(() => _empty),
      pool.query("SELECT project_id, COUNT(*) c FROM material_issues WHERE status='pending' AND project_id = ANY($1) GROUP BY project_id", [projectIds]).catch(() => _empty),
      pool.query("SELECT project_id, item_code, delivery_date FROM project_items WHERE project_id = ANY($1) AND status IN ('Delivered','Delivered from Inv.') AND delivery_date IS NOT NULL ORDER BY project_id, delivery_date DESC", [projectIds]).catch(() => _empty),
      pool.query('SELECT DISTINCT ON (project_id) project_id, sent_at, method FROM delivery_notices WHERE project_id = ANY($1) ORDER BY project_id, sent_at DESC', [projectIds]).catch(() => _empty),
    ]) : [_empty, _empty, _empty, _empty, _empty];

    let itemMaps = {};
    itemsQ.rows.forEach(item => {
      if (!itemMaps[item.project_id]) itemMaps[item.project_id] = {};
      itemMaps[item.project_id][item.item_code] = item;
    });
    const unread = {};
    unreadRows.forEach(r => unread[r.project_id] = true);

    // Count delivered materials per project (for the "sort by delivered" view)
    const DELIVERED_STATUSES = new Set(['Delivered', 'Delivered from Inv.']);
    const deliveredCounts = {};
    projects.forEach(p => {
      const im = itemMaps[p.id] || {};
      deliveredCounts[p.id] = Object.values(im).filter(it => DELIVERED_STATUSES.has(it.status)).length;
    });
    const sort = req.query.sort === 'delivered' ? 'delivered' : null;
    if (sort === 'delivered') {
      projects.sort((a, b) => (deliveredCounts[b.id] || 0) - (deliveredCounts[a.id] || 0));
    }

    // ── Pipeline card data: per-project stage progress + what it needs next ──
    const _ruleMap = {}; _ruleRows0.forEach(r => _ruleMap[r.item_code] = r);
    const _reqCount = {}, _issCount = {};
    reqQ.rows.forEach(r => _reqCount[r.project_id] = Number(r.c));
    issQ.rows.forEach(r => _issCount[r.project_id] = Number(r.c));
    const _today = new Date(); _today.setHours(0, 0, 0, 0);
    const _DELIV = new Set(['Delivered', 'Delivered from Inv.']);
    const _ONORDER = new Set(['Order Placed', 'In Inventory']);
    const _SHORT = { framing: 'Framing', warehouse: 'Warehouse', oneweek: 'Post-W/O', roofing: 'Roof', solar: 'Solar' };
    const _contactByEmail = {}; allContacts().forEach(c => { _contactByEmail[String(c.email || '').toLowerCase()] = c; });
    const _initials = n => (String(n || '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?');
    const _serverPhase = p => PROJECT_PHASES.includes(p.phase) ? p.phase : (p.overall_status === 'Fully Delivered' ? 'Complete' : ((p.overall_status === 'In Progress' || p.overall_status === 'All Delivered') ? 'Under Construction' : 'Pre-Construction'));
    const cards = {};
    const summary = { needAction: 0, awaiting: 0, onTrack: 0 };
    for (const p of projects) {
      const im = itemMaps[p.id] || {};
      const stages = STAGES.map(g => {
        let deliv = 0, order = 0, total = 0;
        g.items.forEach(it => {
          const st = (im[it.code] && im[it.code].status) || 'Not yet placed';
          if (st === 'N/A') return;
          total++;
          if (_DELIV.has(st)) deliv++; else if (_ONORDER.has(st)) order++;
        });
        return { short: _SHORT[g.key] || g.name, deliv, order, total };
      });
      // Per-category delivery state (1a, 1b, …) for the individual delivery dots.
      const dotState = {};
      STAGES.forEach(g => g.items.forEach(it => {
        const st = (im[it.code] && im[it.code].status) || 'Not yet placed';
        dotState[it.code] = { state: (st === 'N/A') ? 'na' : (_DELIV.has(st) ? 'full' : (_ONORDER.has(st) ? 'order' : 'none')), status: st };
      }));
      const pd = p.phase_dates || {};
      let orderNow = 0, overdue = 0, late = 0, rfq = 0, notPlaced = 0;
      ALL_ITEMS.forEach(it => {
        const row = im[it.code] || {};
        const st = row.status || 'Not yet placed';
        if (st === 'N/A') return;
        const rule = _ruleMap[it.code];
        if (rule && (STATUS_RANK[st] ?? 0) < STATUS_RANK['Order Placed']) {
          const aDate = pd[rule.anchor === 'precon' ? 'Pre-Construction' : 'Under Construction'];
          if (aDate) {
            const due = new Date(aDate + 'T00:00:00'); due.setDate(due.getDate() + rule.offset_weeks * 7);
            const days = Math.round((due - _today) / 86400000);
            if (days <= 7) { orderNow++; if (days < 0) overdue++; }
          }
        }
        if (row.delivery_date && !_DELIV.has(st)) { const dd = new Date(row.delivery_date); dd.setHours(0, 0, 0, 0); if (dd < _today) late++; }
        if (st === 'RFQ sent') rfq++;
        if (st === 'Not yet placed') notPlaced++;
      });
      const requests = _reqCount[p.id] || 0, issues = _issCount[p.id] || 0, newReply = !!unread[p.id];
      const noSched = !(p.finish_schedule_url && String(p.finish_schedule_url).trim());
      const needs = [];
      if (issues) needs.push({ text: issues + ' issue' + (issues > 1 ? 's' : ''), kind: 'bad' });
      if (orderNow) needs.push({ text: overdue ? ('Order ' + orderNow + ' now · ' + overdue + ' overdue') : ('Order ' + orderNow + ' now'), kind: 'bad' });
      if (late) needs.push({ text: late + (late > 1 ? ' deliveries' : ' delivery') + ' late', kind: 'warn' });
      if (rfq) needs.push({ text: rfq + ' RFQ' + (rfq > 1 ? 's' : '') + ' awaiting quote', kind: 'warn' });
      if (newReply) needs.push({ text: 'New vendor reply', kind: 'info' });
      if (requests) needs.push({ text: requests + ' field request' + (requests > 1 ? 's' : ''), kind: 'mute' });
      if (noSched) needs.push({ text: 'Link finish schedule', kind: 'warn' });
      let urgency = 'green';
      if (issues || overdue || late) urgency = 'red';
      else if (orderNow || rfq || newReply || requests || noSched) urgency = 'amber';
      if (!needs.length) needs.push(notPlaced ? { text: notPlaced + ' still to order', kind: 'mute' } : { text: 'On track', kind: 'ok' });
      const supEmails = String(p.super_email || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      const sup = supEmails.map(e => { const c = _contactByEmail[e]; return { email: e, initials: _initials(c ? c.name : e), name: c ? c.name : e, role: c ? (c.role || 'super') : 'unknown' }; });
      cards[p.id] = { stages, needs, urgency, sup, dotState };
      if (!['Complete', 'Under Warranty'].includes(_serverPhase(p))) {
        if (urgency === 'red') summary.needAction++; else if (urgency === 'amber') summary.awaiting++; else summary.onTrack++;
      }
    }

    // Phase summary strip — over ALL projects (independent of the search/status filter),
    // with an in-house vs outside-GC split per phase. (_allP fetched in wave 1.)
    const phaseCounts = {}, phaseTeam = {};
    _allP.forEach(pp => {
      const ph = _serverPhase(pp);
      phaseCounts[ph] = (phaseCounts[ph] || 0) + 1;
      const em = String(pp.super_email || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      const isGc = em.some(e => (_contactByEmail[e] || {}).role === 'gc');
      const t = phaseTeam[ph] = phaseTeam[ph] || { inHouse: 0, gc: 0 };
      if (isGc) t.gc++; else t.inHouse++;
    });
    const totalCount = _allP.length;

    // "Last delivery" column: most-recent delivered category + last delivery-notice time
    // (rows fetched in wave 2).
    const _codeName = {}; STAGES.forEach(g => g.items.forEach(it => _codeName[it.code] = it.name));
    const lastDeliv = {}, lastNotice = {};
    lastDelivQ.rows.forEach(r => { if (!lastDeliv[r.project_id]) lastDeliv[r.project_id] = { name: _codeName[r.item_code] || r.item_code, date: r.delivery_date }; });
    lastNoticeQ.rows.forEach(r => { lastNotice[r.project_id] = { sentAt: r.sent_at, method: r.method }; });

    const pendingIssues = res.locals.pendingIssues || 0;   // already computed (cached) by the nav-badge middleware
    const contacts = allContacts().map(c => ({ email: c.email, name: c.name, role: c.role || 'super' }));
    res.render('projects', { projects, cards, summary, query: req.query, PROJECT_PHASES, unread, sort, pendingIssues, STAGES, contacts, phaseCounts, phaseTeam, totalCount, lastDeliv, lastNotice });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

// ── New project ───────────────────────────────────────────────────────────────

app.get('/projects/new', requireAuth, (req, res) => {
  res.render('project-form', { project: null, error: null, PROJECT_STATUSES, PROJECT_PHASES });
});

app.post('/projects', requireAuth, async (req, res) => {
  const { address, version, notes, client_name, client_email, full_address, finish_schedule_url } = req.body;
  const phase = PROJECT_PHASES.includes(req.body.phase) ? req.body.phase : 'Pre-Construction';
  if (!address) return res.render('project-form', { project: req.body, error: 'Address is required.', PROJECT_STATUSES, PROJECT_PHASES });
  const { rows: [p] } = await pool.query(
    `INSERT INTO projects (address, version, phase, overall_status, notes, client_name, client_email, full_address, finish_schedule_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [address, version||null, phase, statusForPhase(phase, null), notes||null, client_name||null, client_email||null, full_address||null, finish_schedule_url||null]
  );
  await ensureProjectItems(p.id);
  res.redirect(`/projects/${p.id}`);
});

// ── Project detail ────────────────────────────────────────────────────────────

app.get('/projects/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.redirect('/');
    // Everything below only needs project.id — ONE parallel batch instead of 8 sequential round-trips.
    let [
      { rows: items },
      { rows: reqRows },
      { rows: issueRows },
      suppliers,
      { rows: documents },
      { rows: payments },
      { rows: orderRows },
      { rows: lineRows },
    ] = await Promise.all([
      pool.query('SELECT * FROM project_items WHERE project_id=$1', [project.id]),
      pool.query('SELECT id, super_email, codes, needed_by, note, created_at FROM material_requests WHERE project_id=$1 AND fulfilled=FALSE ORDER BY created_at', [project.id]),
      pool.query("SELECT id, super_email, item_code, item_label, note FROM material_issues WHERE project_id=$1 AND status='pending' AND item_code IS NOT NULL ORDER BY created_at DESC", [project.id]),
      getSuppliers(),
      pool.query('SELECT id, filename, uploaded_at FROM project_documents WHERE project_id=$1 ORDER BY uploaded_at DESC', [project.id]),
      pool.query('SELECT * FROM milestone_payments WHERE project_id=$1 ORDER BY requested_at DESC', [project.id]),
      pool.query(`
        SELECT vo.id, vo.supplier_name, vo.supplier_email, vo.amount, vo.gmail_thread_id, vo.confirmed_at,
               (vo.receipt_data IS NOT NULL) AS has_receipt, vo.delivery_outcome,
               COALESCE(array_agg(voi.item_code ORDER BY voi.item_code) FILTER (WHERE voi.item_code IS NOT NULL), '{}') AS item_codes
        FROM vendor_orders vo
        LEFT JOIN vendor_order_items voi ON voi.order_id = vo.id
        WHERE vo.project_id=$1
        GROUP BY vo.id
        ORDER BY vo.supplier_name NULLS LAST, vo.confirmed_at DESC`, [project.id]),
      pool.query(`
        SELECT vol.item_code, vol.product_code, vol.description, vol.qty, vol.price,
               vo.id AS order_id, vo.supplier_name, vo.supplier_email, (vo.receipt_data IS NOT NULL) AS has_receipt
        FROM vendor_order_lines vol JOIN vendor_orders vo ON vo.id = vol.order_id
        WHERE vo.project_id=$1
        ORDER BY vol.item_code, vol.id`, [project.id]),
    ]);
    // Backfill missing item rows only when actually missing (avoids a write on every view).
    if (items.length < ALL_ITEMS.length) {
      await ensureProjectItems(project.id);
      items = (await pool.query('SELECT * FROM project_items WHERE project_id=$1', [project.id])).rows;
    }
    const itemMap = {};
    items.forEach(i => itemMap[i.item_code] = i);
    // Pending material requests for this project → flag the requested items on the grid
    const requestedByCode = {};
    for (const rq of reqRows) {
      const sName = (findSuper(rq.super_email) || {}).name || rq.super_email || 'Super';
      String(rq.codes || '').split(',').map(c => c.trim()).filter(Boolean).forEach(c => {
        if (!requestedByCode[c]) requestedByCode[c] = { sup: sName, needed_by: rq.needed_by };
      });
    }
    // Open issues for this project → label the affected lines (fetched in the batch above)
    const issueByCode = {};
    for (const iss of issueRows) {
      if (!issueByCode[iss.item_code]) issueByCode[iss.item_code] = {
        sup: (findSuper(iss.super_email) || {}).name || 'Super',
        label: iss.item_label || '',
        note: iss.note || '',
      };
    }
    // Full per-material issue list for highlighting the exact item in the drill-down
    const projectIssues = issueRows.map(iss => ({
      code: iss.item_code, label: iss.item_label || '', note: iss.note || '',
      sup: (findSuper(iss.super_email) || {}).name || 'Super',
    }));
    // suppliers / documents / payments / orderRows fetched in the batch above.
    const itemNames = {};
    ALL_ITEMS.forEach(i => itemNames[i.code] = i.name);
    // Open field requests for this project, with each requested item's live status — rendered as a panel on the project
    const projectRequests = reqRows.map(rq => {
      const codes = String(rq.codes || '').split(',').map(c => c.trim()).filter(Boolean);
      return {
        id: rq.id,
        superName: (findSuper(rq.super_email) || {}).name || rq.super_email || 'Super',
        needed_by: rq.needed_by, note: rq.note || '', created_at: rq.created_at,
        items: codes.map(c => ({ name: itemNames[c] || c, status: (itemMap[c] || {}).status || 'Not yet placed' })),
      };
    });
    const stageOf = {};
    STAGES.forEach(s => s.items.forEach(it => stageOf[it.code] = s.name));
    const ordersByVendor = [];
    const vmap = {};
    const catMap = {};
    for (const o of orderRows) {
      const key = (o.supplier_name || '') + '|' + (o.supplier_email || '');
      if (!vmap[key]) { vmap[key] = { name: o.supplier_name, email: o.supplier_email, orders: [] }; ordersByVendor.push(vmap[key]); }
      vmap[key].orders.push(o);
      for (const code of (o.item_codes || [])) {
        if (!catMap[code]) catMap[code] = [];
        catMap[code].push(o);
      }
    }
    // Itemized line items per order (fetched in the batch above), grouped by category
    const linesByCat = {};
    const ordersWithLines = new Set();
    for (const l of lineRows) {
      if (!linesByCat[l.item_code]) linesByCat[l.item_code] = [];
      linesByCat[l.item_code].push(l);
      ordersWithLines.add(l.order_id);
    }

    // Unified tracking: each category shows its itemized lines (with prices/subtotal),
    // plus a summary row for any order that has no line items yet (legacy fallback).
    const allCatCodes = new Set([...Object.keys(catMap), ...Object.keys(linesByCat)]);
    const ordersByCategory = ALL_ITEMS
      .filter(it => allCatCodes.has(it.code))
      .map(it => {
        const lines = linesByCat[it.code] || [];
        const subtotal = lines.reduce((s, l) => s + (l.price != null ? Number(l.price) : 0), 0);
        const summaryOrders = (catMap[it.code] || []).filter(o => !ordersWithLines.has(o.id));
        return { code: it.code, name: it.name, stage: stageOf[it.code], lines, subtotal, summaryOrders };
      });

    // Pre-built data for the "email this category to the vendor" feature
    const categoryRequestData = ordersByCategory.filter(c => c.lines.length).map(c => ({
      code: c.code, name: c.name,
      vendorName: (c.lines.find(l => l.supplier_name) || {}).supplier_name || '',
      vendorEmail: (c.lines.find(l => l.supplier_email) || {}).supplier_email || '',
      items: c.lines.map(l => ({ desc: l.description || l.product_code || '', code: l.product_code || '', qty: l.qty != null ? Number(l.qty) : 1 })),
    }));

    // Per-item delivery states — synced from the finish schedule (5-min sheet cache),
    // shown as chips on the bucket rows and a Delivery column on each expanded item.
    let itemsAgg = {}, itemStates = {}, checklistItems = [];
    try {
      syncProjectExpected(project.id).catch(() => {});   // refresh from the sheet in the BACKGROUND — don't block the render on the Sheets API
      const st = await projectItemStates(project.id);
      itemsAgg = st.agg;
      checklistItems = st.expected;   // the merged Materials & Delivery tab renders these directly
      st.expected.forEach(e => {
        const v = e.delivered ? { st: 'd' } : e.scheduled ? { st: 's', when: e.schedWhen || '' } : e.onOrder ? { st: 'o' } : null;
        if (!v) return;
        if (e.manual) v.m = 1;
        if (e.model_norm && e.model_norm.length >= 5) itemStates[e.model_norm] = v;
        // Keyed by the stable item key (PC:/MN:/NM:) so accessories without a model #
        // still get a Delivery badge and manual marks land on the right row.
        if (e.key) itemStates[e.key] = v;
      });
      // Manual marks on items not currently in the expected list (custom/out-of-catalog)
      const { rows: strayMarks } = await pool.query('SELECT item_key, state, sched_when FROM project_item_marks WHERE project_id=$1', [project.id]);
      strayMarks.forEach(m => { if (m.state && !itemStates[m.item_key]) itemStates[m.item_key] = { st: m.state[0], when: m.sched_when || '', m: 1 }; });
    } catch (e) { /* fine — chips just don't show */ }
    // Detect which door type this project actually has from its finish schedule, so the
    // Materials tab only shows the relevant sourcing toggle (bifold OR sliding, not both).
    const _hasBifold = checklistItems.some(e => /bi[-\s]?fold/i.test(e.name || ''));
    const _hasSliding = checklistItems.some(e => /slid/i.test(e.name || ''));
    const _doorDetected = checklistItems.length > 0 && (_hasBifold || _hasSliding);
    const showBifold = _doorDetected ? _hasBifold : true;    // can't detect → show both (safe fallback)
    const showSliding = _doorDetected ? _hasSliding : true;
    // Header "last delivery" + the "delivery emails sent" log for this project.
    let lastDelivered = null, deliveryNotices = [];
    try {
      const { rows: ld } = await pool.query(
        "SELECT item_code, delivery_date FROM project_items WHERE project_id=$1 AND status IN ('Delivered','Delivered from Inv.') AND delivery_date IS NOT NULL ORDER BY delivery_date DESC LIMIT 1", [project.id]);
      if (ld.length) lastDelivered = { name: CODE_NAME[ld[0].item_code] || ld[0].item_code, date: ld[0].delivery_date };
      const { rows: dn } = await pool.query(
        "SELECT sent_at, method, codes, items FROM delivery_notices WHERE project_id=$1 ORDER BY sent_at DESC LIMIT 50", [project.id]);
      deliveryNotices = dn.map(n => ({
        sentAt: n.sent_at, method: n.method || 'truck',
        items: String(n.codes || '').split(',').map(c => c.trim()).filter(Boolean).map(c => CODE_NAME[c] || c).join(', ') || (n.items || '—'),
      }));
    } catch (e) { /* non-fatal */ }
    res.render('project', { project, STAGES, itemMap, requestedByCode, issueByCode, projectIssues, projectRequests, ITEM_STATUSES, PROJECT_STATUSES, PROJECT_PHASES, EMAIL_PHASES, emailConfigured: emailEnabled, suppliers, documents, payments, ordersByVendor, itemNames, ordersByCategory, categoryRequestData, supers: allContacts(), contacts: allContacts().map(c => ({ email: c.email, name: c.name, role: c.role || 'super' })), itemsAgg, itemStates, checklistItems, showBifold, showSliding, lastDelivered, deliveryNotices });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Edit project info ─────────────────────────────────────────────────────────

app.get('/projects/:id/edit', requireAuth, async (req, res) => {
  const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!project) return res.redirect('/');
  res.render('project-form', { project, error: null, PROJECT_STATUSES, PROJECT_PHASES });
});

app.post('/projects/:id', requireAuth, async (req, res) => {
  const { address, version, notes, client_name, client_email, full_address, finish_schedule_url } = req.body;
  const { rows: [cur] } = await pool.query('SELECT phase, overall_status FROM projects WHERE id=$1', [req.params.id]);
  const phase = PROJECT_PHASES.includes(req.body.phase) ? req.body.phase : (cur && cur.phase) || 'Pre-Construction';
  await pool.query(
    `UPDATE projects SET address=$1, version=$2, phase=$3, overall_status=$4, notes=$5, client_name=$6, client_email=$7, full_address=$8, finish_schedule_url=$9, updated_at=NOW(),
       phase_dates = COALESCE(phase_dates,'{}'::jsonb) || CASE WHEN $3::text IS DISTINCT FROM $11::text THEN jsonb_build_object($3::text, to_char(NOW(),'YYYY-MM-DD')) ELSE '{}'::jsonb END,
       warranty_started_at = CASE
         WHEN $3 = 'Under Warranty' THEN COALESCE(warranty_started_at, NOW())
         WHEN $3 = 'Complete' THEN warranty_started_at
         ELSE NULL END
     WHERE id=$10`,
    [address, version||null, phase, statusForPhase(phase, cur ? cur.overall_status : null), notes||null, client_name||null, client_email||null, full_address||null, finish_schedule_url||null, req.params.id, cur ? cur.phase : null]
  );
  res.redirect(`/projects/${req.params.id}`);
});

// ── Reorder projects (drag and drop) ──────────────────────────────────────────

// ── Order Planner: when to place each material order, per project ─────────────
app.get('/ordering', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: ruleRows } = await pool.query('SELECT * FROM order_rules');
    const ruleMap = {}; ruleRows.forEach(r => ruleMap[r.item_code] = r);
    const { rows: projects } = await pool.query(
      `SELECT id, address, phase, phase_dates FROM projects WHERE phase IN ('Pre-Construction','Under Construction') ORDER BY sort_order NULLS LAST, id`);
    const ids = projects.map(p => p.id);
    let items = [];
    if (ids.length) ({ rows: items } = await pool.query('SELECT project_id, item_code, status FROM project_items WHERE project_id = ANY($1)', [ids]));
    const itemMap = {}; items.forEach(i => { (itemMap[i.project_id] = itemMap[i.project_id] || {})[i.item_code] = i.status; });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const entries = []; const pending = [];
    for (const p of projects) {
      const pd = p.phase_dates || {};
      for (const it of ALL_ITEMS) {
        const rule = ruleMap[it.code]; if (!rule) continue;
        const st = (itemMap[p.id] && itemMap[p.id][it.code]) || 'Not yet placed';
        if (st === 'N/A') continue;
        if ((STATUS_RANK[st] ?? 0) >= STATUS_RANK['Order Placed']) continue;   // already ordered or further
        const anchorKey = rule.anchor === 'precon' ? 'Pre-Construction' : 'Under Construction';
        const aDate = pd[anchorKey];
        if (!aDate) { pending.push({ pid: p.id, address: p.address, code: it.code, name: it.name, rule, status: st }); continue; }
        const due = new Date(aDate + 'T00:00:00'); due.setDate(due.getDate() + rule.offset_weeks * 7);
        const days = Math.round((due - today) / 86400000);
        entries.push({ pid: p.id, address: p.address, code: it.code, name: it.name, rule, status: st, due, days, rfqOut: st === 'RFQ sent' });
      }
    }
    entries.sort((a, b) => a.due - b.due);
    res.render('ordering', {
      overdue: entries.filter(e => e.days < 0),
      dueNow: entries.filter(e => e.days >= 0 && e.days <= 7),
      upcoming: entries.filter(e => e.days > 7 && e.days <= 21),
      later: entries.filter(e => e.days > 21),
      pending, projects,
      rules: ALL_ITEMS.map(i => ({ code: i.code, name: i.name, rule: ruleMap[i.code] || null })),
    });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Save an ordering rule (anchor + weeks + note) for one material
app.post('/ordering/rules', requireAuth, async (req, res) => {
  try {
    const { code, anchor, weeks, note } = req.body;
    if (!ALL_ITEMS.find(i => i.code === code)) return res.status(400).json({ ok: false, error: 'Unknown material.' });
    const a = anchor === 'precon' ? 'precon' : 'construction';
    const w = Math.max(0, Math.min(52, parseInt(weeks, 10) || 0));
    await pool.query(
      `INSERT INTO order_rules (item_code, anchor, offset_weeks, lead_note, updated_at) VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (item_code) DO UPDATE SET anchor=$2, offset_weeks=$3, lead_note=$4, updated_at=NOW()`,
      [code, a, w, String(note || '').slice(0, 200)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Correct a project's phase start date (drives the planner's due dates)
app.post('/projects/:id/phase-date', requireAuth, async (req, res) => {
  try {
    const key = req.body.key === 'Pre-Construction' ? 'Pre-Construction' : 'Under Construction';
    const date = String(req.body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'Bad date.' });
    await pool.query(
      `UPDATE projects SET phase_dates = COALESCE(phase_dates,'{}'::jsonb) || jsonb_build_object($1::text, $2::text) WHERE id=$3`,
      [key, date, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Move a project between lifecycle sections — also syncs the legacy delivery status
app.post('/projects/:id/phase', requireAuth, async (req, res) => {
  try {
    const phase = String(req.body.phase || '');
    if (!PROJECT_PHASES.includes(phase)) return res.status(400).json({ ok: false, error: 'Unknown phase.' });
    const { rows: [cur] } = await pool.query('SELECT overall_status, phase FROM projects WHERE id=$1', [req.params.id]);
    if (!cur) return res.status(404).json({ ok: false, error: 'Project not found.' });
    // Entering Under Warranty starts the 1-year clock (kept if re-picked); moving
    // back to an earlier phase resets it; Complete preserves the history. The
    // phase start date is stamped only on a real change (re-picks keep the original).
    await pool.query(
      `UPDATE projects SET phase=$1, overall_status=$2, updated_at=NOW(),
         phase_dates = COALESCE(phase_dates,'{}'::jsonb) || CASE WHEN $1::text IS DISTINCT FROM $4::text THEN jsonb_build_object($1::text, to_char(NOW(),'YYYY-MM-DD')) ELSE '{}'::jsonb END,
         warranty_started_at = CASE
           WHEN $1 = 'Under Warranty' THEN COALESCE(warranty_started_at, NOW())
           WHEN $1 = 'Complete' THEN warranty_started_at
           ELSE NULL END
       WHERE id=$3`,
      [phase, statusForPhase(phase, cur.overall_status), req.params.id, cur.phase]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

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
  const { status, delivery_date, delivery_date_end, notes, order_date, statusOnly } = req.body;
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
    // Window: keep an end date only if it's after the start; ignore otherwise.
    const end = (delivery_date && delivery_date_end && delivery_date_end > delivery_date) ? delivery_date_end : null;
    await pool.query(
      `UPDATE project_items SET status=$1, delivery_date=$2, delivery_date_end=$3, notes=$4, order_date=$5
       WHERE project_id=$6 AND item_code=$7`,
      [status, delivery_date || null, end, notes || null, order_date || null, req.params.id, req.params.code]
    );
  }
  // Chat alert is no longer automatic — it's sent on demand via the 📢 button (/notify).
  // If this item just became delivered, auto-clear any field requests it completes.
  if (['Delivered', 'Delivered from Inv.'].includes(status)) autoFulfillRequests(req.params.id);
  // Keep inventory in sync: "Delivered from Inv." draws the held stock down; "In Inventory" restores it.
  let inv = null;
  if (status === 'Delivered from Inv.') { const n = await syncHeldStockForCode(req.params.id, req.params.code, true); if (n) inv = { drewDown: n }; }
  else if (status === 'In Inventory') { const n = await syncHeldStockForCode(req.params.id, req.params.code, false); if (n) inv = { restored: n }; }
  res.json({ ok: true, inv });
});

// Manually queue a delivery notice for one or more categories (any vendor) — reviewed in the
// approval queue like the auto/Ferguson ones. For ad-hoc sends and re-sends.
app.post('/projects/:id/notice', requireAuth, async (req, res) => {
  try {
    let { codes, method, tracking, window } = req.body;
    if (typeof codes === 'string') codes = codes.split(',').map(c => c.trim()).filter(Boolean);
    if (!Array.isArray(codes) || !codes.length) return res.status(400).json({ ok: false, error: 'No categories given.' });
    const m = method === 'ups' ? 'ups' : 'truck';
    const r = await enqueueDeliveryNotice({ projectId: req.params.id, codes, window: window || null, method: m, tracking: tracking || null, source: 'manual' });
    if (!r.ok) return res.json({ ok: false, error: r.reason || 'Could not queue the notice.' });
    res.json({ ok: true, queued: r.queued !== false, duplicate: !!r.duplicate });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Format a YYYY-MM-DD as a friendly chat date (Tue, Jun 9). Short form omits the weekday.
function chatDate(ymd, short) {
  const p = String(ymd || '').split('-').map(Number);
  if (p.length !== 3) return String(ymd || '');
  const opts = short ? { month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' };
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-US', opts);
}

// Send the delivery alert for one item to chat (single date or window). On demand.
app.post('/projects/:id/items/:code/notify', requireAuth, async (req, res) => {
  try {
    const { rows: [it] } = await pool.query(
      'SELECT delivery_date, delivery_date_end FROM project_items WHERE project_id=$1 AND item_code=$2',
      [req.params.id, req.params.code]
    );
    if (!it || !it.delivery_date) return res.status(400).json({ ok: false, error: 'Set a delivery date first.' });
    const start = new Date(it.delivery_date).toISOString().slice(0, 10);
    const end = it.delivery_date_end ? new Date(it.delivery_date_end).toISOString().slice(0, 10) : null;
    const { rows: [proj] } = await pool.query('SELECT address, super_email FROM projects WHERE id=$1', [req.params.id]);
    const name = ITEM_NAME[req.params.code] || req.params.code;
    const sups = proj ? parseSuperEmails(proj.super_email) : [];
    // No super on the project = nobody to tag = no post. Assign a super first.
    if (!sups.length) return res.status(400).json({ ok: false, error: 'No super assigned to this project — pick a super up top first (delivery alerts tag them).' });
    const mention = sups.map(s => `<users/${s.chatId}>`).join(' ') + ' ';
    const when = end
      ? `Delivery window ${chatDate(start, true)} – ${chatDate(end, true)}`
      : `scheduled for delivery ${chatDate(start)}`;
    postToChat(`*${shortAddress(proj ? proj.address : '')}*\n${mention}${name} ${when}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Send milestone email ──────────────────────────────────────────────────────

app.post('/projects/:id/send-email', requireAuth, upload.array('attachments', 10), async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email is not configured.' });
    const { phaseKey, amount, melioLink, extraHtml, extraText, asDraft } = req.body;
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
    (req.files || []).forEach(f => attachments.push({ filename: f.originalname, mimeType: f.mimetype, content: f.buffer }));

    // Closeout procedure: the Appliance Warranty Transfer auto-attaches to the FINAL payment email
    if (phase.key === 'final') {
      try {
        const warrantyPath = path.join(__dirname, 'assets', 'appliance-warranty-transfer.pdf');
        if (fs.existsSync(warrantyPath)) {
          attachments.push({ filename: 'Appliance Warranty Transfer Document.pdf', mimeType: 'application/pdf', content: fs.readFileSync(warrantyPath) });
        }
      } catch (e) { console.error('warranty attach:', e.message); }
    }

    // Render as HTML so the Gmail signature appears; preserve the body's line breaks
    const sig = await getSignature();
    // Optional pasted content goes directly below the Melio link
    let extraBlock = '';
    if (extraHtml && /<table/i.test(extraHtml)) extraBlock = `<div style="margin-top:12px">${sanitizePastedHtml(extraHtml)}</div>`;
    else if (extraText && extraText.trim()) extraBlock = `<div style="margin-top:12px;white-space:pre-wrap">${escapeHtml(extraText.trim())}</div>`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${escapeHtml(body)}</div>${extraBlock}${sig ? '<br>' + sig : ''}`;

    if (asDraft === 'true' || asDraft === true) {
      await createDraft({ to: project.client_email, subject, html, attachments });
      return res.json({ ok: true, draft: true });
    }

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

// Build the exact RFQ / outbound email (subject + html) — shared by send, draft,
// and preview so the preview matches byte-for-byte what actually goes out.
async function buildRfqEmail({ project, emailType, itemsHtml, items, note, supplierName, cc, outboundDate }) {
  const fullAddress = project.full_address || project.address;
  const addr = escapeHtml(fullAddress);
  const table = (itemsHtml && /<table/i.test(itemsHtml)) ? sanitizePastedHtml(itemsHtml) : pastedDataToTable(items);
  const sig = await getSignature();
  const signoff = sig ? `<br>${sig}` : '<p>Thank you,<br>Logan<br>Buildoly</p>';
  const contact = await deliveryContactHtml(project);
  const replyNote = '<p style="margin-top:14px"><strong>Please reply to this email thread directly</strong> so everything stays in one place.</p>';
  let subject, html, sendCc = null;

  if (emailType === 'warehouse') {
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
${contact}
${replyNote}
<p>Thank you,</p>
${signoff}
</div>`;
  } else {
    const subjectLine = `${fullAddress} RFQ`;
    const TYPES = {
      order: { subject: subjectLine, intro: `I'd like to place an order for delivery to <strong>${addr}</strong>. Please see the items below:`, closing: '' },
      delivery: { subject: subjectLine, intro: `We're ready for delivery to <strong>${addr}</strong> on the following items:`, closing: 'Please confirm the delivery date.' },
      quote: { subject: subjectLine, intro: `I'd like to request an RFQ for delivery to <strong>${addr}</strong>:`, closing: 'Please provide pricing, availability, and lead time at your earliest convenience.' },
      damage: { subject: `${fullAddress} — Damaged Item Report`, intro: `The following item(s) at <strong>${addr}</strong> were damaged:`, closing: 'Can we get a replacement for this? See photos below.' },
      replacement: { subject: `${fullAddress} — Replacement Request`, intro: `We need replacement(s) for the following item(s) at <strong>${addr}</strong>:`, closing: 'Please confirm the replacement order and its expected delivery date.' },
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
${t.closing ? `<p>${t.closing}</p>` : ''}
${emailType === 'delivery' ? contact : ''}
${replyNote}
${signoff}
</div>`;
  }
  return { subject, html, cc: sendCc };
}

// Preview the RFQ email without sending — returns the composed subject/body so the
// UI can show it for review.
app.post('/projects/:id/rfq/preview', requireAuth, upload.array('attachments', 10), async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email is not configured.' });
    const { supplierEmail, supplierName, note, items, itemsHtml, emailType, cc, outboundDate } = req.body;
    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    const { subject, html, cc: sendCc } = await buildRfqEmail({ project, emailType, itemsHtml, items, note, supplierName, cc, outboundDate });
    const attachments = (req.files || []).map(f => f.originalname);
    res.json({ ok: true, to: supplierEmail || '', cc: sendCc || '', subject, html, attachments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/projects/:id/rfq', requireAuth, upload.array('attachments', 10), async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email is not configured.' });
    const { itemCode, supplierEmail, supplierName, note, items, itemsHtml, emailType, cc, outboundDate, asDraft } = req.body;
    if (itemCode && !ALL_ITEMS.find(i => i.code === itemCode)) return res.status(400).json({ ok: false, error: 'Unknown material.' });
    if (!supplierEmail) return res.status(400).json({ ok: false, error: 'No recipient email. Add one in Settings or type it in.' });
    // Every material category this email covers (clicked category + auto-filled vendor items) —
    // stored on the thread so it shows under each category's email box.
    const validCodes = new Set(ALL_ITEMS.map(i => i.code));
    const coveredCodes = [].concat(req.body.coveredCodes || []).filter(c => validCodes.has(c));
    const itemCodesCsv = [...new Set([itemCode, ...coveredCodes].filter(c => c && validCodes.has(c)))].join(',') || null;

    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });

    const { subject, html, cc: sendCc } = await buildRfqEmail({ project, emailType, itemsHtml, items, note, supplierName, cc, outboundDate });

    const attachments = [];
    (req.files || []).forEach(f => attachments.push({ filename: f.originalname, mimeType: f.mimetype, content: f.buffer }));

    if (asDraft === 'true' || asDraft === true) {
      const draft = await createDraft({ to: supplierEmail, cc: sendCc, subject, html, attachments });
      // Record the draft so it appears in the project's Emails tab and replies get
      // tracked once you send it from Gmail (it keeps the same thread id).
      await pool.query(
        `INSERT INTO vendor_emails (project_id, item_code, item_codes, supplier_name, supplier_email, subject, email_type, gmail_thread_id, gmail_message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.id, itemCode || null, itemCodesCsv, supplierName || null, supplierEmail, subject, emailType || 'order', draft.threadId || null, draft.messageId || null]
      );
      return res.json({ ok: true, draft: true });
    }

    const sent = await sendMail({ to: supplierEmail, cc: sendCc, subject, html, attachments });
    const { rows: [ve] } = await pool.query(
      `INSERT INTO vendor_emails (project_id, item_code, item_codes, supplier_name, supplier_email, subject, email_type, gmail_thread_id, gmail_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.params.id, itemCode || null, itemCodesCsv, supplierName || null, supplierEmail, subject, emailType || 'order', sent.threadId || null, sent.messageId || null]
    );

    // Auto-advance the status of all this vendor's materials on the project
    const updatedItems = itemCode ? await advanceVendorItems(req.params.id, itemCode, emailType) : [];

    // Vendor-dropdown sends pass the covered material codes; advance those too —
    // quotes land on "RFQ sent", orders on "Order Placed" (never backward).
    if (coveredCodes.length && TYPE_TARGET[emailType]) {
      const bumped = await bumpItemsForward(req.params.id, coveredCodes, TYPE_TARGET[emailType]);
      const seen = new Set(updatedItems.map(u => u.code));
      bumped.forEach(u => { if (!seen.has(u.code)) updatedItems.push(u); });
    }
    // Stamp Order Date (the send date) on everything this email touched.
    // Orders always stamp; RFQ/quote sends fill the date only where it's still
    // blank, so a later real order date is never clobbered by a follow-up quote.
    if (emailType === 'order' || emailType === 'quote') {
      const stamp = [...new Set([...updatedItems.map(u => u.code), ...coveredCodes])];
      if (stamp.length) {
        const guard = emailType === 'quote' ? ' AND order_date IS NULL' : '';
        await pool.query(`UPDATE project_items SET order_date=CURRENT_DATE WHERE project_id=$1 AND item_code = ANY($2)${guard}`, [req.params.id, stamp]);
      }
    }

    // Per-item order marks: 📦 on exactly the schedule items this order covered (orders only).
    if (emailType === 'order') {
      let orderedKeys = req.body.orderedKeys;
      if (!Array.isArray(orderedKeys)) orderedKeys = orderedKeys ? [orderedKeys] : [];
      for (const k of orderedKeys) {
        if (k) { try { await pool.query('INSERT INTO project_item_orders (project_id, item_key) VALUES ($1,$2) ON CONFLICT (project_id, item_key) DO UPDATE SET ordered_at=NOW()', [req.params.id, String(k).slice(0, 120)]); } catch (e) {} }
      }
    }

    // A delivery-request email starts the "awaiting vendor date" watch on THIS row only (Ferguson
    // excluded). When the vendor replies with a date, processDeliveryReplies() creates the notice.
    if (emailType === 'delivery' && ve && !/ferguson/i.test((supplierName || '') + ' ' + (supplierEmail || ''))) {
      try { await pool.query('UPDATE vendor_emails SET awaiting_delivery_date=true WHERE id=$1', [ve.id]); } catch (e) {}
    }

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
    const { rows: [r] } = await pool.query('SELECT attachment_name, updated_at, emergency_phone, warranty_doc_name FROM app_settings WHERE id=1');
    const suppliers = await getSuppliers();
    const phones = await getSuperPhones();
    const supers = SUPERS.map(s => ({ email: s.email, name: s.name, phone: phones[s.email.toLowerCase()] || '' }));
    res.render('settings', { attachmentName: r ? r.attachment_name : null, updatedAt: r ? r.updated_at : null, emergencyPhone: r ? (r.emergency_phone || '') : '', warrantyDocName: r ? (r.warranty_doc_name || '') : '', STAGES, suppliers, supers, savedSupers: req.query.savedSupers === '1', savedEmergency: req.query.savedEmergency === '1', savedDoc: req.query.savedDoc === '1' });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Save superintendent phone numbers (used as the delivery contact on outgoing emails).
app.post('/settings/supers', requireAuth, async (req, res) => {
  try {
    await initDb();
    for (const s of SUPERS) {
      const phone = String(req.body['phone_' + s.email] || '').trim();
      await pool.query(
        `INSERT INTO super_contacts (email, phone) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET phone = EXCLUDED.phone`,
        [s.email, phone || null]
      );
    }
    res.redirect('/settings?savedSupers=1#supers');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Emergency phone shown to clients on the public warranty page
app.post('/settings/emergency-phone', requireAuth, async (req, res) => {
  try {
    await initDb();
    const phone = String(req.body.emergency_phone || '').trim().slice(0, 40);
    await pool.query(
      `INSERT INTO app_settings (id, emergency_phone, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET emergency_phone = EXCLUDED.emergency_phone, updated_at = NOW()`,
      [phone || null]);
    res.redirect('/settings?savedEmergency=1#warranty');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Upload the manufacturer-warranty document shown to clients who tap "No"
app.post('/settings/warranty-doc', requireAuth, upload.single('warranty_doc'), async (req, res) => {
  if (!req.file) return res.redirect('/settings#warranty');
  await pool.query(
    `INSERT INTO app_settings (id, warranty_doc_name, warranty_doc_mime, warranty_doc_data, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET warranty_doc_name=EXCLUDED.warranty_doc_name,
       warranty_doc_mime=EXCLUDED.warranty_doc_mime, warranty_doc_data=EXCLUDED.warranty_doc_data, updated_at=NOW()`,
    [req.file.originalname, req.file.mimetype, req.file.buffer]);
  res.redirect('/settings?savedDoc=1#warranty');
});
app.post('/settings/warranty-doc/delete', requireAuth, async (req, res) => {
  await pool.query('UPDATE app_settings SET warranty_doc_name=NULL, warranty_doc_mime=NULL, warranty_doc_data=NULL WHERE id=1');
  res.redirect('/settings#warranty');
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
      `SELECT id, item_code, item_codes, supplier_name, supplier_email, subject, email_type, gmail_thread_id, sent_at, has_unread
       FROM vendor_emails WHERE project_id=$1 AND gmail_thread_id IS NOT NULL ORDER BY has_unread DESC, sent_at DESC`,
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
    const messages = await fetchConversation(req.params.threadId);
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

// Re-file a vendor email under material categories (the 🏷 button on a thread)
app.post('/vendor-emails/:id/codes', requireAuth, async (req, res) => {
  try {
    const valid = new Set(ALL_ITEMS.map(i => i.code));
    const codes = [].concat(req.body.codes || []).filter(c => valid.has(c));
    await pool.query('UPDATE vendor_emails SET item_code=$1, item_codes=$2 WHERE id=$3',
      [codes[0] || null, codes.join(',') || null, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Download / view a PDF (or any) attachment from a received email
app.get('/threads/messages/:messageId/attachment/:attachmentId', requireAuth, async (req, res) => {
  try {
    if (!useGmail) return res.status(400).send('Gmail not configured.');
    const { data } = await gmailClient.users.messages.attachments.get({
      userId: 'me', messageId: req.params.messageId, id: req.params.attachmentId,
    });
    if (!data || !data.data) return res.status(404).send('Attachment not found.');
    const buf = Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const name = String(req.query.name || 'attachment').replace(/[^\w.\- ]/g, '_');
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(req.query.mime || '')) ? req.query.mime : 'application/octet-stream';
    // Browsers can render PDFs/images/text inline; everything else (Word, Excel…) must download
    const viewable = /^(application\/pdf|image\/|text\/)/i.test(mime);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${viewable ? 'inline' : 'attachment'}; filename="${name}"`);
    res.send(buf);
  } catch (err) {
    console.error('Attachment fetch error:', err.message);
    res.status(500).send('Could not fetch attachment: ' + err.message);
  }
});

// Pull the original HTML body out of a Gmail message so emails can be shown exactly
// as sent (QuickBooks estimates etc.), not as stripped text. Inline cid: images are
// rewritten to our attachment proxy so they still render.
function gmailHtmlFromPayload(payload, messageId) {
  let html = '';
  const cids = [];
  (function walk(p) {
    if (!p) return;
    if (!html && p.mimeType === 'text/html' && p.body && p.body.data) {
      html = Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
    const cid = ((p.headers || []).find(h => h.name.toLowerCase() === 'content-id') || {}).value;
    if (cid && p.body && p.body.attachmentId) cids.push({ cid: cid.replace(/[<>]/g, ''), aid: p.body.attachmentId, mime: p.mimeType });
    (p.parts || []).forEach(walk);
  })(payload);
  if (html) {
    for (const c of cids) {
      html = html.split('cid:' + c.cid).join('/threads/messages/' + messageId + '/attachment/' + c.aid + '?name=inline&mime=' + encodeURIComponent(c.mime || 'image/png'));
    }
  }
  return html;
}

// Render a logged sub email the way Gmail shows it. Uses the HTML stored at ingest;
// older rows are fetched from Gmail once and cached. Scripts are blocked via CSP.
app.get('/subs/emails/:id/html', requireAuth, async (req, res) => {
  try {
    const { rows: [em] } = await pool.query(
      'SELECT id, subject, body, body_html, gmail_message_id, from_email, to_email, direction, created_at FROM sub_emails WHERE id=$1', [req.params.id]);
    if (!em) return res.status(404).send('Email not found.');
    let html = em.body_html;
    if (!html && em.gmail_message_id && gmailClient) {
      try {
        const { data } = await gmailClient.users.messages.get({ userId: 'me', id: em.gmail_message_id, format: 'full' });
        html = gmailHtmlFromPayload(data.payload, em.gmail_message_id);
        if (html) await pool.query('UPDATE sub_emails SET body_html=$1 WHERE id=$2', [html, em.id]);
      } catch (e) { /* message gone from Gmail — fall through to the text version */ }
    }
    if (!html) html = '<pre style="white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif;margin:0">' + escapeHtml(em.body || '(no content)') + '</pre>';
    res.set('Content-Security-Policy', "script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'");
    if (req.query.embed) {
      // Bare version for the inline reading pane (iframe) — just the email on white.
      return res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head>'
        + '<body style="margin:0;padding:10px 14px;background:#fff;overflow-x:auto">' + html + '</body></html>');
    }
    const who = em.direction === 'in'
      ? 'From: ' + escapeHtml(em.from_email || '') + (em.to_email ? ' &nbsp;·&nbsp; To: ' + escapeHtml(em.to_email) : '')
      : 'To: ' + escapeHtml(em.to_email || '');
    res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>' + escapeHtml(em.subject || 'Email') + '</title><base target="_blank"></head>'
      + '<body style="margin:0;background:#f1f3f5">'
      + '<div style="background:#fff;border-bottom:1px solid #e2e5e9;padding:14px 22px;font:14px system-ui,sans-serif;position:sticky;top:0">'
      + '<div style="font-weight:700;font-size:16px;margin-bottom:3px">' + escapeHtml(em.subject || '(no subject)') + '</div>'
      + '<div style="color:#667">' + who + ' &nbsp;·&nbsp; ' + new Date(em.created_at).toLocaleString() + '</div></div>'
      + '<div style="max-width:900px;margin:18px auto;background:#fff;border:1px solid #e2e5e9;border-radius:10px;padding:22px;overflow-x:auto">' + html + '</div>'
      + '</body></html>');
  } catch (err) {
    console.error('Email html view:', err.message);
    res.status(500).send('Could not load email: ' + err.message);
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
// Rate a delivery (vendor reliability): ontime / late / wrong / missed — or clear
app.post('/orders/:id/outcome', requireAuth, async (req, res) => {
  try {
    const oc = ['ontime', 'late', 'wrong', 'missed'].includes(req.body.outcome) ? req.body.outcome : null;
    await pool.query('UPDATE vendor_orders SET delivery_outcome=$1 WHERE id=$2', [oc, req.params.id]);
    res.json({ ok: true, outcome: oc });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/orders/:id/delete', requireAuth, async (req, res) => {
  const { rows: [o] } = await pool.query('SELECT project_id FROM vendor_orders WHERE id=$1', [req.params.id]);
  await pool.query('DELETE FROM vendor_orders WHERE id=$1', [req.params.id]);
  res.redirect(o ? `/projects/${o.project_id}` : '/');
});

// Read an uploaded receipt PDF and return parsed/categorized items (no save)
app.post('/projects/:id/parse-receipt', requireAuth, upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    const parsed = await parseReceiptPdf(req.file.buffer);
    res.json({ ok: true, vendor: parsed.vendor, amount: parsed.amount, lines: parsed.lines });
  } catch (err) {
    console.error('Parse receipt error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not read this PDF — ' + err.message });
  }
});

// Save a reviewed receipt as an order (line items + receipt + status bumps)
app.post('/projects/:id/orders-from-receipt', requireAuth, upload.single('receipt'), async (req, res) => {
  try {
    const { vendorName, vendorEmail, amount } = req.body;
    const valid = new Set(ALL_ITEMS.map(i => i.code));
    let lines = [];
    try { lines = JSON.parse(req.body.linesJson || '[]'); } catch (e) {}
    lines = (Array.isArray(lines) ? lines : []).filter(l => l && valid.has(l.item_code));
    if (!lines.length) return res.status(400).json({ ok: false, error: 'No valid line items to save.' });

    const amountNum = amount ? parseFloat(String(amount).replace(/[^0-9.]/g, '')) : NaN;
    let rName = null, rMime = null, rData = null;
    if (req.file) { rName = req.file.originalname; rMime = req.file.mimetype; rData = req.file.buffer; }

    const { rows: [ord] } = await pool.query(
      `INSERT INTO vendor_orders (project_id, supplier_name, supplier_email, amount, receipt_name, receipt_mime, receipt_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.params.id, vendorName || null, vendorEmail || null, isNaN(amountNum) ? null : amountNum, rName, rMime, rData]);

    const cats = new Set();
    for (const l of lines) {
      await pool.query(
        'INSERT INTO vendor_order_lines (order_id, item_code, product_code, description, qty, price) VALUES ($1,$2,$3,$4,$5,$6)',
        [ord.id, l.item_code, l.product_code || null, l.description || null, l.qty != null ? l.qty : 1, l.price != null ? l.price : null]);
      cats.add(l.item_code);
    }
    for (const c of cats) await pool.query('INSERT INTO vendor_order_items (order_id, item_code) VALUES ($1,$2)', [ord.id, c]);
    await bumpItemsForward(req.params.id, [...cats], 'Order Placed');

    res.json({ ok: true, orderId: ord.id });
  } catch (err) {
    console.error('Save receipt order error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Email a vendor a request for the items in one category
app.post('/projects/:id/category-request', requireAuth, async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email is not configured.' });
    const { category, to, emailType, items, note } = req.body;
    if (!to || !to.trim()) return res.status(400).json({ ok: false, error: 'No recipient email.' });
    if (!items || !items.trim()) return res.status(400).json({ ok: false, error: 'No items to request.' });

    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    const fullAddress = project.full_address || project.address;
    const addr = escapeHtml(fullAddress);
    const catName = (ALL_ITEMS.find(i => i.code === category) || {}).name || 'items';

    const TYPES = {
      delivery: { verb: 'Delivery Request', intro: `We're ready for delivery of the following <strong>${escapeHtml(catName)}</strong> items to <strong>${addr}</strong>:`, closing: 'Please confirm the delivery date.' },
      order: { verb: 'Order', intro: `We'd like to order the following <strong>${escapeHtml(catName)}</strong> items for <strong>${addr}</strong>:`, closing: '' },
      quote: { verb: 'RFQ', intro: `Please quote the following <strong>${escapeHtml(catName)}</strong> items for <strong>${addr}</strong>:`, closing: 'Please provide pricing, availability, and lead time.' },
      damage: { verb: 'Damaged Item Report', intro: `The following <strong>${escapeHtml(catName)}</strong> item(s) at <strong>${addr}</strong> were damaged:`, closing: 'Can we get a replacement for this? See photos below.' },
      replacement: { verb: 'Replacement Request', intro: `We need replacement(s) for the following <strong>${escapeHtml(catName)}</strong> item(s) at <strong>${addr}</strong>:`, closing: 'Please confirm the replacement order and its expected delivery date.' },
    };
    const t = TYPES[emailType] || TYPES.delivery;
    const subject = `${fullAddress} — ${catName} ${t.verb}`;

    const itemList = String(items).trim().split(/\r?\n/).filter(l => l.trim());
    const itemsHtml = '<ul style="margin:8px 0;padding-left:20px">' + itemList.map(l => `<li>${escapeHtml(l.trim())}</li>`).join('') + '</ul>';
    const sig = await getSignature();
    const signoff = sig ? `<br>${sig}` : '<p>Thank you,<br>Logan<br>Buildoly</p>';
    const html =
`<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>Hi,</p>
<p>${t.intro}</p>
${itemsHtml}
${note ? `<p>${escapeHtml(note).replace(/\n/g, '<br>')}</p>` : ''}
${t.closing ? `<p>${t.closing}</p>` : ''}
${signoff}
</div>`;

    const sent = await sendMail({ to, subject, html });
    const { rows: [ve] } = await pool.query(
      `INSERT INTO vendor_emails (project_id, item_code, item_codes, supplier_name, supplier_email, subject, email_type, gmail_thread_id, gmail_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.params.id, category || null, category || null, null, to, subject, emailType || 'delivery', sent.threadId || null, sent.messageId || null]
    );
    // Advance the category's material too — quote → "RFQ sent", order → "Order Placed"
    if (category && ALL_ITEMS.find(i => i.code === category) && TYPE_TARGET[emailType]) {
      await bumpItemsForward(req.params.id, [category], TYPE_TARGET[emailType]);
    }
    // Delivery-request email → start the "awaiting vendor date" watch on THIS row only (Ferguson
    // excluded). The vendor's reply date is parsed into the notice by processDeliveryReplies().
    if (emailType === 'delivery' && category && ve && !/ferguson/i.test(to || '')) {
      try { await pool.query('UPDATE vendor_emails SET awaiting_delivery_date=true WHERE id=$1', [ve.id]); } catch (e) {}
    }
    res.json({ ok: true, sentTo: to });
  } catch (err) {
    console.error('Category request error:', err.code || '', '-', err.message);
    res.status(500).json({ ok: false, error: `${err.code || 'ERR'}: ${err.message}` });
  }
});

// Request delivery of specific items as a REPLY to an order's email thread
app.post('/projects/:id/request-delivery', requireAuth, async (req, res) => {
  try {
    if (!useGmail) return res.status(400).json({ ok: false, error: 'Gmail not configured.' });
    const { threadId, note, deliveryDate } = req.body;
    if (!threadId) return res.status(400).json({ ok: false, error: 'No order thread.' });
    const valid = new Set(ALL_ITEMS.map(i => i.code));
    const codes = [].concat(req.body.itemCodes || []).filter(c => valid.has(c));
    if (!codes.length) return res.status(400).json({ ok: false, error: 'Pick at least one item to deliver.' });

    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    const fullAddress = project ? (project.full_address || project.address) : '';

    // Reply within the existing order thread (keeps one conversation)
    const messages = await fetchThread(threadId);
    if (!messages.length) return res.status(404).json({ ok: false, error: 'Order thread not found.' });
    const last = messages[messages.length - 1];
    const replyTo = last.fromMe ? last.to : last.from;
    let subject = last.subject || '';
    if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;
    const refs = [last.references, last.messageIdHeader].filter(Boolean).join(' ');

    const names = {}; ALL_ITEMS.forEach(i => names[i.code] = i.name);
    const itemsHtml = '<ul style="margin:8px 0">' + codes.map(c => `<li>${escapeHtml(names[c] || c)}</li>`).join('') + '</ul>';
    const sig = await getSignature();
    const html =
`<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>Hi,</p>
<p>We're ready for delivery of the following items to <strong>${escapeHtml(fullAddress)}</strong>:</p>
${itemsHtml}
${note ? `<p>${escapeHtml(note).replace(/\n/g, '<br>')}</p>` : ''}
${deliveryDate ? `<p>We'd like these delivered on <strong>${escapeHtml(deliveryDate)}</strong> — please confirm.</p>` : '<p>Please confirm the delivery date. Thank you.</p>'}
${sig ? '<br>' + sig : ''}
</div>`;

    await sendMail({ to: replyTo, subject, html, threadId, inReplyTo: last.messageIdHeader, references: refs });
    if (deliveryDate) {
      await pool.query('UPDATE project_items SET delivery_requested_at=NOW(), delivery_date=$3 WHERE project_id=$1 AND item_code = ANY($2)', [req.params.id, codes, deliveryDate]);
    } else {
      await pool.query('UPDATE project_items SET delivery_requested_at=NOW() WHERE project_id=$1 AND item_code = ANY($2)', [req.params.id, codes]);
    }

    // Watch this in-thread delivery request for the vendor's date reply, like the main path.
    if (!/ferguson/i.test(replyTo || '')) {
      try {
        await pool.query(
          `INSERT INTO vendor_emails (project_id, item_code, item_codes, supplier_email, subject, email_type, gmail_thread_id, awaiting_delivery_date)
           VALUES ($1,$2,$3,$4,$5,'delivery',$6,true)`,
          [req.params.id, codes[0] || null, codes.join(','), replyTo, subject, threadId]);
      } catch (e) { console.error('request-delivery watch:', e.message); }
    }

    res.json({ ok: true, sentTo: replyTo, count: codes.length });
  } catch (err) {
    console.error('Request delivery error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Vendors (+ their items) from this project's finish schedule, for order auto-fill
app.get('/projects/:id/schedule-vendors', requireAuth, async (req, res) => {
  try {
    const { rows: [p] } = await pool.query('SELECT finish_schedule_url, rec_lighting_source, range_hood_source, jedco_source, bifold_source, sliding_door_source FROM projects WHERE id=$1', [req.params.id]);
    if (!p || !p.finish_schedule_url) return res.json({ ok: true, vendors: [], note: 'No finish schedule linked. Add one via Edit Project.' });
    const vendors = await readScheduleVendors(p.finish_schedule_url, { recSource: p.rec_lighting_source, rangeHoodSource: p.range_hood_source, jedcoSource: p.jedco_source, bifoldSource: p.bifold_source, slidingSource: p.sliding_door_source });
    res.json({ ok: true, vendors });
  } catch (err) {
    console.error('schedule-vendors:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Command terminal ────────────────────────────────────────────────────────────
// Natural-language command bar. With ANTHROPIC_API_KEY set, commands go to Claude
// with tools over the app's real data (projects, materials, deliveries, subs,
// contractor search); anything with a side effect comes back as a one-line preview
// the user confirms with Enter. Without the key, a keyword parser covers the basic
// vendor-email commands. Sends reuse the normal routes (/rfq, /item-mark) so
// threading, status bumps and stamps behave exactly like the dialogs.
const TERM_TYPES = [
  { type: 'damage', re: /damag/ , label: 'Damage report' },
  { type: 'replacement', re: /replac/, label: 'Replacement request' },
  { type: 'quote', re: /\b(quote|rfq|pricing|prices?)\b/, label: 'Quote request' },
  { type: 'order', re: /\border\b/, label: 'Order' },
  { type: 'delivery', re: /deliver/, label: 'Delivery request' },
];
// Checked in order; each match is consumed from the text so "shower door" never
// also matches the generic door→1a rule.
const TERM_CATS = [
  { code: '3e', re: /shower\s*doors?/g },
  { code: '2e', re: /water\s*heaters?/g },
  { code: '1b', re: /rough\s*plumb\w*|shower\s*(pan|base|drain)s?|bath\s*fans?|\bfans?\b/g },
  { code: '2d', re: /finish\s*plumb\w*|range\s*hoods?|faucets?|hoods?|light\s*fixtures?|sconces?|toilets?|sinks?/g },
  { code: '1e', re: /recessed|rec\.?\s*light\w*|can\s*lights?/g },
  { code: '3c', re: /cabinet\s*hardware|knobs?|pulls?\b/g },
  { code: '3a', re: /counter\s*tops?|countertops?/g },
  { code: '3b', re: /appliances?|fridge|refrigerator|\branges?\b|washer|dryer|dishwasher/g },
  { code: '1c', re: /\bhvac\b|registers?|thermostats?/g },
  { code: '2a', re: /millwork|baseboards?|casings?|crown/g },
  { code: '1d', re: /\btiles?\b/g },
  { code: '2b', re: /floor\w*/g },
  { code: '2c', re: /deck\w*/g },
  { code: '4a', re: /roof\w*/g },
  { code: '5a', re: /solar/g },
  { code: '1a', re: /doors?|windows?|bifold|sliding/g },
];
const TERM_HELP = 'Try: "order the doors and windows" · "request delivery of the appliances" · "get a quote for flooring" · "report damage on the shower doors" · "whats still not ordered on milton" · "email me the outstanding orders" · "find me the top 10 framing contractors in la and add them to subs". Add "draft" to any email command for a Gmail draft. On the home terminal, name the job in the command.';
function termNormName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Resolve category codes → one vendor + their schedule items → the exact payload the
// ✉ dialog would send to /projects/:id/rfq. Shared by the keyword parser and the AI.
async function resolveVendorEmailAction(project, codes, t, opts = {}) {
  if (!project.finish_schedule_url) return { ok: false, reply: project.address + ' has no finish schedule linked — add one via Edit Project, or use the ✉ Email a vendor dialog.' };
  const vendors = await readScheduleVendors(project.finish_schedule_url, { recSource: project.rec_lighting_source, rangeHoodSource: project.range_hood_source, jedcoSource: project.jedco_source, bifoldSource: project.bifold_source, slidingSource: project.sliding_door_source });
  let candidates = vendors.map(v => ({ ...v, items: v.items.filter(it => codes.includes(it.code)) })).filter(v => v.items.length);
  if (!candidates.length) return { ok: false, reply: 'No schedule items found under ' + codes.join(', ') + ' for ' + project.address + '.' };
  const nameHint = opts.vendorName || opts.rawText || '';
  const named = candidates.filter(v => {
    const firstWord = v.name.toLowerCase().split(/\s+/)[0];
    return termNormName(nameHint).includes(termNormName(v.name)) || (firstWord.length > 3 && nameHint.toLowerCase().includes(firstWord));
  });
  if (named.length === 1) candidates = named;
  if (candidates.length > 1) return { ok: false, reply: 'Those items come from ' + candidates.length + ' vendors: ' + candidates.map(v => v.name + ' (' + v.items.length + ')').join(' · ') + '. Add the vendor name to your command.' };
  const vendor = candidates[0];
  if (/buildoly\s*stock/i.test(vendor.name)) return { ok: false, reply: 'Those ship from Buildoly Stock (our own warehouse) — use the Warehouse Outbound email in the ✉ dialog instead.' };
  const { rows: sups } = await pool.query('SELECT item_code, supplier_name, supplier_email FROM suppliers');
  const vn = termNormName(vendor.name);
  let supplierEmail = null;
  for (const r of sups) {
    const rn = termNormName(r.supplier_name);
    if (rn && (rn === vn || (rn.length >= 5 && vn.length >= 5 && (rn.includes(vn) || vn.includes(rn))))) { supplierEmail = r.supplier_email; break; }
  }
  if (!supplierEmail) return { ok: false, reply: 'No saved email for ' + vendor.name + ' — add one in Settings, or send this one through the ✉ dialog.' };
  const rowsHtml = vendor.items.map(it =>
    '<tr><td>' + escapeHtml(it.name) + '</td><td>' + escapeHtml(it.product || '') + '</td><td>' + escapeHtml(it.brand || '') + '</td><td>' + escapeHtml(it.model || '') + '</td><td>' + escapeHtml(it.finishColor || '') + '</td><td>' + escapeHtml(String(it.qty || '1')) + '</td></tr>').join('');
  const itemsHtml = '<table><tr><td><b>Item</b></td><td><b>Product</b></td><td><b>Brand</b></td><td><b>Model #</b></td><td><b>Finish/Color</b></td><td><b>Qty</b></td></tr>' + rowsHtml + '</table>';
  const coveredCodes = [...new Set(vendor.items.map(it => it.code))];
  const preview = t.label + ' → ' + vendor.name + ' <' + supplierEmail + '>  ·  ' + coveredCodes.map(c => c + ' ' + (CODE_NAME[c] || '')).join(', ') + '  ·  ' + vendor.items.length + ' item' + (vendor.items.length > 1 ? 's' : '') + '  ·  ' + project.address + (opts.note ? '  ·  note: "' + String(opts.note).slice(0, 60) + '"' : '') + (opts.asDraft ? '  ·  DRAFT (review in Gmail)' : '');
  return { ok: true, preview, action: {
    kind: 'rfq', projectId: project.id, itemCode: coveredCodes[0], supplierEmail, supplierName: vendor.name,
    emailType: t.type, itemsHtml, coveredCodes, note: String(opts.note || '').slice(0, 1000),
    orderedKeys: t.type === 'order' ? vendor.items.map(it => it.itemKey).filter(Boolean) : [], asDraft: !!opts.asDraft,
  } };
}

// Keyword fallback — works with no AI key. Handles "order/deliver/quote/damage/
// replacement + category (+ job on the home terminal)".
async function terminalRuleParse(raw, givenProjectId) {
  if (!raw || /^help$/i.test(raw)) return { ok: false, reply: TERM_HELP };
  let s = ' ' + raw.toLowerCase() + ' ';
  const asDraft = /\bdraft\b/.test(s); if (asDraft) s = s.replace(/\bdraft\b/g, ' ');
  const t = TERM_TYPES.find(x => x.re.test(s));
  if (!t) return { ok: false, reply: "I couldn't tell what to send — say order / delivery / quote / damage / replacement. " + TERM_HELP };
  const codes = [];
  for (const c of TERM_CATS) { if (c.re.test(s)) { codes.push(c.code); s = s.replace(c.re, ' '); } c.re.lastIndex = 0; }
  if (!codes.length) return { ok: false, reply: "Which materials? I recognize things like doors, windows, appliances, flooring, tile, countertops, shower doors… " + TERM_HELP };
  let project = null;
  if (givenProjectId) {
    const { rows: [p] } = await pool.query('SELECT * FROM projects WHERE id=$1', [givenProjectId]);
    project = p;
  } else {
    const words = s.replace(new RegExp('\\b(' + TERM_TYPES.map(x => x.re.source).join('|') + ')\\b', 'g'), ' ')
      .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !['the', 'and', 'for', 'its', 'time', 'get', 'send', 'please', 'request', 'need', 'now', 'them', 'this', 'that', 'job', 'project', 'from', 'with'].includes(w));
    const { rows: projs } = await pool.query('SELECT * FROM projects');
    let best = [], bestScore = 0;
    for (const p of projs) {
      const addr = (p.address + ' ' + (p.full_address || '')).toLowerCase();
      const score = words.filter(w => addr.includes(w)).length;
      if (score > bestScore) { best = [p]; bestScore = score; }
      else if (score === bestScore && score > 0) best.push(p);
    }
    if (!bestScore) return { ok: false, reply: 'Which job? End the command with part of the address — e.g. "… for silver lantern".' };
    if (best.length > 1) {
      const uc = best.filter(p => /under construction/i.test(p.phase || ''));
      if (uc.length === 1) best = uc;
      else return { ok: false, reply: 'That matches ' + best.length + ' jobs: ' + best.slice(0, 4).map(p => p.address).join(' · ') + '. Add more of the address.' };
    }
    project = best[0];
  }
  if (!project) return { ok: false, reply: 'Project not found.' };
  return resolveVendorEmailAction(project, codes, t, { rawText: raw, asDraft });
}

// ── AI terminal (needs ANTHROPIC_API_KEY) ──────────────────────────────────────
const TERMINAL_AI_MODEL = process.env.TERMINAL_AI_MODEL || 'claude-haiku-4-5-20251001';
async function callTerminalAI(system, messages, tools) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: TERMINAL_AI_MODEL, max_tokens: 1400, system, messages, tools }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('AI: ' + ((d.error && d.error.message) || 'HTTP ' + r.status).slice(0, 200));
  return d;
}
const TERMINAL_TOOLS = [
  { name: 'list_projects', description: 'List projects (id, address, phase, super). Use to resolve which job the user means.', input_schema: { type: 'object', properties: { phase: { type: 'string', description: 'optional filter, e.g. "Under Construction"' } } } },
  { name: 'project_materials', description: "A project's material items with live delivery state (delivered/scheduled/ordered/not seen) plus bucket-level board statuses and delivery dates.", input_schema: { type: 'object', properties: { project_id: { type: 'integer' }, filter: { type: 'string', enum: ['all', 'outstanding', 'delivered', 'scheduled'] } }, required: ['project_id'] } },
  { name: 'outstanding_orders', description: 'Material buckets not yet ordered (status Not yet placed / RFQ sent / Delivery Requested), across all projects or one.', input_schema: { type: 'object', properties: { project_id: { type: 'integer' } } } },
  { name: 'upcoming_deliveries', description: 'Deliveries scheduled in the next N days (board dates + pending approval notices + Ferguson windows).', input_schema: { type: 'object', properties: { days: { type: 'integer' } } } },
  { name: 'schedule_vendors', description: "Vendors on a project's finish schedule with their category codes and item counts — check before send_vendor_email when the vendor is ambiguous.", input_schema: { type: 'object', properties: { project_id: { type: 'integer' } }, required: ['project_id'] } },
  { name: 'email_history', description: 'Recently SENT emails, newest first: branded delivery notices to on-site contacts, and vendor emails (orders / RFQs / delivery requests / damage / replacement). Use for "when did the last X email go out".', input_schema: { type: 'object', properties: { project_id: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'search_subs', description: 'Search the subcontractor/GC database (company, trade type, status, contact).', input_schema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'find_contractors_online', description: 'Live contractor search (Google Places / Yelp) with ratings + review counts. Use for "find me the top N <trade> contractors in <area>".', input_schema: { type: 'object', properties: { term: { type: 'string', description: 'e.g. "framing contractor"' }, location: { type: 'string', description: 'e.g. "Los Angeles, CA"' } }, required: ['term'] } },
  { name: 'send_vendor_email', description: 'ACTION — compose a vendor email (order / delivery / quote / damage / replacement) for material categories on a project. The user confirms before it sends.', input_schema: { type: 'object', properties: { project_id: { type: 'integer' }, category_codes: { type: 'array', items: { type: 'string' } }, email_type: { type: 'string', enum: ['order', 'delivery', 'quote', 'damage', 'replacement'] }, vendor_name: { type: 'string' }, note: { type: 'string', description: 'optional extra sentence(s) to include in the email body' }, as_draft: { type: 'boolean' } }, required: ['project_id', 'category_codes', 'email_type'] } },
  { name: 'email_me', description: 'ACTION — email a report/summary to Logan himself. Body is plain text.', input_schema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] } },
  { name: 'mark_item', description: "ACTION — set a material item's delivery state on the checklist (delivered / scheduled / ordered, or auto to clear the manual mark).", input_schema: { type: 'object', properties: { project_id: { type: 'integer' }, item_query: { type: 'string', description: 'item name or prod code to match' }, state: { type: 'string', enum: ['delivered', 'scheduled', 'ordered', 'auto'] }, when: { type: 'string', description: 'delivery date if scheduled' } }, required: ['project_id', 'item_query', 'state'] } },
  { name: 'add_subs_under_review', description: 'ACTION — add contractors to the Subs database under "Under Review" (e.g. results from find_contractors_online). Include rating/reviews in each notes field.', input_schema: { type: 'object', properties: { subs: { type: 'array', items: { type: 'object', properties: { company: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' }, email: { type: 'string' }, type: { type: 'string', description: 'trade, e.g. Framing' }, notes: { type: 'string' } }, required: ['company'] } } }, required: ['subs'] } },
  { name: 'update_sub_status', description: 'ACTION — move existing subs to a new status (Under Review / Bid Under Review / Active / Approved / Inactive).', input_schema: { type: 'object', properties: { sub_ids: { type: 'array', items: { type: 'integer' } }, status: { type: 'string' } }, required: ['sub_ids', 'status'] } },
];
const TERMINAL_READS = {
  async list_projects(inp) {
    const { rows } = await pool.query('SELECT id, address, phase, super_email FROM projects ORDER BY id');
    let out = rows.map(p => ({ id: p.id, address: p.address, phase: p.phase, super: (parseSuperEmails(p.super_email)[0] || {}).name || '' }));
    if (inp.phase) out = out.filter(p => (p.phase || '').toLowerCase().includes(String(inp.phase).toLowerCase()));
    return out;
  },
  async project_materials(inp) {
    const { expected } = await projectItemStates(inp.project_id);
    const { rows: buckets } = await pool.query('SELECT item_code, status, delivery_date FROM project_items WHERE project_id=$1', [inp.project_id]);
    let items = expected.map(e => ({ cat: e.category_code, code: e.prod_code, name: e.name, qty: e.qty, supplier: e.supplier, state: e.delivered ? 'delivered' : e.scheduled ? 'scheduled' : e.onOrder ? 'ordered' : 'not seen', when: e.schedWhen || undefined }));
    const f = inp.filter || 'all';
    if (f === 'outstanding') items = items.filter(i => i.state !== 'delivered');
    if (f === 'delivered') items = items.filter(i => i.state === 'delivered');
    if (f === 'scheduled') items = items.filter(i => i.state === 'scheduled');
    return { buckets: buckets.map(b => ({ code: b.item_code, name: CODE_NAME[b.item_code] || b.item_code, status: b.status, delivery_date: b.delivery_date })), items: items.slice(0, 100), itemsTruncated: items.length > 100 };
  },
  async outstanding_orders(inp) {
    const params = []; let where = "pi.status IN ('Not yet placed','RFQ sent','Delivery Requested')";
    if (inp.project_id) { params.push(inp.project_id); where += ' AND pi.project_id=$1'; }
    const { rows } = await pool.query(`SELECT pi.project_id, p.address, pi.item_code, pi.status, pi.order_date FROM project_items pi JOIN projects p ON p.id=pi.project_id WHERE ${where} AND p.phase ILIKE '%construction%' ORDER BY p.address, pi.item_code LIMIT 200`, params);
    return rows.map(r => ({ project: r.address, category: r.item_code + ' ' + (CODE_NAME[r.item_code] || ''), status: r.status }));
  },
  async upcoming_deliveries(inp) {
    const days = Math.min(Math.max(Number(inp.days) || 7, 1), 60);
    const { rows: board } = await pool.query(`SELECT p.address, pi.item_code, pi.status, pi.delivery_date FROM project_items pi JOIN projects p ON p.id=pi.project_id WHERE pi.delivery_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1::text || ' days')::interval AND pi.status NOT IN ('Delivered','Delivered from Inv.','N/A') ORDER BY pi.delivery_date LIMIT 60`, [days]);
    const { rows: pend } = await pool.query("SELECT pdn.job_name, pdn.codes, pdn.delivery_window, pdn.method, pdn.status FROM pending_delivery_notices pdn WHERE pdn.status='pending' ORDER BY pdn.created_at DESC LIMIT 20");
    return {
      board: board.map(r => ({ project: r.address, category: r.item_code + ' ' + (CODE_NAME[r.item_code] || ''), date: r.delivery_date })),
      awaiting_approval: pend.map(r => ({ job: r.job_name, codes: r.codes, window: r.delivery_window, method: r.method })),
    };
  },
  async schedule_vendors(inp) {
    const { rows: [p] } = await pool.query('SELECT * FROM projects WHERE id=$1', [inp.project_id]);
    if (!p || !p.finish_schedule_url) return { error: 'No finish schedule linked.' };
    const vendors = await readScheduleVendors(p.finish_schedule_url, { recSource: p.rec_lighting_source, rangeHoodSource: p.range_hood_source, jedcoSource: p.jedco_source, bifoldSource: p.bifold_source, slidingSource: p.sliding_door_source });
    return vendors.map(v => ({ name: v.name, categories: [...new Set(v.items.map(i => i.code))], items: v.items.length }));
  },
  async email_history(inp) {
    const lim = Math.min(Math.max(Number(inp.limit) || 15, 1), 40);
    const params = []; let w = '';
    if (inp.project_id) { params.push(inp.project_id); w = ' WHERE x.project_id=$1'; }
    const { rows: notices } = await pool.query(
      `SELECT x.sent_at, p.address, x.method, x.codes, x.items FROM delivery_notices x JOIN projects p ON p.id=x.project_id${w} ORDER BY x.sent_at DESC LIMIT ${lim}`, params);
    const { rows: vemails } = await pool.query(
      `SELECT x.sent_at, p.address, x.email_type, x.subject, x.supplier_name, x.supplier_email FROM vendor_emails x JOIN projects p ON p.id=x.project_id${w} ORDER BY x.sent_at DESC LIMIT ${lim}`, params);
    return { delivery_notices_to_site_contact: notices, vendor_emails: vemails };
  },
  async search_subs(inp) {
    const lim = Math.min(Math.max(Number(inp.limit) || 20, 1), 40);
    const params = []; const conds = [];
    if (inp.query) { params.push('%' + inp.query + '%'); conds.push(`(company ILIKE $${params.length} OR type ILIKE $${params.length} OR COALESCE(notes,'') ILIKE $${params.length})`); }
    if (inp.status) { params.push('%' + inp.status + '%'); conds.push(`status ILIKE $${params.length}`); }
    const { rows } = await pool.query(`SELECT id, company, type, status, location, owner, email, phone FROM subcontractors ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY company LIMIT ${lim}`, params);
    return rows;
  },
  async find_contractors_online(inp) {
    const term = String(inp.term || '').slice(0, 80);
    const location = String(inp.location || 'Los Angeles, CA').slice(0, 80);
    const providers = [];
    if (process.env.YELP_API_KEY) providers.push(yelpSearch(term, location).catch(e => ({ err: e.message })));
    if (process.env.GOOGLE_PLACES_API_KEY) providers.push(googlePlacesSearch(term, location).catch(e => ({ err: e.message })));
    if (!providers.length) return { error: 'No Yelp/Google Places API key configured.' };
    const settled = await Promise.all(providers);
    const all = settled.filter(Array.isArray).flat();
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const seen = new Set(); const merged = [];
    for (const b of all) { const k = norm(b.name); if (!k || seen.has(k)) continue; seen.add(k); merged.push(b); }
    merged.sort((a, b) => ((b.rating || 0) - (a.rating || 0)) || ((b.reviews || 0) - (a.reviews || 0)));
    return merged.slice(0, 25).map(b => ({ name: b.name, phone: b.phone, address: b.address, rating: b.rating, reviews: b.reviews, tags: b.tags, source: b.source }));
  },
};
const TERMINAL_ACTIONS = {
  async send_vendor_email(inp) {
    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE id=$1', [inp.project_id]);
    if (!project) return { ok: false, reply: 'Project ' + inp.project_id + ' not found.' };
    const t = TERM_TYPES.find(x => x.type === inp.email_type) || TERM_TYPES[3];
    const codes = (inp.category_codes || []).filter(c => CODE_NAME[c]);
    if (!codes.length) return { ok: false, reply: 'No valid material categories given.' };
    return resolveVendorEmailAction(project, codes, t, { vendorName: inp.vendor_name || '', note: inp.note || '', asDraft: !!inp.as_draft });
  },
  async email_me(inp) {
    const subject = String(inp.subject || 'Buildoly report').slice(0, 150);
    const body = String(inp.body || '').slice(0, 8000);
    const to = process.env.GMAIL_USER || 'logan@buildoly.com';
    return { ok: true, preview: 'Email to you <' + to + '>  ·  "' + subject + '"  ·  ' + body.split('\n').length + ' lines', action: { kind: 'email_me', subject, body } };
  },
  async mark_item(inp) {
    const { rows: [project] } = await pool.query('SELECT id, address FROM projects WHERE id=$1', [inp.project_id]);
    if (!project) return { ok: false, reply: 'Project ' + inp.project_id + ' not found.' };
    const { expected } = await projectItemStates(project.id);
    const q = termNormName(inp.item_query);
    const scored = expected.map(e => {
      const hay = termNormName(e.name + ' ' + (e.prod_code || '') + ' ' + (e.model_no || ''));
      return { e, hit: q && hay.includes(q) ? q.length : 0 };
    }).filter(x => x.hit).sort((a, b) => b.hit - a.hit);
    if (!scored.length) return { ok: false, reply: 'No item matching "' + inp.item_query + '" on ' + project.address + '. Try part of the name or the prod code.' };
    if (scored.length > 1 && scored[0].hit === scored[1].hit && scored[0].e.name !== scored[1].e.name) {
      return { ok: false, reply: 'That matches several items: ' + scored.slice(0, 4).map(x => x.e.name + ' (' + (x.e.prod_code || '—') + ')').join(' · ') + '. Be more specific.' };
    }
    const e = scored[0].e;
    const state = inp.state === 'auto' ? '' : inp.state;
    const icon = state === 'delivered' ? '✅' : state === 'scheduled' ? '🚚' : state === 'ordered' ? '📦' : '↩ auto';
    return { ok: true, preview: 'Mark ' + icon + ' ' + (state || 'automatic') + ' — ' + e.name + ' (' + (e.prod_code || '—') + ')  ·  ' + project.address + (inp.when ? '  ·  ' + inp.when : ''), action: { kind: 'item-mark', projectId: project.id, key: e.key, state, when: String(inp.when || '').slice(0, 80) } };
  },
  async add_subs_under_review(inp) {
    const subs = (inp.subs || []).filter(s => s && s.company).slice(0, 25);
    if (!subs.length) return { ok: false, reply: 'No contractors to add.' };
    const clean = subs.map(s => ({ company: String(s.company).slice(0, 150), phone: String(s.phone || '').slice(0, 40), address: String(s.address || '').slice(0, 200), email: String(s.email || '').slice(0, 150), type: String(s.type || '').slice(0, 60), notes: String(s.notes || '').slice(0, 400) }));
    return { ok: true, preview: 'Add ' + clean.length + ' contractor' + (clean.length > 1 ? 's' : '') + ' to Subs → Under Review: ' + clean.slice(0, 5).map(s => s.company).join(', ') + (clean.length > 5 ? ' +' + (clean.length - 5) + ' more' : ''), action: { kind: 'add_subs', subs: clean } };
  },
  async update_sub_status(inp) {
    const ids = (inp.sub_ids || []).map(Number).filter(Number.isInteger).slice(0, 40);
    const status = String(inp.status || '').trim().slice(0, 40);
    if (!ids.length || !status) return { ok: false, reply: 'Need sub ids and a status.' };
    const { rows } = await pool.query('SELECT id, company FROM subcontractors WHERE id = ANY($1)', [ids]);
    if (!rows.length) return { ok: false, reply: 'No matching subs found.' };
    return { ok: true, preview: 'Move ' + rows.length + ' sub' + (rows.length > 1 ? 's' : '') + ' to "' + status + '": ' + rows.slice(0, 5).map(r => r.company).join(', ') + (rows.length > 5 ? ' +' + (rows.length - 5) + ' more' : ''), action: { kind: 'sub_status', subIds: rows.map(r => r.id), status } };
  },
};
function terminalSystemPrompt(projectCtx) {
  return 'You are the command terminal inside Buildoly Office — Logan Hauser\'s construction ops app (ADUs in the Los Angeles area). Today is ' + new Date().toISOString().slice(0, 10) + '.\n'
    + 'Material categories: ' + Object.entries(CODE_NAME).map(([c, n]) => c + '=' + n).join(', ') + '.\n'
    + (projectCtx ? 'The user is on the project page for: ' + projectCtx.address + ' (project_id ' + projectCtx.id + '). Commands refer to this project unless they name another.\n' : 'The user is on the home page — resolve which project they mean via list_projects.\n')
    + 'Rules: look up real data with tools before answering; never invent numbers. Action tools (send_vendor_email, email_me, mark_item, add_subs_under_review, update_sub_status) are previewed to the user for confirmation — call one only when the user asked for that action, with complete arguments, and at most ONE action per command. For reports the user wants emailed, gather the data first, then call email_me with a clean plain-text body. Answers print in a raw monospace terminal that does NOT render markdown — asterisks and hashes show literally, so never use them; plain text and simple "-" lists only, and keep it brief. If the user asks for "top N by rating", sort by rating then review count.';
}
async function terminalAiParse(raw, givenProjectId, history) {
  let projectCtx = null;
  if (givenProjectId) {
    const { rows: [p] } = await pool.query('SELECT id, address FROM projects WHERE id=$1', [givenProjectId]);
    if (p) projectCtx = p;
  }
  const messages = [];
  // Merge consecutive same-role entries — the API requires strict user/assistant alternation.
  (Array.isArray(history) ? history.slice(-8) : []).forEach(h => {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim()) {
      const txt = String(h.text).slice(0, 600);
      if (messages.length && messages[messages.length - 1].role === h.role) messages[messages.length - 1].content += '\n' + txt;
      else messages.push({ role: h.role, content: txt });
    }
  });
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += '\n' + raw.slice(0, 500);
  else messages.push({ role: 'user', content: raw.slice(0, 500) });
  const system = terminalSystemPrompt(projectCtx);
  for (let round = 0; round < 6; round++) {
    const resp = await callTerminalAI(system, messages, TERMINAL_TOOLS);
    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!toolUses.length) return { ok: true, reply: text || '…' };
    const act = toolUses.find(tu => TERMINAL_ACTIONS[tu.name]);
    if (act) return TERMINAL_ACTIONS[act.name](act.input || {});
    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      let out;
      try { out = TERMINAL_READS[tu.name] ? await TERMINAL_READS[tu.name](tu.input || {}) : { error: 'unknown tool' }; }
      catch (e) { out = { error: e.message }; }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 14000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { ok: false, reply: 'That took too many lookups — try breaking it into smaller commands.' };
}

app.post('/terminal/parse', requireAuth, async (req, res) => {
  try {
    const raw = String((req.body || {}).command || '').trim();
    const givenProjectId = (req.body || {}).projectId || null;
    if (!raw) return res.json({ ok: false, reply: TERM_HELP });
    if (process.env.ANTHROPIC_API_KEY && !/^help$/i.test(raw)) {
      try { return res.json(await terminalAiParse(raw, givenProjectId, (req.body || {}).history)); }
      catch (e) {
        console.error('terminal AI:', e.message);
        const fb = await terminalRuleParse(raw, givenProjectId);
        fb.reply = (fb.reply ? fb.reply + ' ' : '') + '(AI unavailable: ' + e.message.slice(0, 80) + ')';
        return res.json(fb);
      }
    }
    res.json(await terminalRuleParse(raw, givenProjectId));
  } catch (err) {
    console.error('terminal/parse:', err.message);
    res.status(500).json({ ok: false, reply: 'Error: ' + err.message });
  }
});

// Execute a confirmed terminal action that has no existing route of its own.
// (Vendor emails go through /projects/:id/rfq and item marks through /item-mark.)
app.post('/terminal/execute', requireAuth, async (req, res) => {
  try {
    const a = (req.body || {}).action || {};
    if (a.kind === 'email_me') {
      if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email is not configured.' });
      const to = process.env.GMAIL_USER || 'logan@buildoly.com';
      const body = String(a.body || '').slice(0, 8000);
      const html = '<div style="font-family:ui-monospace,Consolas,monospace;font-size:13px;color:#222;white-space:pre-wrap">' + escapeHtml(body) + '</div>';
      await sendMail({ to, subject: String(a.subject || 'Buildoly report').slice(0, 150), html });
      return res.json({ ok: true, done: 'Sent to ' + to });
    }
    if (a.kind === 'add_subs') {
      const subs = (a.subs || []).filter(s => s && s.company).slice(0, 25);
      let added = 0;
      for (const s of subs) {
        const type = normalizeType(String(s.type || '').slice(0, 60)) || null;
        const cat = /general\s*contractor|^\s*gc\b/i.test(type || '') ? 'gc' : 'sub';
        const grp = bucketForStatus(cat, 'Under Review');
        const so = await bucketSortOrder(cat, grp);
        await pool.query(
          `INSERT INTO subcontractors (company, location, type, status, email, phone, notes, group_label, category, sort_order, referenced_by, recent_add)
           VALUES ($1,$2,$3,'Under Review',$4,$5,$6,$7,$8,$9,'Terminal search',TRUE)`,
          [String(s.company).slice(0, 150), String(s.address || '').slice(0, 200) || null, type, String(s.email || '').slice(0, 150) || null, String(s.phone || '').slice(0, 40) || null, String(s.notes || '').slice(0, 400) || null, grp, cat, so]);
        added++;
      }
      return res.json({ ok: true, done: 'Added ' + added + ' to Subs → Under Review' });
    }
    if (a.kind === 'sub_status') {
      const ids = (a.subIds || []).map(Number).filter(Number.isInteger).slice(0, 40);
      const status = String(a.status || '').trim().slice(0, 40);
      if (!ids.length || !status) return res.status(400).json({ ok: false, error: 'Bad action.' });
      let moved = 0;
      for (const id of ids) {
        const { rows: [cur] } = await pool.query('SELECT category FROM subcontractors WHERE id=$1', [id]);
        if (!cur) continue;
        const grp = bucketForStatus(cur.category || 'sub', status);
        const so = await bucketSortOrder(cur.category || 'sub', grp);
        await pool.query('UPDATE subcontractors SET status=$1, group_label=$2, sort_order=$3 WHERE id=$4', [status, grp, so, id]);
        moved++;
      }
      return res.json({ ok: true, done: 'Moved ' + moved + ' sub' + (moved !== 1 ? 's' : '') + ' to ' + status });
    }
    res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error('terminal/execute:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Remove a vendor-email entry from the app's thread list (does NOT delete from Gmail)
app.post('/vendor-emails/:id/delete', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM vendor_emails WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Full finish schedule (read live from the sheet) for the verify tab
app.get('/projects/:id/finish-schedule', requireAuth, async (req, res) => {
  try {
    const { rows: [p] } = await pool.query('SELECT finish_schedule_url FROM projects WHERE id=$1', [req.params.id]);
    if (!p || !p.finish_schedule_url) return res.json({ ok: true, items: [], note: 'No finish schedule linked. Add one via Edit Project.' });
    const items = await readScheduleRows(p.finish_schedule_url);
    res.json({ ok: true, items });
  } catch (err) {
    console.error('finish-schedule:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Schedule items grouped by material category (for the Materials tab drill-down)
app.get('/projects/:id/schedule-by-category', requireAuth, async (req, res) => {
  try {
    const { rows: [p] } = await pool.query('SELECT finish_schedule_url, rec_lighting_source, range_hood_source, jedco_source, bifold_source, sliding_door_source FROM projects WHERE id=$1', [req.params.id]);
    if (!p || !p.finish_schedule_url) return res.json({ ok: true, byCode: {}, note: 'No finish schedule linked.' });
    const byCode = await readScheduleByCategory(p.finish_schedule_url, { recSource: p.rec_lighting_source, rangeHoodSource: p.range_hood_source, jedcoSource: p.jedco_source, bifoldSource: p.bifold_source, slidingSource: p.sliding_door_source });
    // Attach saved delivery progress to held items (allocated qty + how many delivered)
    const { rows: hs } = await pool.query('SELECT item_key, status, delivered_qty FROM held_item_status WHERE project_id=$1', [req.params.id]);
    const hsMap = Object.fromEntries(hs.map(r => [r.item_key, r]));
    for (const code of Object.keys(byCode)) {
      for (const it of byCode[code]) {
        if (it.held) {
          const alloc = parseFloat(it.qty) || 1;
          it.allocQty = alloc;
          it.deliveredQty = deliveredQtyOf(hsMap[it.itemKey], alloc);
          it.officeStatus = it.deliveredQty >= alloc ? 'Delivered' : 'In Office';
        }
      }
    }
    res.json({ ok: true, byCode, rangeHoodSource: p.range_hood_source || 'default', jedcoSource: p.jedco_source || 'default', heldStatuses: HELD_STATUSES });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Save a held item's delivery progress for this project. Two modes:
//  • { item_key, delivered_qty }  → partial: N of the allocated units delivered
//  • { item_key, status }         → legacy binary toggle (In Office / Delivered)
app.post('/projects/:id/held-status', requireAuth, async (req, res) => {
  try {
    const itemKey = String(req.body.item_key || '').trim();
    if (!itemKey) return res.status(400).json({ ok: false, error: 'Missing item key.' });

    if (req.body.delivered_qty !== undefined && req.body.delivered_qty !== null && req.body.delivered_qty !== '') {
      const dq = Math.max(0, Math.floor(Number(req.body.delivered_qty) || 0));
      const status = dq > 0 ? 'Delivered' : 'In Office';
      await pool.query(
        `INSERT INTO held_item_status (project_id, item_key, status, delivered_qty, updated_at) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (project_id, item_key) DO UPDATE SET status=EXCLUDED.status, delivered_qty=EXCLUDED.delivered_qty, updated_at=NOW()`,
        [req.params.id, itemKey, status, dq]
      );
      return res.json({ ok: true, delivered_qty: dq, status });
    }

    // Legacy binary toggle — clear delivered_qty so the status drives it.
    const status = HELD_STATUSES.includes(req.body.status) ? req.body.status : 'In Office';
    await pool.query(
      `INSERT INTO held_item_status (project_id, item_key, status, delivered_qty, updated_at) VALUES ($1,$2,$3,NULL,NOW())
       ON CONFLICT (project_id, item_key) DO UPDATE SET status=EXCLUDED.status, delivered_qty=NULL, updated_at=NOW()`,
      [req.params.id, itemKey, status]
    );
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Toggle who supplies recessed lighting: 'gc' (contractor procures) or 'oncall' (On Call LED)
app.post('/projects/:id/rec-lighting-source', requireAuth, async (req, res) => {
  try {
    const src = req.body.source === 'oncall' ? 'oncall' : 'gc';
    await pool.query('UPDATE projects SET rec_lighting_source=$1 WHERE id=$2', [src, req.params.id]);
    res.json({ ok: true, source: src });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Toggle where the 3-panel bifold comes from: 'buildoly' (our stock — default) or 'vendor'
app.post('/projects/:id/bifold-source', requireAuth, async (req, res) => {
  try {
    const src = req.body.source === 'vendor' ? 'vendor' : 'buildoly';
    await pool.query('UPDATE projects SET bifold_source=$1 WHERE id=$2', [src, req.params.id]);
    res.json({ ok: true, source: src });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Toggle where the sliding glass door comes from: 'vendor' (default — we don't carry it) or 'buildoly'
app.post('/projects/:id/sliding-door-source', requireAuth, async (req, res) => {
  try {
    const src = req.body.source === 'buildoly' ? 'buildoly' : 'vendor';
    await pool.query('UPDATE projects SET sliding_door_source=$1 WHERE id=$2', [src, req.params.id]);
    res.json({ ok: true, source: src });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Toggle who supplies the range hood: 'default' (schedule vendor) or 'buildoly' (Buildoly office stock)
app.post('/projects/:id/range-hood-source', requireAuth, async (req, res) => {
  try {
    const src = req.body.source === 'buildoly' ? 'buildoly' : 'default';
    await pool.query('UPDATE projects SET range_hood_source=$1 WHERE id=$2', [src, req.params.id]);
    res.json({ ok: true, source: src });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Set/clear a project's finish-schedule sheet link (inline from the main grid)
app.post('/projects/:id/finish-schedule-url', requireAuth, async (req, res) => {
  try {
    const url = (req.body.url || '').trim() || null;
    await pool.query('UPDATE projects SET finish_schedule_url=$1 WHERE id=$2', [url, req.params.id]);
    res.json({ ok: true, linked: !!url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Toggle who supplies Jedco items: 'default' (JEDCO) or 'buildoly' (Buildoly office stock)
app.post('/projects/:id/jedco-source', requireAuth, async (req, res) => {
  try {
    const src = req.body.source === 'buildoly' ? 'buildoly' : 'default';
    await pool.query('UPDATE projects SET jedco_source=$1 WHERE id=$2', [src, req.params.id]);
    res.json({ ok: true, source: src });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Assign the superintendent(s) running this project — one or more, comma-separated.
// They each get @mentioned on this project's delivery alerts.
app.post('/projects/:id/super', requireAuth, async (req, res) => {
  try {
    let emails = req.body.emails;
    if (!Array.isArray(emails)) emails = req.body.email ? [req.body.email] : [];
    const valid = emails.map(e => String(e).trim().toLowerCase()).filter(e => findSuper(e));
    const val = [...new Set(valid)].join(',');
    await pool.query('UPDATE projects SET super_email=$1 WHERE id=$2', [val || null, req.params.id]);
    res.json({ ok: true, emails: valid });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Site contacts (extra supers + outsourced GCs) ─────────────────────────────
// Add a person who can be assigned as a job-site contact on any project and receive
// the delivery notice. Contacts only — no login, no Chat mention.
app.post('/contacts', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').replace(/[<>]/g, '').trim();   // strip angle brackets — never let markup into the name
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').replace(/[<>]/g, '').trim();
    const role = req.body.role === 'gc' ? 'gc' : 'super';
    if (!name || !email) return res.status(400).json({ ok: false, error: 'Name and email are both required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    if (allContacts().some(c => c.email.toLowerCase() === email)) return res.status(400).json({ ok: false, error: 'That email is already on the contact list.' });
    const { rows: [row] } = await pool.query(
      'INSERT INTO people (name, email, phone, role) VALUES ($1,$2,$3,$4) RETURNING id', [name, email, phone || null, role]);
    await loadPeople();
    res.json({ ok: true, contact: { id: row.id, name, email, phone, role } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// Edit an added contact (name/email/phone/role). If the email changes, cascade it
// onto every project's super_email so existing assignments don't orphan.
app.post('/contacts/:id/edit', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const name = String(req.body.name || '').replace(/[<>]/g, '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').replace(/[<>]/g, '').trim();
    const role = req.body.role === 'gc' ? 'gc' : 'super';
    if (!name || !email) return res.status(400).json({ ok: false, error: 'Name and email are both required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    const { rows: [cur] } = await pool.query('SELECT id, email FROM people WHERE id=$1 AND active=TRUE', [id]);
    if (!cur) return res.status(404).json({ ok: false, error: 'Contact not found.' });
    const oldEmail = String(cur.email || '').toLowerCase();
    if (email !== oldEmail) {
      const { rows: dup } = await pool.query('SELECT id FROM people WHERE active=TRUE AND lower(email)=lower($1) AND id<>$2', [email, id]);
      const superClash = SUPERS.some(s => s.email.toLowerCase() === email);
      if (dup.length || superClash) return res.status(400).json({ ok: false, error: 'That email is already used by another contact.' });
    }
    await pool.query('UPDATE people SET name=$1, email=$2, phone=$3, role=$4 WHERE id=$5', [name, email, phone || null, role, id]);
    let reassigned = 0;
    if (email !== oldEmail) {
      const { rows: projs } = await pool.query("SELECT id, super_email FROM projects WHERE super_email ILIKE $1", ['%' + oldEmail + '%']);
      for (const p of projs) {
        const list = String(p.super_email || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        if (!list.includes(oldEmail)) continue;   // ILIKE substring guard — only touch exact-token matches
        const next = [...new Set(list.map(e => e === oldEmail ? email : e))].join(',');
        await pool.query('UPDATE projects SET super_email=$1 WHERE id=$2', [next || null, p.id]);
        reassigned++;
      }
    }
    await loadPeople();
    res.json({ ok: true, contact: { id: Number(id), name, email, phone, role }, reassigned });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/contacts/:id/delete', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE people SET active = FALSE WHERE id = $1', [req.params.id]);
    await loadPeople();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Contacts manager — view/edit added supers & GCs (and their emails).
app.get('/contacts', requireAuth, async (req, res) => {
  try {
    await initDb();
    const people = DYNAMIC_PEOPLE.slice().sort((a, b) => (a.role === b.role ? String(a.name).localeCompare(String(b.name)) : (a.role === 'gc' ? 1 : -1)));
    const builtins = SUPERS.map(s => ({ name: s.name, email: s.email }));
    const { rows } = await pool.query("SELECT super_email FROM projects WHERE super_email IS NOT NULL AND super_email <> ''");
    const counts = {};
    rows.forEach(r => String(r.super_email).split(',').map(e => e.trim().toLowerCase()).filter(Boolean).forEach(e => counts[e] = (counts[e] || 0) + 1));
    res.render('contacts', { people, builtins, counts });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ── PDF exports ───────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit');

app.get('/driving/pdf', requireAuth, async (req, res) => {
  const me = sessionKey(req);
  const { rows: trips } = await pool.query('SELECT * FROM driving_trips WHERE owner=$1 ORDER BY trip_date ASC', [me]);
  const { rows: [tot] } = await pool.query('SELECT COALESCE(SUM(miles),0) AS total FROM driving_trips WHERE owner=$1', [me]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="driving-log.pdf"');
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  doc.pipe(res);
  doc.fontSize(18).text('Driving Log — Mileage', { align: 'left' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666').text('Buildoly · logan@buildoly.com');
  doc.moveDown(0.8).fillColor('#000');
  doc.fontSize(11);
  trips.forEach(t => {
    const d = new Date(t.trip_date).toLocaleDateString();
    doc.font('Helvetica-Bold').text(d + '   ' + Number(t.miles).toFixed(1) + ' mi', { continued: false });
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(t.route_text || '', { indent: 10 });
    doc.fontSize(11).fillColor('#000').moveDown(0.4);
  });
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(13)
    .text('Total: ' + Number(tot.total).toFixed(1) + ' miles');
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

// ── Deliveries dashboard ──────────────────────────────────────────────────────

const ITEM_NAME = {};
ALL_ITEMS.forEach(i => ITEM_NAME[i.code] = i.name);

// One click: email every vendor whose delivery is due tomorrow, inside their RFQ thread
app.post('/deliveries/confirm-tomorrow', requireAuth, async (req, res) => {
  try {
    const out = await sendDeliveryConfirmations();
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/deliveries', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows } = await pool.query(`
      SELECT pi.item_code, pi.status, pi.delivery_date, pi.delivery_date_end, p.id AS project_id, p.address
      FROM project_items pi JOIN projects p ON p.id = pi.project_id
      WHERE pi.delivery_date IS NOT NULL AND pi.status NOT IN ('Delivered','Delivered from Inv.','N/A')
      ORDER BY pi.delivery_date ASC
    `);
    const items = rows.map(r => ({ ...r, item_name: ITEM_NAME[r.item_code] || r.item_code }));
    // Ferguson shipment/appliance alerts from the last 14 days, matched to projects
    let ferguson = [];
    try {
      const { rows: fu } = await pool.query(`
        SELECT f.*, p.address AS project_address FROM ferguson_updates f
        LEFT JOIN projects p ON p.id = f.project_id
        WHERE f.created_at > NOW() - INTERVAL '14 days'
        ORDER BY f.created_at DESC LIMIT 40`);
      ferguson = fu;
    } catch (e) { /* table brand new */ }
    res.render('deliveries', { items, ferguson });
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
    const me = sessionKey(req);
    const home = await getHomeAddress(me);
    const { rows: projects } = await pool.query(
      'SELECT id, address, full_address FROM projects ORDER BY address'
    );
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
    let where = 'owner=$1'; const params = [me];
    if (from) { params.push(from); where += ` AND trip_date >= $${params.length}`; }
    if (to) { params.push(to); where += ` AND trip_date <= $${params.length}`; }
    const { rows: trips } = await pool.query(`SELECT * FROM driving_trips WHERE ${where} ORDER BY trip_date DESC, id DESC`, params);
    const { rows: [tot] } = await pool.query(`SELECT COALESCE(SUM(miles),0) AS total, COUNT(*) AS cnt FROM driving_trips WHERE ${where}`, params);
    const MILEAGE_RATE = 0.725; // IRS-style reimbursement per mile
    res.render('driving', { home, projects, trips, totalMiles: tot.total, tripCount: Number(tot.cnt), from, to, rate: MILEAGE_RATE, drivingEnabled });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Save the home address
app.post('/driving/home', requireAuth, async (req, res) => {
  const { home_address } = req.body;
  const me = sessionKey(req);
  if (me) {
    await pool.query(
      `INSERT INTO user_prefs (user_key, home_address, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (user_key) DO UPDATE SET home_address = EXCLUDED.home_address, updated_at = NOW()`,
      [me, home_address || null]
    );
  }
  res.redirect('/driving');
});

// Calculate miles for a route (home → stops → home) without saving
app.post('/driving/preview', requireAuth, async (req, res) => {
  try {
    if (!drivingEnabled) return res.status(400).json({ ok: false, error: 'Set ORS_API_KEY on Railway to enable mileage.' });
    const home = await getHomeAddress(sessionKey(req));
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
      'INSERT INTO driving_trips (trip_date, route_text, miles, owner) VALUES ($1,$2,$3,$4)',
      [trip_date, route_text || null, miles, sessionKey(req)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Edit a previously saved trip (owner-scoped — you can only edit your own)
app.post('/driving/:id/edit', requireAuth, async (req, res) => {
  try {
    const { trip_date, route_text, miles } = req.body;
    const m = parseFloat(miles);
    if (!trip_date || isNaN(m) || m < 0) return res.status(400).json({ ok: false, error: 'Need a valid date and miles.' });
    const { rowCount } = await pool.query(
      'UPDATE driving_trips SET trip_date=$1, route_text=$2, miles=$3 WHERE id=$4 AND owner=$5',
      [trip_date, route_text || null, m, req.params.id, sessionKey(req)]
    );
    res.json({ ok: rowCount > 0 });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/driving/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM driving_trips WHERE id=$1 AND owner=$2', [req.params.id, sessionKey(req)]);
  res.redirect('/driving');
});

// ── Suppliers page ────────────────────────────────────────────────────────────

app.get('/suppliers', requireAuth, async (req, res) => {
  try {
    await initDb();
    const suppliers = await getSuppliers();
    const { rows: directory } = await pool.query('SELECT * FROM supplier_directory ORDER BY category NULLS LAST, name');
    // Vendor delivery reliability — aggregated from rated orders (Orders tab pills)
    const { rows: relRows } = await pool.query(
      "SELECT COALESCE(NULLIF(TRIM(supplier_name), ''), '(unknown vendor)') AS vendor, delivery_outcome AS oc, COUNT(*)::int AS n FROM vendor_orders GROUP BY 1, 2");
    const relMap = {};
    for (const r of relRows) {
      const v = relMap[r.vendor] = relMap[r.vendor] || { vendor: r.vendor, ontime: 0, late: 0, wrong: 0, missed: 0, unrated: 0, rated: 0, total: 0 };
      if (r.oc && v[r.oc] !== undefined) { v[r.oc] += r.n; v.rated += r.n; } else v.unrated += r.n;
      v.total += r.n;
    }
    const reliability = Object.values(relMap).sort((a, b) => b.total - a.total);
    res.render('suppliers', { STAGES, suppliers, directory, reliability, saved: req.query.saved === '1' });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Subcontractor database (app-owned, editable; seeded from the GC & Sub Database sheet) ──
const SUBS_SHEET_ID = '1vqPL96RG-KKqY99ADBHIU1JjLAc4c4ywB9ehg7KcqYg';
const SUBS_SHEET_TAB = 'GC & Sub Database';

// Read + parse the GC & Sub Database tab into row objects (for the one-time import).
async function readSubsSheet() {
  if (!sheetsClient) throw new Error('Google Sheets not configured.');
  const { data } = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SUBS_SHEET_ID, range: `${SUBS_SHEET_TAB}!A1:Z2000` });
  const rows = data.values || [];
  let h = rows.findIndex(r => (r || []).some(c => /company\s*name/i.test(String(c))));
  if (h < 0) h = 3;
  const out = [];
  let group = '', category = 'gc';   // sheet starts in the GC portion until the "Subcontractors" divider
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const company = (r[1] || '').trim();
    if (!company) continue;
    const hasDetail = [2, 3, 4, 5, 6, 7].some(j => (r[j] || '').trim());
    if (!hasDetail) {                                  // a section header row
      group = company;
      if (/sub\s*contra/i.test(company)) category = 'sub';
      else if (/general\s*contractor|outside\s*gc|\bgc'?s?\b/i.test(company)) category = 'gc';
      continue;
    }
    out.push({
      company, location: (r[2] || '').trim(), type: (r[3] || '').trim(), status: (r[4] || '').trim(),
      owner: (r[5] || '').trim(), email: (r[6] || '').trim(), phone: (r[7] || '').trim(),
      projects: (r[8] || '').trim(),
      notes: [(r[9] || '').trim(), (r[10] || '').trim()].filter(Boolean).join(' · '),
      group_label: group, sort_order: i, category,   // i = sheet row index; category = gc|sub from the section
    });
  }
  return out;
}

app.get('/subs', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: subs } = await pool.query('SELECT * FROM subcontractors ORDER BY sort_order NULLS LAST, id');
    const { rows: photos } = await pool.query('SELECT id, sub_id FROM sub_photos ORDER BY id');
    const photosBySub = {};
    photos.forEach(p => (photosBySub[p.sub_id] = photosBySub[p.sub_id] || []).push(p.id));
    const { rows: emailRows } = await pool.query('SELECT id, sub_id, subject, body, to_email, from_email, direction, created_at, (body_html IS NOT NULL OR gmail_message_id IS NOT NULL) AS has_html FROM sub_emails ORDER BY created_at DESC');
    const emailsBySub = {};
    emailRows.forEach(e => (emailsBySub[e.sub_id] = emailsBySub[e.sub_id] || []).push(e));
    const { rows: attRows } = await pool.query('SELECT id, sub_email_id, filename, mime, gmail_message_id, gmail_attachment_id FROM sub_email_attachments ORDER BY id');
    const attByEmail = {};
    attRows.forEach(a => (attByEmail[a.sub_email_id] = attByEmail[a.sub_email_id] || []).push(a));
    const isSuper = req.session.role === 'super';
    const canEdit = !isSuper || canSuperViewSubs(req.session.superEmail);   // admins + Bobby can edit
    const recentCount = subs.filter(s => s.recent_add).length;
    // Outreach funnel + per-trade response rates (📊 stats card)
    const contactedIds = new Set(emailRows.filter(e => e.direction !== 'in').map(e => e.sub_id));
    const respondedIds = new Set(emailRows.filter(e => e.direction === 'in').map(e => e.sub_id));
    const byTrade = {};
    subs.forEach(s => {
      // Count the contractor under EVERY trade they carry, not just the first
      const trades = String(s.type || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!trades.length) trades.push('Other');
      const wasContacted = contactedIds.has(s.id);
      const hasResponded = respondedIds.has(s.id);
      trades.forEach(t => {
        const b = byTrade[t] = byTrade[t] || { trade: t, total: 0, contacted: 0, responded: 0 };
        b.total++;
        if (wasContacted) b.contacted++;
        if (hasResponded) b.responded++;
      });
    });
    // Stats are split GC vs Sub so one group doesn't skew the other. Two lenses each:
    //  • PROSPECT POOL = still recruitable (not Active, not Rejected/Blacklisted);
    //    coverage = contacted vs untouched within that pool.
    //  • CONVERSION FUNNEL = of everyone EVER contacted, responded/bid/hired
    //    (Actives count here as wins — they're the funnel's output, not its input).
    const isOut = s => /reject|black/i.test(s.status || '');
    const isActive = s => /^active$/i.test(s.status || '');
    const isInactive = s => /inactive/i.test(s.status || '');   // worked with before, dormant now — known, not a prospect
    const catOfS = s => (s.category === 'gc' || (!s.category && /general\s*contractor|^\s*gc\b/i.test(s.type || ''))) ? 'gc' : 'sub';
    const isApproved = s => /^approved$/i.test(s.status || '');
    const buildStats = list => {
      // Approved = recruiting win ("we want to work with them"); Active = on a job now.
      // Neither is a prospect anymore — the pool is only who's still being recruited.
      const prospectPool = list.filter(s => !isOut(s) && !isActive(s) && !isApproved(s) && !isInactive(s));   // NOTE: never name this `pool` — shadows the pg pool
      const hasEmail = s => !!(s.email || '').trim();
      // Pool splits into 3 disjoint buckets that sum to the pool:
      //   contacted · untouched (HAS an email, just never emailed) · missing email (unreachable until one is added)
      const poolContacted = prospectPool.filter(s => contactedIds.has(s.id)).length;
      const untouched = prospectPool.filter(s => !contactedIds.has(s.id) && hasEmail(s)).length;
      const noEmail = prospectPool.filter(s => !contactedIds.has(s.id) && !hasEmail(s)).length;
      const everContacted = list.filter(s => contactedIds.has(s.id) && !isOut(s));
      return {
        total: list.length,
        excluded: list.length - prospectPool.length,
        pool: prospectPool.length,
        poolContacted,
        untouched,
        noEmail,
        contacted: everContacted.length,
        responded: everContacted.filter(s => respondedIds.has(s.id)).length,
        bids: everContacted.filter(s => /received|awarded/i.test(s.bid_status || '') || /bid under review/i.test(s.status || '')).length,
        approved: everContacted.filter(s => isApproved(s) || isActive(s) || isInactive(s)).length,   // approved-or-beyond (Inactive = worked with before)
        hired: everContacted.filter(s => isActive(s)).length,
      };
    };
    const outreach = {
      gc: buildStats(subs.filter(s => catOfS(s) === 'gc')),
      sub: buildStats(subs.filter(s => catOfS(s) === 'sub')),
      // trade response rates are a sub-side concept (GCs are all one trade)
      tradeStats: Object.values(byTrade).filter(t => t.trade !== 'General Contractor' && t.contacted >= 1).sort((a, b) => b.contacted - a.contacted),   // every contacted trade — no cap
    };
    // Latest bid document per sub — powers the 📄/✉ jump-to-bid link next to the price
    const bidDocs = {};
    try {
      const { rows: bd } = await pool.query(`
        SELECT DISTINCT ON (b.sub_id) b.sub_id, b.gmail_message_id, b.gmail_attachment_id, b.filename, e.id AS email_id
        FROM bids b LEFT JOIN sub_emails e ON e.gmail_message_id = b.gmail_message_id AND e.sub_id = b.sub_id
        ORDER BY b.sub_id, b.received_at DESC`);
      bd.forEach(r => { bidDocs[r.sub_id] = r; });
    } catch (e) { /* bids table brand new */ }
    res.render('subs', { subs, photosBySub, emailsBySub, attByEmail, outreach, bidDocs, imported: req.query.imported, added: req.query.added, isSuper, canEdit, recentCount, emailEnabled,
      gcSort: req.query.gcSort === 'trade' ? 'trade' : 'status', subSort: req.query.subSort === 'trade' ? 'trade' : 'status' });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ── Public contractor submission form (share this link with GCs / subs) ──
app.get('/apply', (req, res) => res.render('apply', { ok: req.query.ok === '1', err: req.query.err === '1' }));

app.post('/apply', async (req, res) => {
  try {
    await initDb();
    const b = req.body;
    if (b.website) return res.redirect('/apply?ok=1');   // honeypot — bots fill the hidden field
    const company = String(b.company || '').trim().slice(0, 200);
    const owner = String(b.owner || '').trim().slice(0, 120);
    const emailIn = String(b.email || '').trim();
    const phoneIn = String(b.phone || '').trim();
    if ((!company && !owner) || !emailIn || !phoneIn) return res.redirect('/apply?err=1');   // phone + email required
    const cat = b.category === 'gc' ? 'gc' : 'sub';
    const type = cat === 'gc' ? 'General Contractor' : normalizeType(String(b.type || '').slice(0, 200));
    const grp = bucketForStatus(cat, 'Under Review');
    const so = await bucketSortOrder(cat, grp);
    const note = String(b.notes || '').trim().slice(0, 1000);
    const noteFull = (note ? note + ' · ' : '') + 'Self-submitted via form';
    await pool.query(
      `INSERT INTO subcontractors (company, location, type, status, owner, email, phone, notes, group_label, category, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [company || null, String(b.location || '').trim().slice(0, 200) || null, type || null, 'Under Review', owner || null,
       String(b.email || '').trim().slice(0, 200) || null, String(b.phone || '').trim().slice(0, 40) || null, noteFull, grp, cat, so]
    );
    const LOGAN = '106404376271648731086';
    postToChat(`📝 *New contractor submission* <users/${LOGAN}>\n${company || owner} (${cat === 'gc' ? 'GC' : (type || 'Sub')})${b.phone ? ' · ' + String(b.phone).trim() : ''}\nReview in Subs → Under Vetting`);
    res.redirect('/apply?ok=1');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ── Warranty: public client submission + internal claims tab ──────────────────
// Fuzzy-match a client-typed address to one of our projects (so the team sees the job).
async function matchProjectByAddress(typed) {
  const raw = String(typed || '').toLowerCase().trim();
  if (raw.length < 4) return null;
  const tNorm = raw.replace(/[^a-z0-9]/g, '');
  const tNum = (raw.match(/\d+/) || [])[0] || '';
  const { rows } = await pool.query('SELECT id, COALESCE(full_address, address) AS address FROM projects');
  for (const p of rows) {
    const aNorm = String(p.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (aNorm && (aNorm.includes(tNorm) || tNorm.includes(aNorm))) return p.id;
  }
  if (tNum) {   // fallback: same house number + a shared street word
    const tWords = raw.split(/\s+/).filter(w => w.length >= 4 && !/^\d+$/.test(w));
    for (const p of rows) {
      const a = String(p.address || '').toLowerCase();
      const aNum = (a.match(/\d+/) || [])[0] || '';
      if (aNum === tNum && tWords.some(w => a.includes(w))) return p.id;
    }
  }
  return null;
}
async function getOpenWarrantyCount() {
  try { const { rows: [r] } = await pool.query("SELECT COUNT(*) c FROM warranty_claims WHERE status <> 'Resolved'"); return Number(r.c) || 0; }
  catch (e) { return 0; }
}

// Public landing + form (share this link with clients)
app.get('/warranty', async (req, res) => {
  let phone = '', hasDoc = false;
  try { await initDb(); const { rows: [r] } = await pool.query('SELECT emergency_phone, (warranty_doc_data IS NOT NULL) AS has_doc FROM app_settings WHERE id=1'); phone = (r && r.emergency_phone) || ''; hasDoc = !!(r && r.has_doc); } catch (e) {}
  res.render('warranty', { ok: req.query.ok === '1', err: req.query.err === '1', emergencyPhone: phone, warrantyPhone: phone, hasWarrantyDoc: hasDoc });
});

// Public: serve the manufacturer-warranty document clients view when they tap "No"
app.get('/warranty-doc', async (req, res) => {
  try {
    await initDb();
    const { rows: [r] } = await pool.query('SELECT warranty_doc_name, warranty_doc_mime, warranty_doc_data FROM app_settings WHERE id=1');
    if (!r || !r.warranty_doc_data) return res.status(404).send('No document available.');
    res.setHeader('Content-Type', r.warranty_doc_mime || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(r.warranty_doc_name || 'warranty.pdf').replace(/[^\w.\- ]/g, '_') + '"');
    res.send(r.warranty_doc_data);
  } catch (err) { res.status(500).send('Error'); }
});

app.post('/warranty', upload.array('photos', 12), async (req, res) => {
  try {
    await initDb();
    const b = req.body;
    if (b.website) return res.redirect('/warranty?ok=1');   // honeypot
    const name = String(b.client_name || '').trim().slice(0, 120);
    const addr = String(b.project_address || '').trim().slice(0, 300);
    const contact = String(b.client_contact || '').trim().slice(0, 120);
    const rooms = String(b.rooms || '').trim().slice(0, 200);
    const desc = String(b.description || '').trim().slice(0, 2000);
    if (!name || !addr) return res.redirect('/warranty?err=1');   // need a name + address to identify them
    // Water heater / AC / appliances are manufacturer-warranty items — note whether they've contacted the maker
    const MFG = ['water heater', 'ac', 'appliances'];
    const hasMfg = rooms.split(',').map(r => r.trim().toLowerCase()).some(r => MFG.indexOf(r) >= 0);
    let descFull = desc;
    if (hasMfg) {
      const mc = String(req.body.mfg_contacted || '').toLowerCase();
      const contacted = mc === 'yes' ? 'YES — client already contacted the manufacturer'
        : (mc === 'no' ? 'NO — client has not contacted the manufacturer (was shown the document)' : 'not answered');
      descFull = (desc ? desc + '\n\n' : '') + '⚙️ Manufacturer-warranty item — ' + contacted + '.';
    }
    const projectId = await matchProjectByAddress(addr);
    const { rows: [claim] } = await pool.query(
      `INSERT INTO warranty_claims (client_name, client_contact, project_address, project_id, rooms, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,'Open') RETURNING id`,
      [name, contact || null, addr, projectId, rooms || null, descFull || null]);
    const files = req.files || [];
    for (const f of files) {
      await pool.query('INSERT INTO warranty_photos (claim_id, mime, data) VALUES ($1,$2,$3)', [claim.id, f.mimetype, f.buffer]);
    }
    let projAddr = '';
    if (projectId) { try { const { rows: [p] } = await pool.query('SELECT COALESCE(full_address, address) a FROM projects WHERE id=$1', [projectId]); projAddr = p ? p.a : ''; } catch (e) {} }
    const LOGAN = '106404376271648731086', BOBBY = '111280454403124522893';
    const lines = [`🏠 *New warranty claim* <users/${LOGAN}> <users/${BOBBY}>`,
      `*${name}*` + (projAddr ? ' — ' + shortAddress(projAddr) : (addr ? ' — ' + addr : '')),
      rooms ? 'Room(s): ' + rooms : null,
      desc ? 'Issue: ' + (desc.length > 140 ? desc.slice(0, 140) + '…' : desc) : null,
      files.length ? `📷 ${files.length} photo(s)` : null,
      'Open the Warranty tab to view'].filter(Boolean);
    postToChat(lines.join('\n'), 'warranty-' + claim.id);
    res.redirect('/warranty?ok=1');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Internal warranty claims tab (Logan + Bobby/Aziz)
app.get('/warranty-claims', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: claims } = await pool.query(`
      SELECT wc.*, p.address AS matched_address,
             (SELECT COUNT(*) FROM warranty_photos wp WHERE wp.claim_id = wc.id) AS photo_count
      FROM warranty_claims wc LEFT JOIN projects p ON p.id = wc.project_id
      ORDER BY (wc.status <> 'Resolved') DESC, wc.created_at DESC`);
    const { rows: photoRows } = await pool.query('SELECT id, claim_id FROM warranty_photos ORDER BY id');
    const photosByClaim = {};
    photoRows.forEach(p => (photosByClaim[p.claim_id] = photosByClaim[p.claim_id] || []).push(p.id));
    res.render('warranty-claims', { claims, photosByClaim, isSuper: req.session.role === 'super' });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/warranty-claims/:cid/photo/:pid', requireAuth, async (req, res) => {
  try {
    const { rows: [r] } = await pool.query('SELECT mime, data FROM warranty_photos WHERE id=$1 AND claim_id=$2', [req.params.pid, req.params.cid]);
    if (!r || !r.data) return res.status(404).send('No photo.');
    res.setHeader('Content-Type', r.mime || 'image/jpeg');
    res.send(r.data);
  } catch (err) { res.status(500).send('Error'); }
});

app.post('/warranty-claims/:id/status', requireAuth, async (req, res) => {
  try {
    const st = ['Open', 'In Progress', 'Resolved'].includes(req.body.status) ? req.body.status : 'Open';
    await pool.query('UPDATE warranty_claims SET status=$1 WHERE id=$2', [st, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/warranty-claims/:id/delete', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM warranty_claims WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Retired boards (moved to the new system) - send stale bookmarks home.
// Plain middleware (no path pattern) — Express 5's router rejects bare "*" wildcards.
app.use((req, res, next) => {
  if (req.path.startsWith('/permits') || req.path.startsWith('/payments')) return res.redirect('/');
  next();
});

// ── Team hub: Logan manages who can see which page (only Logan reaches this) ───
app.get('/team', requireAuth, async (req, res) => {
  try {
    await initDb(); await loadAccess(); await loadTeamLogins();
    const members = teamMembers().map(m => ({ key: m.key, name: m.name, role: m.role, dynamic: !!m.dynamic, pages: [...allowedPagesFor(m.key, m.role.toLowerCase())] }));
    res.render('team', { members, PAGES: PAGE_META, saved: req.query.saved === '1', added: req.query.added || '' });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
app.post('/team/save', requireAuth, async (req, res) => {
  try {
    await initDb();
    for (const m of teamMembers()) {
      let pages = req.body['pages_' + m.key];
      if (pages === undefined) pages = [];
      if (!Array.isArray(pages)) pages = [pages];
      pages = pages.filter(p => PAGE_KEYS.includes(p));
      await pool.query(
        `INSERT INTO user_access (user_key, pages, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (user_key) DO UPDATE SET pages=EXCLUDED.pages, updated_at=NOW()`,
        [m.key, pages.join(',')]);
    }
    await loadAccess();
    res.redirect('/team?saved=1');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
// Add a new team member (office login). Logan picks their name, username, password, and page access.
app.post('/team/add', requireAuth, async (req, res) => {
  try {
    await initDb();
    const name = String(req.body.name || '').trim();
    const key = String(req.body.username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    const password = String(req.body.password || '');
    if (!name || !key || password.length < 4) return res.redirect('/team?added=err');
    await loadTeamLogins();
    const taken = key === String(process.env.ADMIN_USERNAME || 'logan').toLowerCase() || key === 'logan'
      || ADMINS.some(a => a.username.toLowerCase() === key)
      || SUPERS.some(s => s.username.toLowerCase() === key || s.email.toLowerCase() === key)
      || DB_ADMINS.some(a => a.username.toLowerCase() === key);
    if (taken) return res.redirect('/team?added=taken');
    let pages = req.body.pages; if (pages === undefined) pages = []; if (!Array.isArray(pages)) pages = [pages];
    pages = pages.filter(p => PAGE_KEYS.includes(p));
    const hash = bcrypt.hashSync(password, 10);
    await pool.query('INSERT INTO team_logins (user_key, name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (user_key) DO UPDATE SET name=EXCLUDED.name, password_hash=EXCLUDED.password_hash', [key, name, hash]);
    await pool.query('INSERT INTO user_access (user_key, pages, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (user_key) DO UPDATE SET pages=EXCLUDED.pages, updated_at=NOW()', [key, pages.join(',')]);
    await loadTeamLogins(); await loadAccess();
    res.redirect('/team?added=ok');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
// Remove a member Logan added (never the built-in accounts).
app.post('/team/remove', requireAuth, async (req, res) => {
  try {
    const key = String(req.body.key || '').trim().toLowerCase();
    await loadTeamLogins();
    if (!DB_ADMINS.some(a => a.username.toLowerCase() === key)) return res.redirect('/team');
    await pool.query('DELETE FROM team_logins WHERE user_key=$1', [key]);
    await pool.query('DELETE FROM user_access WHERE user_key=$1', [key]);
    await pool.query('DELETE FROM admin_passwords WHERE username=$1', [key]);
    await loadTeamLogins(); await loadAccess();
    res.redirect('/team');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Map a status to the matching section bucket, so status and section stay in sync.
function bucketForStatus(category, status) {
  const s = (status || '').toLowerCase();
  const gc = category === 'gc';
  if (/bid under review/.test(s)) return 'Bid Under Review';   // bid came in — own section at the top of the list
  if (/bid request/.test(s)) return 'Bid Requested';           // we asked for a bid, waiting on them
  if (/inactive/.test(s)) return gc ? 'Inactive GCs' : 'Inactive Subcontractors';   // must beat /active/ — "inactive" contains it
  if (/active/.test(s)) return gc ? 'Active Buildoly Outside General Contractors' : 'Active Buildoly Subcontractors';
  if (/black/.test(s)) return gc ? 'Blacklisted Buildoly General Contractors' : 'Blacklisted Buildoly Sub Contractors';
  if (/reject|declin/.test(s)) return gc ? 'Rejected GCs' : 'Rejected Subcontractors';
  if (/approv/.test(s)) return gc ? 'Vetted but Unused GCs' : 'Vetted but Unused';
  return 'Under Vetting';   // Under Review / blank → intake bucket
}
// Inverse: dropping a sub into a bucket sets its status to match (keeps the pill + section in sync).
function statusForBucket(grp) {
  const g = (grp || '').toLowerCase();
  if (/bid under review/.test(g)) return 'Bid Under Review';
  if (/bid request/.test(g)) return 'Bid Requested';
  if (/black/.test(g)) return 'Blacklisted';
  if (/reject/.test(g)) return 'Rejected';
  if (/inactive/.test(g)) return 'Inactive';   // must beat /active/ — "inactive" contains it
  if (/active/.test(g)) return 'Active';
  if (/vetted|unused/.test(g)) return 'Approved';
  if (/vetting/.test(g)) return 'Under Review';
  return null;   // custom / unknown bucket → leave the status unchanged
}
// Normalize a contractor's trade(s) so duplicates/variants collapse (keeps the
// trade chips clean). Collapses every "General Contractor (…)" to "General Contractor".
const TRADE_MAP = {
  'electrician': 'Electrician', 'electrical': 'Electrician',
  'plumber': 'Plumber', 'plumbing': 'Plumber',
  'finish': 'Finishes', 'finishes': 'Finishes',
  'fire sprinklers': 'Fire Sprinklers',
  'plaster': 'Stucco', 'plastering': 'Stucco',          // plaster = stucco
  'metal framing': 'Metal Framing',
  'masonry (block)': 'Masonry',
  'demo & foundation': 'Demolition, Foundation',          // split into two trades
  'windows': 'Windows & Doors', 'doors': 'Windows & Doors',   // windows & doors = one trade
};
function normalizeType(raw) {
  let t = (raw || '').trim();
  if (!t) return t;
  if (/^general contractor\b/i.test(t)) return 'General Contractor';
  const seen = new Set(), out = [];
  t.split(',').forEach(tok => {
    tok = tok.trim(); if (!tok) return;
    const mapped = TRADE_MAP[tok.toLowerCase()] || tok;   // may expand to multiple trades
    mapped.split(',').forEach(part => {
      part = part.trim(); if (!part) return;
      const k = part.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(part); }
    });
  });
  return out.join(', ');
}
async function bucketSortOrder(category, group) {
  const { rows: [mx] } = await pool.query('SELECT MAX(sort_order) m FROM subcontractors WHERE category=$1 AND group_label IS NOT DISTINCT FROM $2', [category, group]);
  return (mx && mx.m != null) ? Number(mx.m) + 1 : 9999;
}

// Add a subcontractor
app.post('/subs', requireAuth, upload.array('photos', 12), async (req, res) => {
  try {
    const b = req.body;
    if (!(b.company || b.owner || '').trim()) return res.redirect('/subs');
    // Use the chosen Section if provided, else infer from the Type
    const cat = (b.category === 'gc' || b.category === 'sub') ? b.category : (/general\s*contractor|^\s*gc\b/i.test(b.type || '') ? 'gc' : 'sub');
    // New contractors start as "Under Review" unless a status was explicitly chosen
    const status = (b.status && b.status.trim()) ? b.status.trim() : 'Under Review';
    const grp = bucketForStatus(cat, status);
    const so = await bucketSortOrder(cat, grp);
    const { rows: [sub] } = await pool.query(
      `INSERT INTO subcontractors (company, location, type, status, owner, email, phone, notes, group_label, category, sort_order, referenced_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.company || null, b.location || null, normalizeType(b.type) || null, status, b.owner || null,
       b.email || null, b.phone || null, b.notes || null, grp, cat, so, b.referenced_by || null]
    );
    for (const f of (req.files || [])) {
      await pool.query('INSERT INTO sub_photos (sub_id, filename, mime, data) VALUES ($1,$2,$3,$4)',
        [sub.id, f.originalname, f.mimetype, f.buffer]);
    }
    res.redirect('/subs?added=1');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Clear the "Recently added" tag from all subs (after you've verified the batch)
app.post('/subs/clear-recent', requireAuth, async (req, res) => {
  try { await pool.query('UPDATE subcontractors SET recent_add=FALSE WHERE recent_add=TRUE'); res.redirect('/subs'); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Edit a subcontractor
app.post('/subs/:id', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    // Re-derive GC vs Sub when an explicit category isn't provided.
    const cat = b.category || (/general\s*contractor|^\s*gc\b/i.test(b.type || '') ? 'gc' : 'sub');
    await pool.query(
      `UPDATE subcontractors SET company=$1, location=$2, type=$3, status=$4, owner=$5, email=$6, phone=$7, notes=$8, category=$9, referenced_by=$10,
         email_bounced_at = CASE WHEN LOWER(COALESCE($6,'')) IS DISTINCT FROM LOWER(COALESCE(email,'')) THEN NULL ELSE email_bounced_at END,
         email_bounce_note = CASE WHEN LOWER(COALESCE($6,'')) IS DISTINCT FROM LOWER(COALESCE(email,'')) THEN NULL ELSE email_bounce_note END
       WHERE id=$11`,
      [b.company || null, b.location || null, normalizeType(b.type) || null, b.status || null, b.owner || null,
       b.email || null, b.phone || null, b.notes || null, cat, b.referenced_by || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Quick inline status change (Under Review → Active / Rejected / etc.) — also moves it to the matching section
app.post('/subs/:id/status', requireAuth, async (req, res) => {
  try {
    const status = req.body.status || null;
    const { rows: [cur] } = await pool.query('SELECT category, group_label FROM subcontractors WHERE id=$1', [req.params.id]);
    const cat = (cur && cur.category) || 'sub';
    const grp = bucketForStatus(cat, status);
    const so = await bucketSortOrder(cat, grp);
    const flagged = /reject|black/i.test(status || '');   // Rejected / Blacklisted carry a reason + blur the contact info
    if (flagged) {
      const reason = (req.body.reason != null && String(req.body.reason).trim()) ? String(req.body.reason).trim().slice(0, 500) : null;
      await pool.query('UPDATE subcontractors SET status=$1, group_label=$2, sort_order=$3, reject_reason=COALESCE($4, reject_reason) WHERE id=$5', [status, grp, so, reason, req.params.id]);
    } else {
      await pool.query('UPDATE subcontractors SET status=$1, group_label=$2, sort_order=$3, reject_reason=NULL WHERE id=$4', [status, grp, so, req.params.id]);
    }
    res.json({ ok: true, moved: !cur || cur.group_label !== grp });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── CSLB (California Contractors State License Board) integration ─────────────
// Two capabilities: (1) Sub Finder — pull licensed contractors by classification +
// county with contact info; (2) License Watchdog — verify a license number and
// flag problems (expired / expiring / suspended / no bond / disciplinary).
const CSLB_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
// Our trade names → CSLB classification codes
const CSLB_CLASS_BY_TRADE = {
  'General Contractor': 'B', 'Electrician': 'C-10', 'Plumber': 'C-36', 'Drywall': 'C-9',
  'Framing': 'C-5', 'Metal Framing': 'C-5', 'Painter': 'C-33', 'HVAC': 'C-20',
  'Flooring': 'C-15', 'Windows & Doors': 'C-17', 'Roofing': 'C-39', 'Concrete': 'C-8',
  'Foundation': 'C-8', 'Masonry': 'C-29', 'Demolition': 'C-21', 'Landscaping': 'C-27',
  'Tile': 'C-54', 'Stone': 'C-29', 'Countertops': 'C-6', 'Cabinets': 'C-6',
  'Solar': 'C-46', 'Stucco': 'C-35', 'Insulation': 'C-2', 'Fire Sprinklers': 'C-16',
  'Decking': 'C-5', 'Finishes': 'C-6', 'Tree Removal': 'D-49',
};
// Rough SoCal zip → county (for auto-filling a contractor's service area)
function countyFromZip(zipish) {
  const m = String(zipish || '').match(/\b(9\d{4})\b/);
  if (!m) return '';
  const z = parseInt(m[1], 10);
  if (z >= 90001 && z <= 91899) return 'LA County';
  if (z >= 91901 && z <= 92199) return 'San Diego County';
  if (z >= 92201 && z <= 92299) return 'Riverside County';
  if (z >= 92301 && z <= 92499) return 'San Bernardino County';
  if (z >= 92501 && z <= 92599) return 'Riverside County';
  if (z >= 92601 && z <= 92899) return 'Orange County';
  if (z >= 93001 && z <= 93099) return 'Ventura County';
  if (z >= 93510 && z <= 93599) return 'LA County';   // Antelope Valley (Palmdale/Lancaster)
  return '';
}
// CSLB county display names → our location labels
function cslbCountyToLocation(county) {
  const c = String(county || '').trim();
  if (/^los angeles$/i.test(c)) return 'LA County';
  return c ? c + ' County' : '';
}
// Open a CSLB page and capture the ASP.NET session (cookies + viewstate)
async function cslbSession(url) {
  const r = await fetch(url, { headers: CSLB_UA });
  if (!r.ok) throw new Error('CSLB unreachable (HTTP ' + r.status + ')');
  const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])
    .filter(Boolean).map(c => String(c).split(';')[0]).join('; ');
  const html = await r.text();
  const grab = n => { const m = html.match(new RegExp('id="' + n + '" value="([^"]*)"')); return m ? m[1] : ''; };
  return { cookies, html, state: { '__VIEWSTATE': grab('__VIEWSTATE'), '__VIEWSTATEGENERATOR': grab('__VIEWSTATEGENERATOR'), '__EVENTVALIDATION': grab('__EVENTVALIDATION') } };
}
function cslbDate(s) {   // "11/30/2027" → Date or null
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
}
// Verify one license number against CSLB — returns parsed detail
async function cslbLicenseDetail(licNum) {
  licNum = String(licNum || '').replace(/\D/g, '');
  if (!licNum) throw new Error('No license number.');
  const base = 'https://www2.cslb.ca.gov/onlineservices/checklicenseII/checklicense.aspx';
  const s = await cslbSession(base);
  const btn = s.html.match(/name="ctl00.MainContent.Contractor_License_Number_Search"[^>]*value="([^"]*)"/);
  const body = new URLSearchParams({ ...s.state, 'ctl00$MainContent$LicNo': licNum, 'ctl00$MainContent$Contractor_License_Number_Search': btn ? btn[1] : 'Search' });
  const r2 = await fetch(base, { method: 'POST', redirect: 'manual', headers: { ...CSLB_UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': s.cookies, 'Referer': base }, body });
  const loc = r2.headers.get('location');
  if (!loc || !/LicenseDetail/i.test(loc)) throw new Error('License #' + licNum + ' not found on CSLB.');
  const r3 = await fetch(new URL(loc, base).href, { headers: { ...CSLB_UA, 'Cookie': s.cookies, 'Referer': base } });
  const raw = await r3.text();
  const lines = raw.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .split('\n').map(x => x.trim()).filter(Boolean);
  // Disciplinary detection: any VISIBLE line with a risk word that isn't one of the
  // 4 boilerplate sentences every license page shows (verified against clean pages).
  const RISK_BOILERPLATE = [
    /^CSLB complaint disclosure is restricted by law/i,
    /^If this entity is subject to public complaint disclosure/i,
    /^Only construction related civil judgments reported to CSLB/i,
    /^Arbitrations are not listed unless the contractor fails to comply/i,
  ];
  const riskLines = lines.filter(l =>
    /complaint|disciplin|citation|accusation|civil judgment|suspend|revok|arbitrat/i.test(l) &&
    !RISK_BOILERPLATE.some(re => re.test(l)));
  const idx = re => lines.findIndex(l => re.test(l));
  const efter = (re, n) => { const i = idx(re); return i >= 0 ? (lines[i + (n || 1)] || '') : ''; };
  const iBiz = idx(/^Business Information$/i);
  const bizLines = iBiz >= 0 ? lines.slice(iBiz + 1, iBiz + 6) : [];
  const phoneIdx = bizLines.findIndex(l => /Business Phone/i.test(l));
  const det = {
    licNum,
    businessName: bizLines[0] || '',
    address: bizLines.slice(1, phoneIdx > 0 ? phoneIdx : 3).join(', '),
    phone: (raw.match(/Business Phone Number:\s*<[^>]*>?\s*\(?([\d() \-]{7,})/) || [,''])[1].trim() || (bizLines.find(l => /Phone/i.test(l)) || '').replace(/[^0-9() \-]/g, '').trim(),
    entity: efter(/^Entity$/i),
    issueDate: efter(/^Issue Date$/i),
    expireDate: efter(/^Expire Date$/i),
    statusText: efter(/^License Status$/i),
    classifications: (() => { const i = idx(/^Classifications$/i); if (i < 0) return ''; const out = []; for (let j = i + 1; j < lines.length && j < i + 8; j++) { if (/^Bonding|^Additional Status/i.test(lines[j])) break; if (/^[A-D]-?\d*\s*-\s*/.test(lines[j])) out.push(lines[j]); } return out.join(' | '); })(),
    hasBond: /filed a Contractor'?s Bond|Bond Amount/i.test(raw),
    wcText: /has workers'? compensation insurance/i.test(raw) ? 'Insured' : (/exempt/i.test(raw) && /workers'? comp/i.test(raw) ? 'Exempt' : ''),
    disciplinary: riskLines.length > 0,
    discNote: (riskLines[0] || '').slice(0, 140),
    riskLines: riskLines.slice(0, 12).map(l => l.slice(0, 220)),   // full issue text for the license report
  };
  if (!det.businessName) throw new Error('License #' + licNum + ' not found on CSLB.');
  return det;
}
// Compute red/amber flags from a parsed detail
function cslbFlags(det) {
  const flags = [];
  const st = det.statusText || '';
  if (st && !/current and active/i.test(st)) flags.push({ level: 'red', text: 'Status: ' + st.slice(0, 120) });
  const exp = cslbDate(det.expireDate);
  if (exp) {
    const days = Math.floor((exp - new Date()) / 86400000);
    if (days < 0) flags.push({ level: 'red', text: 'License EXPIRED ' + det.expireDate });
    else if (days <= 90) flags.push({ level: 'amber', text: 'Expires in ' + days + 'd (' + det.expireDate + ')' });
  }
  if (det.disciplinary) flags.push({ level: 'red', text: 'CSLB record: ' + (det.discNote || 'complaint / disciplinary disclosure on file') });
  if (!det.hasBond) flags.push({ level: 'amber', text: 'No contractor bond on file' });
  if (det.wcText === 'Exempt') flags.push({ level: 'info', text: "Workers' comp: exempt (no employees)" });
  return flags;
}
// Verify + persist for one contractor row. Pulls the license # from the field,
// or extracts it from the company name / notes ("... Lic 1076518").
async function verifySubLicense(sub) {
  let lic = String(sub.license_number || '').replace(/\D/g, '');
  if (!lic) {
    const m = ((sub.company || '') + ' ' + (sub.notes || '')).match(/\b(?:lic(?:ense)?|csl[b#]?|#)\s*\.?\s*#?\s*(\d{5,8})\b/i);
    if (m) lic = m[1];
  }
  if (!lic) return { ok: false, error: 'No license number on file.' };
  const det = await cslbLicenseDetail(lic);
  const flags = cslbFlags(det);
  const exp = cslbDate(det.expireDate);
  // Full report powers the click-to-see-details popup on the Subs page
  const report = {
    licNum: lic, business: det.businessName, address: det.address, phone: det.phone,
    entity: det.entity, issued: det.issueDate, expires: det.expireDate,
    status: det.statusText, classes: det.classifications,
    bond: det.hasBond, wc: det.wcText, riskLines: det.riskLines || [],
  };
  // Bonus: the CSLB business address gives us a county — fill the service area if it's blank
  const cslbLoc = countyFromZip(det.address);
  await pool.query(
    `UPDATE subcontractors SET license_number=$1, licensed=true, license_status=$2, license_expire=$3,
       license_classes=$4, license_flags=$5, license_business=$6, license_report=$7, license_checked_at=NOW(),
       location = COALESCE(NULLIF(TRIM(location), ''), $9) WHERE id=$8`,
    [lic, det.statusText || null, exp ? exp.toISOString().slice(0, 10) : null,
     det.classifications || null, JSON.stringify(flags), det.businessName || null, JSON.stringify(report), sub.id,
     cslbLoc || null]
  );
  return { ok: true, detail: det, flags };
}
// ── Insurance watchdog: read COI attachments the subs emailed us, pull expiration dates ──
// Text extraction: pdf-parse for digital PDFs; Cloud Vision OCR for scans and photos.
async function docTextOrOcr(buf, filename) {
  let text = '';
  if (/\.docx$/i.test(filename || '')) {
    try {
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(buf);
      const doc = zip.file('word/document.xml');
      if (doc) {
        const xml = await doc.async('string');
        return xml.replace(/<w:p\b[^>]*>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      }
    } catch (e) { /* corrupt docx */ }
    return '';
  }
  const isPdf = /\.pdf$/i.test(filename || '') || buf.slice(0, 4).toString() === '%PDF';
  if (isPdf) {
    try {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try { const r = await parser.getText(); text = (r && r.text) || ''; }
      finally { if (parser.destroy) { try { await parser.destroy(); } catch (e) {} } }
    } catch (e) { /* corrupt or scanned — OCR below */ }
    if (text.replace(/\s/g, '').length >= 100) return text;
  }
  const key = process.env.GOOGLE_PLACES_API_KEY;   // same key, Vision API enabled on it
  if (!key) return text;
  if (isPdf) {
    const r = await fetch('https://vision.googleapis.com/v1/files:annotate?key=' + key, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ inputConfig: { content: buf.toString('base64'), mimeType: 'application/pdf' }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], pages: [1, 2, 3] }] }),
    });
    const d = await r.json();
    const resps = ((d.responses || [])[0] || {}).responses || [];
    return resps.map(x => (x.fullTextAnnotation || {}).text || '').join('\n') || text;
  }
  const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content: buf.toString('base64') }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }),
  });
  const d = await r.json();
  return (((d.responses || [])[0] || {}).fullTextAnnotation || {}).text || '';
}
// In a COI every future date is a policy expiration; the earliest one is the next lapse.
function coiDates(text) {
  const out = [];
  const re = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g;
  let m;
  while ((m = re.exec(text))) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
    if (!isNaN(d) && y >= 2015 && y <= new Date().getFullYear() + 6) out.push(d);
  }
  return out;
}
const COI_FILE_RE = /coi|acord|certificat|insur|liab|workers.?comp|\bwc\b|policy/i;
async function scanSubInsurance(subId) {
  const { rows } = await pool.query(`
    SELECT a.filename, a.mime, a.gmail_message_id, a.gmail_attachment_id
    FROM sub_email_attachments a JOIN sub_emails e ON e.id = a.sub_email_id
    WHERE e.sub_id = $1 AND (a.mime ~* 'pdf|image' OR a.filename ~* '\\.(pdf|png|jpe?g)$')
    ORDER BY a.id DESC`, [subId]);
  const a = rows.find(r => COI_FILE_RE.test(r.filename || ''));   // newest insurance-looking doc
  if (!a) return { ok: false, reason: 'no insurance attachment' };
  const att = await gmailClient.users.messages.attachments.get({ userId: 'me', messageId: a.gmail_message_id, id: a.gmail_attachment_id });
  const buf = Buffer.from(String(att.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const dates = coiDates(await docTextOrOcr(buf, a.filename));
  if (!dates.length) return { ok: false, reason: 'no dates readable in ' + a.filename };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const future = dates.filter(d => d >= today).map(d => d.getTime());
  const exp = future.length ? new Date(Math.min.apply(null, future)) : new Date(Math.max.apply(null, dates.map(d => d.getTime())));
  const note = (a.filename || 'attachment').slice(0, 120) + (future.length ? '' : ' — all policies expired');
  await pool.query('UPDATE subcontractors SET ins_expires=$1, ins_note=$2, ins_checked_at=NOW() WHERE id=$3',
    [exp.toISOString().slice(0, 10), note, subId]);
  return { ok: true, expires: exp.toISOString().slice(0, 10), file: a.filename };
}
// Scan every sub that has emailed us attachments (used by the button and the weekly cron)
async function insuranceScanAll() {
  const { rows } = await pool.query(`
    SELECT DISTINCT e.sub_id FROM sub_email_attachments a JOIN sub_emails e ON e.id = a.sub_email_id`);
  const out = { scanned: 0, found: 0, skipped: 0, errors: 0 };
  for (const r of rows) {
    try {
      out.scanned++;
      const res = await scanSubInsurance(r.sub_id);
      if (res.ok) out.found++; else out.skipped++;
    } catch (e) { out.errors++; console.error('insurance scan sub ' + r.sub_id + ':', e.message); }
  }
  return out;
}

// Search CSLB for licensed contractors by classification + counties → rows
async function cslbSearchByCounty(classification, counties) {
  const XLSX = require('xlsx');
  const url = 'https://www.cslb.ca.gov/onlineservices/dataportal/ListByCounty';
  const s = await cslbSession(url);
  // county display name → form value, parsed live from the page
  const countyVals = [];
  for (const want of [].concat(counties || [])) {
    const m = s.html.match(new RegExp('<option value="(\\d+)">' + String(want).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<'));
    if (m) countyVals.push(m[1]);
  }
  if (!countyVals.length) throw new Error('No valid county selected.');
  const body = new URLSearchParams(s.state);
  body.append('ctl00$MainContent$lbClassification', classification);
  countyVals.forEach(v => body.append('ctl00$MainContent$lbCounty', v));
  body.append('ctl00$MainContent$btnSearch', 'Download');
  const r2 = await fetch(url, { method: 'POST', headers: { ...CSLB_UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': s.cookies, 'Referer': url }, body });
  const ct = r2.headers.get('content-type') || '';
  if (!/spreadsheet|octet-stream/i.test(ct)) throw new Error('CSLB did not return a data file (got ' + ct.slice(0, 60) + ').');
  const buf = Buffer.from(await r2.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const head = (rows[0] || []).map(h => String(h || '').toLowerCase());
  const col = name => head.findIndex(h => h.includes(name));
  const c = { lic: col('licensenumber'), name: col('businessname'), addr: col('address'), city: col('city'), zip: col('zip'), county: col('county'), phone: col('phonenumber'), issue: col('issuedate'), exp: col('expirationdate'), cls: col('classification'), status: col('status'), bond: col('suretycompany'), wc: col('workerscompcoveragetype') };
  return rows.slice(1).filter(r => r && r[c.lic]).map(r => ({
    licNum: String(r[c.lic]), name: String(r[c.name] || '').trim(), address: String(r[c.addr] || '').trim(),
    city: String(r[c.city] || '').trim(), zip: String(r[c.zip] || '').trim(), county: String(r[c.county] || '').trim(),
    phone: String(r[c.phone] || '').trim(), issued: String(r[c.issue] || '').trim(), expires: String(r[c.exp] || '').trim(),
    classes: String(r[c.cls] || '').replace(/\s+/g, ' ').trim(), status: String(r[c.status] || '').trim(),
    bonded: !!(r[c.bond] && String(r[c.bond]).trim()), wc: String(r[c.wc] || '').trim(),
  }));
}

// Inline-save a whitelisted contractor field (bid pipeline + license)
const SUB_INLINE_FIELDS = { bid_status: 'text', bid_price: 'text', license_number: 'text', licensed: 'bool', email: 'text', phone: 'text', location: 'text', company: 'text' };
app.post('/subs/:id/field', requireAuth, async (req, res) => {
  try {
    const sets = [], vals = [];
    for (const [k, type] of Object.entries(SUB_INLINE_FIELDS)) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      if (type === 'bool') v = (v === 'true' || v === true) ? true : (v === 'false' || v === false) ? false : null;
      else v = (v != null && String(v).trim()) ? String(v).trim().slice(0, 200) : null;   // location can list several counties
      sets.push(`${k}=$${vals.length + 1}`); vals.push(v);
    }
    if (!sets.length) return res.json({ ok: true });
    // Saving an email (even re-typing it) counts as "I fixed it" — clear any bounce flag.
    if ('email' in req.body) { sets.push('email_bounced_at=NULL'); sets.push('email_bounce_note=NULL'); }
    vals.push(req.params.id);
    await pool.query(`UPDATE subcontractors SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Sub profile page: everything about one contractor in one place ──
app.get('/subs/profile/:id', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: [sub] } = await pool.query('SELECT * FROM subcontractors WHERE id=$1', [req.params.id]);
    if (!sub) return res.status(404).send('Contractor not found.');
    const { rows: photos } = await pool.query('SELECT id FROM sub_photos WHERE sub_id=$1 ORDER BY id', [sub.id]);
    const { rows: emails } = await pool.query(
      `SELECT id, subject, body, direction, created_at, gmail_message_id,
              (body_html IS NOT NULL OR gmail_message_id IS NOT NULL) AS has_html
       FROM sub_emails WHERE sub_id=$1 ORDER BY created_at DESC`, [sub.id]);
    const { rows: attachments } = await pool.query(
      `SELECT a.id, a.filename, a.mime, a.gmail_message_id, a.gmail_attachment_id, e.created_at
       FROM sub_email_attachments a JOIN sub_emails e ON e.id = a.sub_email_id
       WHERE e.sub_id=$1 ORDER BY e.created_at DESC`, [sub.id]);
    const { rows: bids } = await pool.query(
      `SELECT b.*, p.address AS project_address FROM bids b LEFT JOIN projects p ON p.id = b.project_id
       WHERE b.sub_id=$1 ORDER BY b.received_at DESC`, [sub.id]);
    // One merged timeline: emails, bids, and compliance checks in date order
    const events = [];
    emails.forEach(e => events.push({ t: e.created_at, kind: e.direction === 'in' ? 'in' : 'out', subject: e.subject, body: e.body, emailId: e.id, hasHtml: e.has_html }));
    bids.forEach(b => events.push({ t: b.received_at, kind: 'bid', amount: b.amount, project: b.project_address, filename: b.filename, mid: b.gmail_message_id, aid: b.gmail_attachment_id }));
    if (sub.license_checked_at) events.push({ t: sub.license_checked_at, kind: 'lic', status: sub.license_status, expire: sub.license_expire });
    if (sub.ins_checked_at) events.push({ t: sub.ins_checked_at, kind: 'ins', expires: sub.ins_expires, note: sub.ins_note });
    events.sort((a, b) => new Date(b.t) - new Date(a.t));
    res.render('sub-profile', { sub, photos, emails, attachments, bids, events });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Fix-it deck: every usable sub that's missing a name, service area, or email —
// one card per missing field, worst gaps first (blank names, then areas, then emails)
app.get('/subs/fixit/list', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, company, owner, type, status, location, email, phone
      FROM subcontractors WHERE status !~* 'reject|black' ORDER BY id`);
    const cards = [];
    rows.forEach(s => {
      // A one-man operation is fine: the guy's name in Contact counts as a name.
      const noName = !String(s.company || '').trim() && !String(s.owner || '').trim();
      const noArea = !String(s.location || '').trim();
      const noEmail = !String(s.email || '').trim();
      const known = [s.email ? 'email ✓' : null, s.phone ? 'phone ✓' : null, s.status || null].filter(Boolean).join(' · ');
      const base = { id: s.id, company: s.company, owner: s.owner, type: s.type, known };
      if (noName) cards.push({ ...base, field: 'company' });
      if (noArea) cards.push({ ...base, field: 'location' });
      if (noEmail) cards.push({ ...base, field: 'email' });
    });
    cards.sort((a, b) => ({ company: 0, location: 1, email: 2 })[a.field] - ({ company: 0, location: 1, email: 2 })[b.field]);
    res.json({ ok: true, cards });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── License Watchdog + Sub Finder endpoints ───────────────────────────────────
// Verify one contractor's license against CSLB (live)
app.post('/subs/:id/verify-license', requireAuth, async (req, res) => {
  try {
    const { rows: [sub] } = await pool.query('SELECT id, company, notes, license_number FROM subcontractors WHERE id=$1', [req.params.id]);
    if (!sub) return res.status(404).json({ ok: false, error: 'Contractor not found.' });
    const out = await verifySubLicense(sub);
    res.json(out.ok ? { ok: true, detail: out.detail, flags: out.flags } : { ok: false, error: out.error });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// Verify every contractor that has (or embeds) a license number. Sequential +
// polite delay so we don't hammer CSLB. Returns a summary.
app.post('/subs/licenses/verify-all', requireAuth, async (req, res) => {   // 3-segment path so /subs/:id can't swallow it
  try {
    const { rows } = await pool.query("SELECT id, company, notes, license_number FROM subcontractors ORDER BY id");
    const withLic = rows.filter(s => String(s.license_number || '').replace(/\D/g, '') ||
      /\b(?:lic(?:ense)?|csl[b#]?|#)\s*\.?\s*#?\s*\d{5,8}\b/i.test((s.company || '') + ' ' + (s.notes || '')));
    const results = [];
    for (const s of withLic) {
      try { const r = await verifySubLicense(s); results.push({ id: s.id, company: s.company, ok: r.ok, flags: r.ok ? r.flags : [], error: r.error }); }
      catch (e) { results.push({ id: s.id, company: s.company, ok: false, error: e.message }); }
      await new Promise(r => setTimeout(r, 700));   // politeness delay
    }
    const flagged = results.filter(r => (r.flags || []).some(f => f.level !== 'info'));
    res.json({ ok: true, checked: results.length, flagged: flagged.length, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// 📇 Business-card scan: photo(s) — front and back — → Cloud Vision OCR → contact fields for the Add form
// Card layout intelligence: the company is usually the BIGGEST text on the card, the
// person's name sits near a role word ("Owner"), and addresses/phones have shapes.
// We use Vision's letter sizes + positions instead of guessing from a text dump.
const CARD_TRADE_RE = /construction|electric|plumb|roof|paint|hvac|\bair\b|floor|concrete|fram|drywall|stucco|landscap|cabinet|tile|insulat|iron|glass|window|door|solar|remodel|build|masonry|weld|fenc|pool|paving|grading|demo/i;
const CARD_SUFFIX_RE = /\b(LLC|INC\.?|CORP\.?|CO\.?|COMPANY|SERVICES?|CONSTRUCTION|BUILDERS?|CONTRACTORS?|ENTERPRISES?|GROUP|SOLUTIONS|SONS?)\b/i;
const CARD_ROLE_RE = /\b(owner|president|ceo|vice president|manager|estimator|founder|principal|supervisor|foreman|operations|sales|contractor)\b/i;
const CARD_ADDR_RE = /\b\d{2,6}\s+[A-Za-z].*\b(St|Street|Ave|Avenue|Blvd|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Suite|Ste|Unit)\b|\b[A-Z][a-z]+,?\s+CA\b|\bCA\s*,?\s*\d{5}/i;
function cardIsPersonName(t) {
  const toks = t.replace(/[.,]/g, '').split(/\s+/);
  if (toks.length < 2 || toks.length > 4) return false;
  if (CARD_TRADE_RE.test(t) || CARD_SUFFIX_RE.test(t) || CARD_ROLE_RE.test(t) || /[\d@\/]/.test(t)) return false;
  return toks.every(w => /^([A-Z][a-zA-Z'’-]+|[A-Z]{2,14}|[A-Z]\.)$/.test(w));
}
function cardLinesFromVision(resp) {
  // One entry per paragraph, with the average LETTER height (≈ font size) and position
  const out = [];
  const pages = ((resp || {}).fullTextAnnotation || {}).pages || [];
  pages.forEach(p => (p.blocks || []).forEach(b => (b.paragraphs || []).forEach(par => {
    const words = (par.words || []).map(w => (w.symbols || []).map(sy => sy.text).join(''));
    const text = words.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const hs = (par.words || []).map(w => {
      const vs = ((w.boundingBox || {}).vertices) || [];
      const ys = vs.map(v => v.y || 0);
      return ys.length ? Math.max.apply(null, ys) - Math.min.apply(null, ys) : 0;
    }).filter(h => h > 0);
    const h = hs.length ? hs.reduce((a, c) => a + c, 0) / hs.length : 0;
    const vs = ((par.boundingBox || {}).vertices) || [];
    out.push({ text, h, y: vs.length ? Math.min.apply(null, vs.map(v => v.y || 0)) : 0 });
  })));
  // Normalize heights per image so front + back merge fairly
  const maxH = Math.max.apply(null, out.map(l => l.h).concat([1]));
  out.forEach(l => { l.hr = l.h / maxH; });
  return out;
}
app.post('/subs/card/scan', requireAuth, upload.array('card', 4), async (req, res) => {
  try {
    if (!process.env.GOOGLE_PLACES_API_KEY) return res.status(400).json({ ok: false, error: 'Vision API key not configured.' });
    const files = (req.files || []).filter(f => f && f.buffer);
    if (!files.length) return res.status(400).json({ ok: false, error: 'No image received.' });
    const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + process.env.GOOGLE_PLACES_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: files.map(f => ({ image: { content: f.buffer.toString('base64') }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] })) }),
    });
    const d = await r.json();
    const text = (d.responses || []).map(x => (x.fullTextAnnotation || {}).text || '').join('\n');
    if (!text.trim()) return res.json({ ok: false, error: 'Could not read any text on that photo — try a sharper, straight-on shot.' });
    let lines = [];
    (d.responses || []).forEach(resp => { lines = lines.concat(cardLinesFromVision(resp)); });
    if (!lines.length) lines = text.split('\n').map(l => ({ text: l.trim(), hr: 0.5, y: 0 })).filter(l => l.text);

    const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0].toLowerCase();
    const website = (text.match(/\b(?:www\.)[\w-]+\.[a-z]{2,}(?:\.[a-z]{2})?\b|\bhttps?:\/\/[\w.-]+\.[a-z]{2,}\b/i) || [''])[0];
    const lic = (text.match(/(?:lic(?:ense)?\.?\s*#?\s*|csl[b#]?\s*#?\s*|st\.?\s*lic\.?\s*#?\s*)([A-C]?-?\d{5,8})/i) || [])[1] || '';
    // Phone: prefer one labeled cell/mobile, else the first one on the card
    const phones = [];
    lines.forEach(l => {
      const m = l.text.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
      if (m) phones.push({ n: m[0], cell: /\b(c|cell|mobile|m)\b\s*[:.]?/i.test(l.text) });
    });
    const phonePick = (phones.find(p => p.cell) || phones[0] || { n: '' }).n;
    const phone = phonePick.replace(/[\s.]+/g, '-').replace(/^\(?(\d{3})\)?-?(\d{3})-?(\d{4})$/, '($1) $2-$3');

    // Company: score every line — big text, business suffix, trade words good; names, roles, addresses, contact lines bad
    const isJunk = t => /[\w.+-]+@|\bwww\.|https?:\/\//i.test(t) || /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/.test(t) || /lic(?:ense)?\.?\s*#|csl[b#]/i.test(t);
    let company = '', companyScore = -1e9;
    lines.forEach(l => {
      const t = l.text;
      if (t.length < 3 || t.length > 60 || isJunk(t)) return;
      let sc = l.hr * 4;
      if (CARD_SUFFIX_RE.test(t)) sc += 3;
      if (CARD_TRADE_RE.test(t)) sc += 2;
      if (cardIsPersonName(t)) sc -= 2.5;
      if (CARD_ROLE_RE.test(t) && t.split(/\s+/).length <= 3) sc -= 4;
      if (CARD_ADDR_RE.test(t)) sc -= 5;
      if (sc > companyScore) { companyScore = sc; company = t; }
    });
    company = company.replace(/\s{2,}/g, ' ').trim().slice(0, 120);

    // Owner: best person-name line — a role word on the line right below it is a strong signal
    const sorted = lines.slice().sort((a, b) => a.y - b.y);
    let owner = '', ownerScore = -1e9;
    sorted.forEach((l, i) => {
      if (!cardIsPersonName(l.text) || l.text === company) return;
      let sc = l.hr * 2;
      const next = sorted[i + 1];
      if (next && CARD_ROLE_RE.test(next.text)) sc += 3;
      if (email && email.includes(l.text.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, ''))) sc += 1.5;
      if (sc > ownerScore) { ownerScore = sc; owner = l.text; }
    });
    // Title-case an ALL-CAPS name so it saves clean
    if (owner === owner.toUpperCase()) owner = owner.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

    const trade = qbTradeFromName(company + ' ' + text.slice(0, 400)) || '';
    const location = countyFromZip(text) || '';   // zip on the card → service-area guess
    const noteBits = [];
    if (website) noteBits.push(website);
    const addrLine = lines.find(l => CARD_ADDR_RE.test(l.text) && /\d/.test(l.text));
    if (addrLine) noteBits.push(addrLine.text.slice(0, 90));
    res.json({ ok: true, company, owner, email, phone, license_number: lic.replace(/\D/g, ''), trade, location, note: noteBits.join(' · ').slice(0, 180) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Insurance watchdog: scan every sub's emailed COIs for expiration dates (3-segment path)
app.post('/subs/insurance/scan-all', requireAuth, async (req, res) => {
  try {
    if (!useGmail) return res.status(400).json({ ok: false, error: 'Gmail not configured.' });
    const out = await insuranceScanAll();
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// (The standalone Bids page is gone — bids live in the Subs list as the "Bid Under Review"
// section. The bids table stays: the QB ingester fills it and the 📄 jump-to-bid links use it.)

// Sub Finder page (lives under /subs so it inherits the Subs access rules — Rick can use it)
app.get('/subs/finder', requireAuth, async (req, res) => {
  try {
    await initDb();
    res.render('subfinder', { CSLB_CLASS_BY_TRADE, ONLINE_TRADES: Object.keys(ONLINE_TRADE_QUERIES) });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Search CSLB by classification + counties → JSON rows, annotated with what's already in your list
app.post('/subs/finder/search', requireAuth, async (req, res) => {
  try {
    const classification = String(req.body.classification || '').trim().toUpperCase();
    const counties = [].concat(req.body.counties || []).filter(Boolean);
    if (!classification) return res.json({ ok: false, error: 'Pick a classification.' });
    if (!counties.length) return res.json({ ok: false, error: 'Pick at least one county.' });
    const rows = await cslbSearchByCounty(classification, counties);
    // Mark contractors already in the Subs list (by license # or company name)
    const { rows: mine } = await pool.query("SELECT license_number, LOWER(company) co FROM subcontractors");
    const licSet = new Set(mine.map(m => String(m.license_number || '').replace(/\D/g, '')).filter(Boolean));
    const nameSet = new Set(mine.map(m => (m.co || '').trim()).filter(Boolean));
    rows.forEach(r => { r.inList = licSet.has(String(r.licNum)) || nameSet.has(r.name.toLowerCase()); });
    res.json({ ok: true, count: rows.length, rows });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// Add selected CSLB results to the Subs list (Under Vetting), deduped by license #
app.post('/subs/finder/add', requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
    const trade = normalizeType(String(req.body.trade || '').slice(0, 100));
    if (!items.length) return res.json({ ok: false, error: 'Nothing selected.' });
    const { rows: mine } = await pool.query('SELECT license_number FROM subcontractors');
    const licSet = new Set(mine.map(m => String(m.license_number || '').replace(/\D/g, '')).filter(Boolean));
    let added = 0, skipped = 0;
    for (const it of items) {
      const lic = String(it.licNum || '').replace(/\D/g, '');
      if (!lic || licSet.has(lic)) { skipped++; continue; }
      licSet.add(lic);
      const isGC = /(^|\|)\s*B\s*($|\|)/.test(String(it.classes || '')) && /general contractor/i.test(trade || '');
      const cat = isGC || /general contractor/i.test(trade) ? 'gc' : 'sub';
      const grp = cat === 'gc' ? 'Under Vetting' : 'Under Vetting';
      const name = String(it.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const title = name.replace(/\w\S*/g, w => /^(LLC|INC|DBA|CA|USA|HVAC|II|III|IV)\.?,?$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase());
      const exp = cslbDate(it.expires);
      await pool.query(
        `INSERT INTO subcontractors (company, location, type, status, phone, notes, group_label, category, sort_order,
           license_number, licensed, license_status, license_expire, license_classes, license_checked_at, recent_add)
         VALUES ($1,$2,$3,'Under Review',$4,$5,$6,$7,9999,$8,true,$9,$10,$11,NOW(),TRUE)`,
        [title, cslbCountyToLocation(it.county), trade || null, it.phone || null,
         ('Sourced from CSLB ' + new Date().toLocaleDateString() + (it.city ? ' · ' + it.city : '') + (it.address ? ' · ' + it.address : '')).slice(0, 480),
         grp, cat, lic, it.status || null, exp ? exp.toISOString().slice(0, 10) : null, it.classes || null]
      );
      added++;
    }
    res.json({ ok: true, added, skipped });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Online sub search (Yelp / Google Places) — handymen & small operators that
//    aren't in the state license database. Uses whichever API key is configured.
// Construction-focused query templates so results stay on-trade (contractors,
// not tile stores / lumber yards / art studios).
const ONLINE_TRADE_QUERIES = {
  'General Contractor': 'general contractor',
  'Handyman': 'handyman',
  'Electrician': 'electrician',
  'Plumber': 'plumbing contractor',
  'Drywall': 'drywall contractor',
  'Framing': 'framing contractor',
  'Metal Framing': 'metal stud framing contractor',
  'Painter': 'painting contractor',
  'HVAC': 'HVAC contractor',
  'Flooring': 'flooring installation contractor',
  'Windows & Doors': 'window and door installer',
  'Roofing': 'roofing contractor',
  'Concrete': 'concrete contractor',
  'Foundation': 'foundation contractor',
  'Masonry': 'masonry contractor',
  'Demolition': 'demolition contractor',
  'Junk Removal': 'junk removal service',
  'Landscaping': 'landscaping company',
  'Tile': 'tile installation contractor',
  'Stone': 'stone masonry contractor',
  'Countertops': 'countertop installer',
  'Cabinets': 'custom cabinet maker',
  'Solar': 'solar panel installer',
  'Stucco': 'stucco contractor',
  'Insulation': 'insulation contractor',
  'Fire Sprinklers': 'fire sprinkler contractor',
  'Decking': 'deck builder',
  'Finishes': 'finish carpentry contractor',
  'Tree Removal': 'tree removal service',
  'Methane': 'methane mitigation contractor',
};
// County-wide search: one city query only covers ~20 results around that spot, so a
// county search fans out across zones and merges (dupes collapse automatically).
const ONLINE_COUNTY_ZONES = {
  'LA County': ['Los Angeles, CA', 'Long Beach, CA', 'Pasadena, CA', 'Santa Clarita, CA', 'Torrance, CA', 'Whittier, CA', 'Van Nuys, CA', 'Pomona, CA'],
  'The Valley': ['Van Nuys, CA', 'Northridge, CA', 'Burbank, CA', 'Woodland Hills, CA', 'San Fernando, CA'],
  'Orange County': ['Anaheim, CA', 'Santa Ana, CA', 'Irvine, CA', 'Huntington Beach, CA', 'Mission Viejo, CA'],
  'Riverside County': ['Riverside, CA', 'Temecula, CA', 'Moreno Valley, CA', 'Palm Springs, CA'],
  'San Bernardino County': ['San Bernardino, CA', 'Ontario, CA', 'Rancho Cucamonga, CA', 'Victorville, CA'],
  'San Diego County': ['San Diego, CA', 'Oceanside, CA', 'Chula Vista, CA', 'Escondido, CA'],
  'Ventura County': ['Ventura, CA', 'Oxnard, CA', 'Thousand Oaks, CA', 'Simi Valley, CA'],
};
// Google place types that mean "this is a shop, not a contractor" — dropped from
// results unless the place is ALSO typed as a contractor.
const ONLINE_RETAIL_TYPES = ['hardware_store', 'home_improvement_store', 'building_materials_store', 'furniture_store', 'home_goods_store', 'department_store', 'shopping_mall', 'supermarket', 'grocery_store', 'clothing_store', 'electronics_store', 'cell_phone_store', 'gift_shop', 'garden_center', 'florist'];
const ONLINE_CONTRACTOR_TYPES = ['general_contractor', 'electrician', 'plumber', 'roofing_contractor', 'painter'];
async function yelpSearch(term, location) {
  const key = process.env.YELP_API_KEY;
  const u = 'https://api.yelp.com/v3/businesses/search?' + new URLSearchParams({ term, location, limit: '50', sort_by: 'best_match' });
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error('Yelp: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const d = await r.json();
  return (d.businesses || []).map(b => ({
    source: 'Yelp', name: b.name || '', phone: b.display_phone || '',
    address: (b.location && (b.location.display_address || []).join(', ')) || '',
    rating: b.rating || null, reviews: b.review_count || 0, link: b.url || '',
    tags: (b.categories || []).map(c => c.title).join(', '),
  }));
}
async function googlePlacesSearch(term, location, opts = {}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.nationalPhoneNumber,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.websiteUri,places.types' },
    body: JSON.stringify({ textQuery: term + ' in ' + location, pageSize: 20 }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Google Places: ' + ((d.error && d.error.message) || 'HTTP ' + r.status).slice(0, 150));
  return (d.places || []).filter(p => {
    if (opts.keepRetail) return true;   // supplier search: stores ARE the target
    // Sub search: drop retail shops unless Google also types them as a contractor
    const types = p.types || [];
    const retail = types.some(t => ONLINE_RETAIL_TYPES.includes(t));
    const contractor = types.some(t => ONLINE_CONTRACTOR_TYPES.includes(t));
    return !retail || contractor;
  }).map(p => ({
    source: 'Google', name: (p.displayName && p.displayName.text) || '', phone: p.nationalPhoneNumber || '',
    address: p.formattedAddress || '', rating: p.rating || null, reviews: p.userRatingCount || 0,
    link: p.googleMapsUri || '', website: p.websiteUri || '', tags: (p.types || []).slice(0, 3).join(', ').replace(/_/g, ' '),
  }));
}
app.post('/subs/finder/online-search', requireAuth, async (req, res) => {
  try {
    // A custom term wins; otherwise the picked trade maps to its contractor-focused query
    const trade = String(req.body.trade || '').trim();
    let term = String(req.body.term || '').trim().slice(0, 80);
    if (!term && ONLINE_TRADE_QUERIES[trade]) term = ONLINE_TRADE_QUERIES[trade];
    if (!term) return res.json({ ok: false, error: 'Pick a trade (or type a custom search).' });
    // City/zip = one focused query; county = fan out across its zones and merge
    const city = String(req.body.location || '').trim().slice(0, 80);
    const county = String(req.body.county || '').trim();
    const zones = city ? [city] : (ONLINE_COUNTY_ZONES[county] || ['Los Angeles, CA']);
    const providers = [];
    for (const z of zones) {
      if (process.env.YELP_API_KEY) providers.push(yelpSearch(term, z).catch(e => ({ err: e.message })));
      if (process.env.GOOGLE_PLACES_API_KEY) providers.push(googlePlacesSearch(term, z).catch(e => ({ err: e.message })));
    }
    if (!providers.length) return res.json({ ok: false, needsSetup: true, error: 'Online search isn\'t connected yet — a Yelp or Google Places API key needs to be added.' });
    const settled = await Promise.all(providers);
    const errors = [...new Set(settled.filter(s => s && s.err).map(s => s.err))];
    const all = settled.filter(Array.isArray).flat();
    // Merge Yelp + Google results, dedupe by normalized business name
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const byName = new Map();
    for (const r of all) {
      const k = norm(r.name);
      if (!k) continue;
      const prev = byName.get(k);
      if (!prev) byName.set(k, { ...r });
      else {
        prev.source += ' + ' + r.source;
        if (!prev.phone && r.phone) prev.phone = r.phone;
        prev.reviews = Math.max(prev.reviews || 0, r.reviews || 0);
        if (!prev.rating && r.rating) prev.rating = r.rating;
      }
    }
    const rows = [...byName.values()].sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
    const { rows: mine } = await pool.query('SELECT LOWER(company) co FROM subcontractors');
    const nameSet = new Set(mine.map(m => norm(m.co)));
    rows.forEach(r => { r.inList = nameSet.has(norm(r.name)); });
    res.json({ ok: true, count: rows.length, rows, errors });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
// Add selected online results to the Subs list (deduped by company name)
app.post('/subs/finder/add-online', requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];
    const trade = normalizeType(String(req.body.trade || '').slice(0, 100));
    if (!items.length) return res.json({ ok: false, error: 'Nothing selected.' });
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const { rows: mine } = await pool.query('SELECT LOWER(company) co FROM subcontractors');
    const nameSet = new Set(mine.map(m => norm(m.co)));
    let added = 0, skipped = 0;
    for (const it of items) {
      const name = String(it.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const k = norm(name);
      if (!k || nameSet.has(k)) { skipped++; continue; }
      nameSet.add(k);
      const bits = ['Sourced from ' + (String(it.source || 'online').slice(0, 30)) + ' ' + new Date().toLocaleDateString()];
      if (it.rating) bits.push('★' + it.rating + (it.reviews ? ' (' + it.reviews + ' reviews)' : ''));
      if (it.address) bits.push(String(it.address).slice(0, 120));
      if (it.link) bits.push(String(it.link).split('?')[0].slice(0, 140));
      await pool.query(
        `INSERT INTO subcontractors (company, type, status, phone, location, notes, group_label, category, sort_order, recent_add)
         VALUES ($1,$2,'Under Review',$3,$4,$5,'Under Vetting','sub',9999,TRUE)`,
        [name, trade || null, String(it.phone || '').slice(0, 40) || null,
         countyFromZip(it.address) || null, bits.join(' · ').slice(0, 480)]
      );
      added++;
    }
    res.json({ ok: true, added, skipped });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Supplier Finder — same county-wide online search, tuned for material suppliers ──
const SUPPLIER_QUERIES = {
  'Lumber': 'lumber yard',
  'Building Materials': 'building materials supplier',
  'Plumbing Supply': 'plumbing supply house',
  'Electrical Supply': 'electrical supply house',
  'Lighting': 'lighting showroom',
  'HVAC Supply': 'HVAC supply house',
  'Tile & Stone': 'tile and stone supplier',
  'Countertops / Slabs': 'granite quartz slab supplier',
  'Flooring': 'flooring supplier',
  'Cabinets & Millwork': 'kitchen cabinet supplier',
  'Doors & Windows': 'door and window supplier',
  'Hardware': 'builders hardware supplier',
  'Appliances': 'appliance store',
  'Paint': 'paint store',
  'Drywall Supply': 'drywall supplier',
  'Stucco / Plaster Supply': 'stucco supply',
  'Roofing Supply': 'roofing supply',
  'Concrete / Masonry Supply': 'concrete and masonry supply',
  'Insulation': 'insulation supplier',
  'Shower Doors / Glass': 'glass and shower door company',
  'Water Heaters': 'water heater supplier',
  'Fasteners / Rebar': 'fastener and rebar supplier',
  'Tool Rental': 'tool and equipment rental',
};
app.get('/suppliers/finder', requireAuth, async (req, res) => {
  try {
    await initDb();
    res.render('supfinder', { SUPPLIER_CATS: Object.keys(SUPPLIER_QUERIES) });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
app.post('/suppliers/finder/search', requireAuth, async (req, res) => {
  try {
    const cat = String(req.body.category || '').trim();
    let term = String(req.body.term || '').trim().slice(0, 80);
    if (!term && SUPPLIER_QUERIES[cat]) term = SUPPLIER_QUERIES[cat];
    if (!term) return res.json({ ok: false, error: 'Pick a category (or type a custom search).' });
    const city = String(req.body.location || '').trim().slice(0, 80);
    const county = String(req.body.county || '').trim();
    const zones = city ? [city] : (ONLINE_COUNTY_ZONES[county] || ['Los Angeles, CA']);
    const providers = [];
    for (const z of zones) {
      if (process.env.YELP_API_KEY) providers.push(yelpSearch(term, z).catch(e => ({ err: e.message })));
      if (process.env.GOOGLE_PLACES_API_KEY) providers.push(googlePlacesSearch(term, z, { keepRetail: true }).catch(e => ({ err: e.message })));
    }
    if (!providers.length) return res.json({ ok: false, needsSetup: true, error: 'Online search isn\'t connected yet — a Yelp or Google Places API key needs to be added.' });
    const settled = await Promise.all(providers);
    const errors = [...new Set(settled.filter(s => s && s.err).map(s => s.err))];
    const all = settled.filter(Array.isArray).flat();
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const byName = new Map();
    for (const r of all) {
      const k = norm(r.name);
      if (!k) continue;
      const prev = byName.get(k);
      if (!prev) byName.set(k, { ...r });
      else {
        prev.source += ' + ' + r.source;
        if (!prev.phone && r.phone) prev.phone = r.phone;
        if (!prev.website && r.website) prev.website = r.website;
        prev.reviews = Math.max(prev.reviews || 0, r.reviews || 0);
        if (!prev.rating && r.rating) prev.rating = r.rating;
      }
    }
    const rows = [...byName.values()].sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
    // already known? check the directory AND the per-material RFQ contacts
    const { rows: dir } = await pool.query('SELECT LOWER(name) nm FROM supplier_directory');
    const { rows: rfq } = await pool.query('SELECT LOWER(supplier_name) nm FROM suppliers WHERE supplier_name IS NOT NULL');
    const known = new Set([...dir, ...rfq].map(m => norm(m.nm)).filter(Boolean));
    rows.forEach(r => { r.inList = known.has(norm(r.name)); });
    res.json({ ok: true, count: rows.length, rows, errors });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/suppliers/finder/add', requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];
    const category = String(req.body.category || '').trim().slice(0, 60) || null;
    if (!items.length) return res.json({ ok: false, error: 'Nothing selected.' });
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const { rows: dir } = await pool.query('SELECT LOWER(name) nm FROM supplier_directory');
    const known = new Set(dir.map(m => norm(m.nm)));
    let added = 0, skipped = 0;
    for (const it of items) {
      const name = String(it.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const k = norm(name);
      if (!k || known.has(k)) { skipped++; continue; }
      known.add(k);
      await pool.query(
        `INSERT INTO supplier_directory (name, category, phone, website, address, rating, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [name, category, String(it.phone || '').slice(0, 40) || null,
         String(it.website || it.link || '').split('?')[0].slice(0, 200) || null,
         String(it.address || '').slice(0, 200) || null,
         it.rating ? ('★' + it.rating + (it.reviews ? ' (' + it.reviews + ')' : '')) : null,
         'Found via Supplier Finder ' + new Date().toLocaleDateString()]
      );
      added++;
    }
    res.json({ ok: true, added, skipped });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// Inline edits + delete for directory entries
app.post('/suppliers/directory/:id/field', requireAuth, async (req, res) => {
  try {
    const allowed = ['email', 'phone', 'notes', 'category'];
    const sets = [], vals = [];
    for (const k of allowed) {
      if (!(k in req.body)) continue;
      const v = (req.body[k] != null && String(req.body[k]).trim()) ? String(req.body[k]).trim().slice(0, 200) : null;
      sets.push(`${k}=$${vals.length + 1}`); vals.push(v);
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE supplier_directory SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/suppliers/directory/:id/delete', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM supplier_directory WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Set just the note/reason on a flagged (rejected/blacklisted) contractor
app.post('/subs/:id/reason', requireAuth, async (req, res) => {
  try {
    const reason = (req.body.reason != null && String(req.body.reason).trim()) ? String(req.body.reason).trim().slice(0, 500) : null;
    await pool.query('UPDATE subcontractors SET reject_reason=$1 WHERE id=$2', [reason, req.params.id]);
    res.json({ ok: true, reason });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/subs/:id/move', requireAuth, async (req, res) => {
  try {
    const cat = req.body.category === 'gc' ? 'gc' : 'sub';
    const grp = req.body.group_label || null;
    // Drop it at the end of the target bucket so it lands in the right place
    const { rows: [m] } = await pool.query('SELECT MAX(sort_order) mx FROM subcontractors WHERE category=$1 AND group_label IS NOT DISTINCT FROM $2', [cat, grp]);
    const so = (m && m.mx != null) ? m.mx + 1 : null;
    const newStatus = statusForBucket(grp);          // keep the status pill in sync with the section
    const flagged = /reject|black/i.test(grp || '');
    if (newStatus && flagged) {
      const reason = (req.body.reason != null && String(req.body.reason).trim()) ? String(req.body.reason).trim().slice(0, 500) : null;
      await pool.query('UPDATE subcontractors SET category=$1, group_label=$2, sort_order=COALESCE($3, sort_order), status=$4, reject_reason=COALESCE($5, reject_reason) WHERE id=$6', [cat, grp, so, newStatus, reason, req.params.id]);
    } else if (newStatus) {
      await pool.query('UPDATE subcontractors SET category=$1, group_label=$2, sort_order=COALESCE($3, sort_order), status=$4, reject_reason=NULL WHERE id=$5', [cat, grp, so, newStatus, req.params.id]);
    } else {
      await pool.query('UPDATE subcontractors SET category=$1, group_label=$2, sort_order=COALESCE($3, sort_order) WHERE id=$4', [cat, grp, so, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/subs/:id/delete', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM subcontractors WHERE id=$1', [req.params.id]); res.redirect('/subs'); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Email a subcontractor and log it under that sub
app.post('/subs/:id/email', requireAuth, async (req, res) => {
  try {
    const subject = String(req.body.subject || '').trim();
    const body = String(req.body.body || '');
    if (!subject) return res.status(400).json({ ok: false, error: 'Add a subject.' });
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email isn’t configured on the server.' });
    const { rows: [sub] } = await pool.query('SELECT id, company, owner, email FROM subcontractors WHERE id=$1', [req.params.id]);
    if (!sub) return res.status(404).json({ ok: false, error: 'Subcontractor not found.' });
    if (!sub.email) return res.status(400).json({ ok: false, error: 'This sub has no email on file — add one first (✏️).' });
    // Optional Google Drive link to the construction-drawings (CD) set / plans.
    const plansRaw = String(req.body.plans || '').trim();
    if (plansRaw && !/^https?:\/\//i.test(plansRaw)) {
      return res.status(400).json({ ok: false, error: 'The plans link must start with http:// or https://' });
    }
    let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${escapeHtml(body)}</div>`;
    if (plansRaw) {
      html += `<p style="font-family:Arial,sans-serif;font-size:14px;color:#222;margin:14px 0"><strong>📐 Full plans (CD set):</strong> <a href="${escapeHtml(plansRaw)}">${escapeHtml(plansRaw)}</a></p>`;
    }
    const sig = await getGmailSignature();
    if (sig) html += `<br><br>${sig}`;
    const sent = await sendMail({ to: sub.email, subject, html });
    const logBody = plansRaw ? (body + (body ? '\n\n' : '') + 'Plans: ' + plansRaw) : body;
    await pool.query(
      "INSERT INTO sub_emails (sub_id, to_email, subject, body, sent_by, direction, gmail_thread_id, gmail_message_id) VALUES ($1,$2,$3,$4,$5,'out',$6,$7)",
      [sub.id, sub.email, subject, logBody, sessionKey(req), (sent && sent.threadId) || null, (sent && sent.messageId) || null]
    );
    // Sending an email advances the pipeline to "Bid Sent" — but only from the early
    // vetting stages; Actives, Approved, Bid Under Review, and flagged subs stay put.
    await pool.query("UPDATE subcontractors SET bid_status='Bid Sent' WHERE id=$1", [sub.id]);
    let advanced = null;
    const { rows: [cur] } = await pool.query('SELECT status FROM subcontractors WHERE id=$1', [sub.id]);
    if (cur && !/active|approv|inactive|reject|black|bid under review|bid request/i.test(cur.status || '')) {
      advanced = 'Bid Requested';
      await pool.query("UPDATE subcontractors SET status='Bid Requested', group_label='Bid Requested' WHERE id=$1", [sub.id]);
    }
    res.json({ ok: true, bid_status: 'Bid Sent', status: advanced });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Mark a sub's replies as seen — clears the unread-reply badge on their row
app.post('/subs/:id/replies/seen', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE subcontractors SET reply_unread=false, replies_viewed_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Reply to a sub inside their existing Gmail thread — straight from the subs page
app.post('/subs/:id/reply', requireAuth, async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email isn’t configured on the server.' });
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ ok: false, error: 'Write a reply first.' });
    const { rows: [sub] } = await pool.query('SELECT id, email FROM subcontractors WHERE id=$1', [req.params.id]);
    if (!sub) return res.status(404).json({ ok: false, error: 'Subcontractor not found.' });
    if (!sub.email) return res.status(400).json({ ok: false, error: 'This sub has no email on file.' });
    // Reply into the sub's most recent thread.
    const { rows: [row] } = await pool.query(
      "SELECT gmail_thread_id, subject FROM sub_emails WHERE sub_id=$1 AND gmail_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [req.params.id]);
    if (!row) return res.status(400).json({ ok: false, error: 'No email thread yet — use the ✉ button to start one.' });
    let subject = row.subject || '';
    let inReplyTo = null, references = '';
    if (useGmail) {
      try {
        const messages = await fetchThread(row.gmail_thread_id);
        if (messages.length) {
          const last = messages[messages.length - 1];
          subject = last.subject || subject;
          inReplyTo = last.messageIdHeader || null;
          references = [last.references, last.messageIdHeader].filter(Boolean).join(' ');
        }
      } catch (e) { /* fall back to stored subject without threading headers */ }
    }
    if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;
    let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${escapeHtml(body)}</div>`;
    const sig = await getGmailSignature();
    if (sig) html += `<br><br>${sig}`;
    const sent = await sendMail({ to: sub.email, subject, html, threadId: row.gmail_thread_id, inReplyTo, references });
    await pool.query(
      "INSERT INTO sub_emails (sub_id, to_email, subject, body, sent_by, direction, gmail_thread_id, gmail_message_id) VALUES ($1,$2,$3,$4,$5,'out',$6,$7)",
      [sub.id, sub.email, subject, body, sessionKey(req), (sent && sent.threadId) || row.gmail_thread_id, (sent && sent.messageId) || null]);
    // Replies advance the pipeline the same way the composer does: Under Review → Bid Requested
    let advanced = null;
    const { rows: [cur] } = await pool.query('SELECT status FROM subcontractors WHERE id=$1', [sub.id]);
    if (cur && !/active|approv|inactive|reject|black|bid under review|bid request/i.test(cur.status || '')) {
      advanced = 'Bid Requested';
      await pool.query("UPDATE subcontractors SET status='Bid Requested', group_label='Bid Requested', bid_status='Bid Sent' WHERE id=$1", [sub.id]);
    }
    res.json({ ok: true, subject, status: advanced });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// COI chaser: one click sends a templated "send us your updated insurance cert" email —
// into their existing thread when there is one, fresh otherwise. Tracks when we asked.
app.post('/subs/:id/chase-coi', requireAuth, async (req, res) => {
  try {
    if (!emailEnabled) return res.status(400).json({ ok: false, error: 'Email isn’t configured on the server.' });
    const { rows: [sub] } = await pool.query('SELECT id, company, owner, email, ins_expires FROM subcontractors WHERE id=$1', [req.params.id]);
    if (!sub) return res.status(404).json({ ok: false, error: 'Contractor not found.' });
    if (!sub.email) return res.status(400).json({ ok: false, error: 'No email on file for this sub.' });
    const expired = sub.ins_expires && new Date(sub.ins_expires) < new Date();
    const when = sub.ins_expires ? new Date(sub.ins_expires).toLocaleDateString() : '';
    const name = (String(sub.owner || '').trim().split(/\s+/)[0]) || sub.company || 'there';
    const body = 'Hi ' + name + ',\n\n'
      + (expired
        ? 'Our records show the insurance certificate we have on file for ' + (sub.company || 'your company') + ' expired on ' + when + '.'
        : 'Our records show the insurance certificate we have on file for ' + (sub.company || 'your company') + ' expires on ' + when + '.')
      + ' To keep you eligible for upcoming Buildoly projects, we need a current certificate.\n\n'
      + '**Please reply directly to THIS email with your updated COI attached (general liability + workers’ comp) so everything stays together in one place.**\n\n'
      + 'Thank you!';
    const subject = 'Updated insurance certificate needed — Buildoly';
    // Prefer replying into their most recent thread so their reply lands where we watch
    const { rows: [thr] } = await pool.query(
      "SELECT gmail_thread_id FROM sub_emails WHERE sub_id=$1 AND gmail_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", [sub.id]);
    let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${emailBodyHtml(body)}</div>`;
    const sig = await getGmailSignature();
    if (sig) html += `<br><br>${sig}`;
    const sent = await sendMail({ to: sub.email, subject, html, threadId: thr ? thr.gmail_thread_id : undefined });
    await pool.query(
      "INSERT INTO sub_emails (sub_id, to_email, subject, body, sent_by, direction, gmail_thread_id, gmail_message_id) VALUES ($1,$2,$3,$4,$5,'out',$6,$7)",
      [sub.id, sub.email, subject, body, sessionKey(req), (sent && sent.threadId) || (thr ? thr.gmail_thread_id : null), (sent && sent.messageId) || null]);
    await pool.query('UPDATE subcontractors SET ins_chased_at=NOW() WHERE id=$1', [sub.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Upload a photo (business card etc.) for a subcontractor
app.post('/subs/:id/photo', requireAuth, upload.array('photos', 12), async (req, res) => {
  const ajax = req.headers['x-requested-with'] === 'fetch';
  try {
    const files = req.files || [];
    const ids = [];
    for (const f of files) {
      const { rows: [r] } = await pool.query('INSERT INTO sub_photos (sub_id, filename, mime, data) VALUES ($1,$2,$3,$4) RETURNING id',
        [req.params.id, f.originalname, f.mimetype, f.buffer]);
      ids.push(r.id);
    }
    if (ajax) return res.json({ ok: true, ids });
    res.redirect('/subs');
  } catch (err) {
    if (ajax) return res.status(500).json({ ok: false, error: err.message });
    res.status(500).send('Error: ' + err.message);
  }
});

// Delete a GC / sub entirely (photos cascade via ON DELETE CASCADE)
app.post('/subs/:id/delete', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM subcontractors WHERE id=$1', [req.params.id]); res.redirect('/subs'); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/sub-photo/:id', requireAuth, async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT mime, data FROM sub_photos WHERE id=$1', [req.params.id]);
  if (!p) return res.status(404).send('Not found');
  res.setHeader('Content-Type', p.mime || 'image/jpeg');
  res.send(p.data);
});

app.post('/sub-photo/:id/delete', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM sub_photos WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// One-time import from the Google Sheet — only adds companies not already in the DB.
app.post('/subs/import', requireAuth, async (req, res) => {
  try {
    const sheetSubs = await readSubsSheet();
    const { rows: existing } = await pool.query('SELECT LOWER(company) c FROM subcontractors WHERE company IS NOT NULL');
    const have = new Set(existing.map(r => r.c));
    let added = 0;
    for (const s of sheetSubs) {
      if (have.has(s.company.toLowerCase())) continue;
      await pool.query(
        `INSERT INTO subcontractors (company, location, type, status, owner, email, phone, projects, notes, group_label, sort_order, category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [s.company, s.location || null, normalizeType(s.type) || null, s.status || null, s.owner || null,
         s.email || null, s.phone || null, s.projects || null, s.notes || null, s.group_label || null, s.sort_order, s.category || 'sub']
      );
      have.add(s.company.toLowerCase());
      added++;
    }
    res.redirect('/subs?imported=' + added);
  } catch (err) { res.status(500).send('Import error: ' + err.message); }
});

// ── Inventory (manual office stock with purchase history + schedule draw-down) ──
// The shell renders instantly; the heavy tables (which read every schedule) load
// via AJAX from /inventory/data below.
app.get('/inventory', requireAuth, (req, res) => res.render('inventory'));

app.get('/inventory/data', requireAuth, async (req, res) => {
  try {
    await initDb();
    const items = await getInventoryItems();
    let usages = [], error = null;
    try { usages = await computeHeldUsages(); }
    catch (e) { error = e.message; }
    // Draw each item down by the held-stock schedule lines that match its Model #
    // (exact match on the schedule's Model # column), with a text fallback so a
    // plain keyword still works.
    // Held status + partial delivered_qty per held item per project.
    const { rows: hsRows } = await pool.query('SELECT project_id, item_key, status, delivered_qty FROM held_item_status');
    const hsMap = {};
    for (const r of hsRows) hsMap[r.project_id + '|' + r.item_key] = r;

    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const enriched = items.map(it => {
      const term = (it.product || it.name || '').toLowerCase().trim();
      const nterm = norm(term);
      // Exact match on Model # or Prod. Code (so S-VG01 never matches S-VG01B),
      // with a name-keyword fallback only when the term isn't a code/model.
      const matched = term
        ? usages.filter(u =>
            (nterm && (norm(u.model) === nterm || norm(u.prodCode) === nterm)) ||
            String(u.name || '').toLowerCase().includes(term))
        : [];
      const byProject = {};
      let delivered = 0;
      for (const u of matched) {
        const d = deliveredQtyOf(hsMap[u.projectId + '|' + u.itemKey], u.qty);
        delivered += d;
        if (!byProject[u.projectId]) {
          byProject[u.projectId] = {
            address: u.project, projectId: u.projectId, code: u.code,
            qty: 0, delivered: 0, itemKeys: [],
          };
        }
        const bp = byProject[u.projectId];
        bp.qty += u.qty;
        bp.delivered += d;
        if (!bp.itemKeys.includes(u.itemKey)) bp.itemKeys.push(u.itemKey);
      }
      const projects = Object.values(byProject).map(bp => ({
        address: bp.address, projectId: bp.projectId, code: bp.code,
        qty: bp.qty, delivered: bp.delivered, itemKeys: bp.itemKeys,
      }));
      const inUse = matched.reduce((s, u) => s + u.qty, 0);
      // Product name for this code, pulled from the matched schedule line(s)
      const productName = matched.length
        ? ((matched.find(u => u.product) || {}).product || (matched.find(u => u.name) || {}).name || '')
        : '';
      const qty = it.qty || 0;
      const location = (matched.find(u => u.location) || {}).location || 'office';
      return {
        ...it, inUse, available: qty - inUse, productName, location,
        delivered,                  // pulled out of the office & delivered to jobs
        inOffice: qty - delivered,  // physically still on the shelf
        byProject: projects,
      };
    });

    // Office stock = manually-stocked Jedco items + range hoods (bulk on-hand qty).
    const officeItems = enriched.filter(it => it.location !== 'warehouse');

    // Warehouse stock = everything else we hold as Buildoly Stock (vanities, closets,
    // decking, LVP, cabinets, pantry, linen…). These are built/ordered per job, so we
    // auto-derive them straight from the schedules — no manual adding, just per-project
    // pull/delivered tracking.
    const whMap = {};
    for (const u of usages) {
      if (u.location !== 'warehouse') continue;
      const key = u.itemKey;
      if (!whMap[key]) whMap[key] = { name: u.product || u.name || key, code: u.prodCode || '', held: 0, delivered: 0, byProject: {} };
      const w = whMap[key];
      w.held += u.qty;
      const d = deliveredQtyOf(hsMap[u.projectId + '|' + u.itemKey], u.qty);
      w.delivered += d;
      if (!w.byProject[u.projectId]) w.byProject[u.projectId] = { address: u.project, projectId: u.projectId, qty: 0, delivered: 0, itemKeys: [] };
      const bp = w.byProject[u.projectId];
      bp.qty += u.qty;
      bp.delivered += d;
      if (!bp.itemKeys.includes(u.itemKey)) bp.itemKeys.push(u.itemKey);
    }
    const warehouseItems = Object.values(whMap).map(w => ({
      name: w.name, code: w.code, held: w.held, delivered: w.delivered, inWarehouse: w.held - w.delivered,
      byProject: Object.values(w.byProject).map(bp => ({
        address: bp.address, projectId: bp.projectId, qty: bp.qty, delivered: bp.delivered, itemKeys: bp.itemKeys,
      })),
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.render('_inventory-tables', { officeItems, warehouseItems, error, sheetFails: _heldUsagesCache.fails || [] });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Force a fresh read from the schedules (after you toggle sources / edit a sheet). Kicks the
// refresh in the background and returns immediately — the client polls /inventory/status.
app.post('/inventory/refresh', requireAuth, (req, res) => {
  if (_heldRefreshing) return res.json({ ok: true, already: true, at: _heldUsagesCache.at });
  _heldRefreshing = true;
  forceRefreshHeldUsages().catch(e => console.error('force held refresh:', e.message)).finally(() => { _heldRefreshing = false; });
  res.json({ ok: true, started: true, prevAt: _heldUsagesCache.at });
});
app.get('/inventory/status', requireAuth, (req, res) => {
  res.json({ refreshing: _heldRefreshing, cachedAt: _heldUsagesCache.at, fails: (_heldUsagesCache.fails || []).length });
});

// Stock Status was merged into the Inventory page — keep the old link working.
app.get('/stock-status', requireAuth, (req, res) => res.redirect('/inventory'));

// Catalog of schedule items (for the Add-item search → auto-fill Model #)
app.get('/inventory/catalog', requireAuth, async (req, res) => {
  try {
    const items = await readScheduleCatalog();
    res.json({ ok: true, items });
  } catch (err) {
    res.json({ ok: false, error: err.message, items: [] });
  }
});

// Add an inventory item (name · product · qty)
app.post('/inventory/item/add', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const product = String(req.body.product || '').trim();
    let qty = parseInt(req.body.qty, 10); if (isNaN(qty) || qty < 0) qty = 0;
    if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
    const { rows: [row] } = await pool.query(
      'INSERT INTO inventory_items (name, product, qty) VALUES ($1,$2,$3) RETURNING id',
      [name, product, qty]
    );
    res.json({ ok: true, id: row.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Edit an inventory item (name · product · qty)
app.post('/inventory/item/:id/edit', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const product = String(req.body.product || '').trim();
    let qty = parseInt(req.body.qty, 10); if (isNaN(qty) || qty < 0) qty = 0;
    if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
    await pool.query('UPDATE inventory_items SET name=$1, product=$2, qty=$3 WHERE id=$4',
      [name, product, qty, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live-save just the qty (from the editable cell)
app.post('/inventory/item/:id/qty', requireAuth, async (req, res) => {
  try {
    let qty = parseInt(req.body.qty, 10); if (isNaN(qty) || qty < 0) qty = 0;
    await pool.query('UPDATE inventory_items SET qty=$1 WHERE id=$2', [qty, req.params.id]);
    res.json({ ok: true, qty });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete an inventory item
app.post('/inventory/item/:id/delete', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM inventory_items WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
    const { rows } = await pool.query('SELECT gmail_thread_id, subject, supplier_email, last_viewed_at FROM vendor_emails WHERE gmail_thread_id IS NOT NULL');
    for (const r of rows) {
      try {
        // Include reply threads that split off from the original (same subject + vendor).
        const ids = new Set([r.gmail_thread_id]);
        (await relatedThreadIds(r.subject, r.supplier_email)).forEach(id => ids.add(id));
        const inbound = [];
        for (const id of ids) { try { inbound.push(...(await fetchThread(id)).filter(m => !m.fromMe)); } catch (e) { /* skip */ } }
        if (!inbound.length) continue;
        const latestDate = new Date(Math.max(...inbound.map(m => new Date(m.date).getTime())));
        const lastViewed = r.last_viewed_at ? new Date(r.last_viewed_at) : new Date(0);
        await pool.query('UPDATE vendor_emails SET has_unread=$1, last_inbound_at=$2 WHERE gmail_thread_id=$3',
          [latestDate > lastViewed, latestDate, r.gmail_thread_id]);
      } catch (e) { /* skip individual thread errors */ }
    }
  } catch (e) { console.error('checkUnreadThreads:', e.message); }
}

// Drop quoted history / signatures so the date parser only reads the vendor's NEW words.
function stripQuotedReply(t) {
  let s = String(t || '');
  // HTML replies: drop the quote blocks (which contain OUR original request + its dates), then
  // reduce to plain text so the parser only sees the vendor's new words.
  if (/<[a-z][\s\S]*>/i.test(s)) {
    s = s.replace(/<blockquote[\s\S]*$/i, ' ')
         .replace(/<div[^>]*class="?gmail_(quote|extra)[\s\S]*$/i, ' ')
         .replace(/<style[\s\S]*?<\/style>/gi, ' ')
         .replace(/<[^>]+>/g, ' ')
         .replace(/&nbsp;|&zwnj;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  }
  // Cut at the first quoted-history header (no length cap on "On … wrote:", which can be long on mobile).
  const cut = [/On .{0,300}?wrote:/i, /-----\s*Original Message/i, /________________________________/, /\r?\nFrom:\s.+\r?\nSent:/i, /\n\s*>{1,}/];
  for (const re of cut) { const i = s.search(re); if (i > 0) s = s.slice(0, i); }
  return s.split(/\r?\n/).filter(l => !/^\s*>/.test(l)).join('\n').replace(/[ \t]+/g, ' ').trim();
}

// Pull a delivery date (and time window, if given) out of a vendor's reply. Prefers a future date;
// returns { date:'YYYY-MM-DD', window:'human text' } or null when nothing clear is found.
function extractDeliveryDate(text, todayISO) {
  const clean = stripQuotedReply(text);
  if (!clean) return null;
  try {
    const ref = new Date(todayISO + 'T12:00:00');
    const results = chrono.parse(clean, ref, { forwardDate: true });
    if (!results.length) return null;
    const todayStart = new Date(todayISO + 'T00:00:00');
    const pick = results.find(r => r.start && r.start.date() >= todayStart) || results[0];
    const d = pick.start.date();
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    let window = chatDate(iso);
    if (pick.start.isCertain('hour')) {
      const end = pick.end && pick.end.isCertain('hour') ? pick.end.date() : null;
      const fmt = x => x.toLocaleTimeString('en-US', { hour: 'numeric', minute: x.getMinutes() ? '2-digit' : undefined }).replace(':00', '');
      window += ', ' + fmt(d) + (end ? '–' + fmt(end) : '');
    }
    return { date: iso, window };
  } catch (e) { return null; }
}

// For each delivery-request thread awaiting the vendor's date: read their latest reply, parse the
// date, and create the initial delivery notice (pre-filled) for Logan to review. Unparseable replies
// stay "awaiting" so he can enter the date by hand. Runs on the same cadence as the reply check.
async function processDeliveryReplies() {
  if (!useGmail) return;
  try {
    const todayLA = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const { rows } = await pool.query(
      "SELECT id, project_id, gmail_thread_id, subject, supplier_email, item_codes, item_code FROM vendor_emails WHERE awaiting_delivery_date=true AND notice_created=false AND gmail_thread_id IS NOT NULL");
    for (const r of rows) {
      try {
        const ids = new Set([r.gmail_thread_id]);
        (await relatedThreadIds(r.subject, r.supplier_email)).forEach(id => ids.add(id));
        let inbound = [];
        for (const id of ids) { try { inbound.push(...(await fetchThread(id)).filter(m => !m.fromMe)); } catch (e) {} }
        if (!inbound.length) continue;
        inbound.sort((a, b) => new Date(b.date) - new Date(a.date));
        const found = extractDeliveryDate(inbound[0].body || '', todayLA);
        if (!found) continue;   // leave awaiting — Logan can enter the date by hand
        const codes = String(r.item_codes || r.item_code || '').split(',').map(c => c.trim()).filter(Boolean);
        if (!codes.length) { await pool.query('UPDATE vendor_emails SET awaiting_delivery_date=false WHERE id=$1', [r.id]); continue; }
        const q = await enqueueDeliveryNotice({ projectId: r.project_id, codes, window: found.window || chatDate(found.date), method: 'truck', source: 'email', sourceDate: found.date, vendorEmailId: r.id });
        if (q && q.ok) {
          // Board delivery_date is written only when Logan APPROVES the notice, not on this parse,
          // so a wrong-parse he rejects never corrupts the project's real date.
          await pool.query('UPDATE vendor_emails SET notice_created=true, awaiting_delivery_date=false WHERE id=$1', [r.id]);
          console.log('delivery reply parsed → notice queued (project ' + r.project_id + ', ' + codes.join(',') + ', ' + found.date + ')');
        }
      } catch (e) { console.error('processDeliveryReplies item:', e.message); }
    }
  } catch (e) { console.error('processDeliveryReplies:', e.message); }
}

// Pull subcontractor REPLIES into each sub's email log + flag an unread badge.
// Mirrors checkUnreadThreads (the supplier version): for every email we sent a sub,
// fetch its Gmail thread, store any inbound messages we haven't logged yet, and mark
// the sub as having an unread reply if a reply arrived after they last viewed the log.
async function checkSubReplies() {
  if (!useGmail) return;
  try {
    // Backfill thread ids for sends made before reply-linking existed (match by subject + sub email).
    const { rows: noThread } = await pool.query(
      "SELECT id, subject, to_email FROM sub_emails WHERE direction='out' AND gmail_thread_id IS NULL AND to_email IS NOT NULL");
    for (const r of noThread) {
      try {
        const tids = await relatedThreadIds(r.subject, r.to_email);
        if (tids.length) await pool.query('UPDATE sub_emails SET gmail_thread_id=$1 WHERE id=$2', [tids[0], r.id]);
      } catch (e) { /* skip */ }
    }
    const { rows } = await pool.query(
      "SELECT DISTINCT sub_id, gmail_thread_id, subject, to_email FROM sub_emails WHERE direction='out' AND gmail_thread_id IS NOT NULL");
    for (const r of rows) {
      try {
        // Subs sometimes reply in a split-off thread (same subject + their address).
        const ids = new Set([r.gmail_thread_id]);
        (await relatedThreadIds(r.subject, r.to_email)).forEach(id => ids.add(id));
        const inbound = [];
        for (const id of ids) { try { inbound.push(...(await fetchThread(id)).filter(m => !m.fromMe)); } catch (e) { /* skip */ } }
        if (!inbound.length) continue;
        for (const m of inbound) {
          // Real files the sub attached. Keep PDFs/docs even when flagged "inline" (a
          // contractor license or COI frequently arrives inline); only drop inline IMAGES,
          // which are signature logos / mail-icons, not documents.
          // Keep every real file; drop only TINY inline images (signature logos).
          // Large inline images are usually photos the sub pasted into the email.
          const atts = (m.attachments || []).filter(a => a.filename && !(a.inline && /^image\//i.test(a.mimeType || '') && (a.size || 0) < 15000));
          const { rows: ex } = await pool.query('SELECT id FROM sub_emails WHERE gmail_message_id=$1 LIMIT 1', [m.id]);
          if (ex.length) {
            // Already logged — backfill its attachments if we missed them (e.g. reply
            // predates attachment capture, or the old over-eager inline filter dropped them).
            if (atts.length) {
              const { rows: [ac] } = await pool.query('SELECT count(*)::int AS n FROM sub_email_attachments WHERE sub_email_id=$1', [ex[0].id]);
              if (ac.n === 0) {
                for (const a of atts) {
                  await pool.query(
                    "INSERT INTO sub_email_attachments (sub_email_id, filename, mime, size, gmail_message_id, gmail_attachment_id) VALUES ($1,$2,$3,$4,$5,$6)",
                    [ex[0].id, a.filename, a.mimeType || null, a.size || null, m.id, a.attachmentId]);
                }
              }
            }
            continue;
          }
          const raw = (!m.isHtml && m.body) ? stripQuotedPlain(m.body, false) : (m.snippet || '');
          const text = raw.length > 2000 ? raw.slice(0, 2000) + '…' : raw;
          const when = isNaN(new Date(m.date).getTime()) ? new Date() : new Date(m.date);
          const { rows: [ins] } = await pool.query(
            "INSERT INTO sub_emails (sub_id, to_email, from_email, subject, body, sent_by, direction, gmail_thread_id, gmail_message_id, created_at) VALUES ($1,$2,$3,$4,$5,'sub','in',$6,$7,$8) RETURNING id",
            [r.sub_id, r.to_email, m.from, m.subject || r.subject, text, r.gmail_thread_id, m.id, when]);
          for (const a of atts) {
            await pool.query(
              "INSERT INTO sub_email_attachments (sub_email_id, filename, mime, size, gmail_message_id, gmail_attachment_id) VALUES ($1,$2,$3,$4,$5,$6)",
              [ins.id, a.filename, a.mimeType || null, a.size || null, m.id, a.attachmentId]);
          }
          // Bid attached? Read it and put it in the pipeline — same as a QuickBooks estimate.
          try { await maybeIngestDirectBid(r.sub_id, m.id, atts, m.subject || r.subject, text, when); }
          catch (e) { console.error('direct bid ingest:', e.message); }
        }
        const latest = new Date(Math.max(...inbound.map(m => new Date(m.date).getTime())));
        const { rows: [sub] } = await pool.query('SELECT replies_viewed_at FROM subcontractors WHERE id=$1', [r.sub_id]);
        const viewed = sub && sub.replies_viewed_at ? new Date(sub.replies_viewed_at) : new Date(0);
        if (latest > viewed) await pool.query('UPDATE subcontractors SET reply_unread=true WHERE id=$1', [r.sub_id]);
      } catch (e) { /* skip individual sub errors */ }
    }
  } catch (e) { console.error('checkSubReplies:', e.message); }
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

// Ferguson labels orders with the material stage as the PO — map it to our item codes
function fergusonPoCodes(po) {
  const p = String(po || '').toLowerCase();
  if (/water\s*heater/.test(p)) return ['2e'];
  if (/appliance/.test(p)) return ['3b'];
  if (/rough/.test(p)) return ['1b'];
  if (/finish|fs\.?\s*plumb/.test(p)) return ['2d'];
  // Shower POs split by install stage (Logan's categorization rules): pan/base/drain
  // go in at rough/setting → 1b; trim/valve kits are finish plumbing → 2d.
  if (/shower\s*(pan|base|floor|drain)/.test(p)) return ['1b'];
  if (/shower/.test(p)) return ['2d'];
  if (/plumb/.test(p)) return ['1b'];
  if (/hood|light/.test(p)) return ['2d'];
  return [];
}

// Plain-text post to the Bids space — the testing ground for all notifications for now.
// (The material delivery chat stays quiet unless Logan explicitly asks for something there.)
async function postBidsText(text, threadKey, force) {
  if (CHAT_PAUSED && !force) return;   // force: an alert Logan always wants (e.g. material requests)
  if (!process.env.BIDS_WEBHOOK_URL) return;
  try {
    let url = process.env.BIDS_WEBHOOK_URL;
    const body = { text };
    if (threadKey) {
      url += (url.includes('?') ? '&' : '?') + 'messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
      body.thread = { threadKey: String(threadKey) };
    }
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });
  } catch (e) { console.error('postBidsText:', e.message); }
}

// ── Master item catalog ─────────────────────────────────────────────────────────
// The Buildoly Master Finish Schedule sheet is the source of truth for every item:
// prod code → model #, stage bucket, supplier, cost. Finish schedules reference these
// prod codes per project; Ferguson emails reference the model #s. This catalog is the
// join between all three. Read-only: we never write to the sheet.
const MASTER_CATALOG_SHEET_ID = '1wSZb3PVq1rrE3PTyraBSUHVp-tYtOHpMaeAOO2l0_40';
function normModel(m) { return String(m || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
// Stable per-item key for manual delivery marks — must match the client's itemKeyFor().
// Prefer the prod code (survives model/name edits on the sheet), then model #, then name.
function itemKeyFor(prodCode, model, name) {
  const pc = String(prodCode || '').trim().toUpperCase();
  if (pc && pc !== 'CUSTOM') return 'PC:' + pc;
  const mn = normModel(model);
  if (mn.length >= 5) return 'MN:' + mn;
  return 'NM:' + String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 60);
}
async function syncMasterCatalog() {
  if (!sheetsClient) throw new Error('Sheets access not configured.');
  const { data } = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: MASTER_CATALOG_SHEET_ID, range: "'Master Finish Catalog'!A1:X963",
  });
  const rows = data.values || [];
  const out = { seen: 0, upserted: 0, skippedNoCat: 0 };
  // Preserve the sheet's structure: "Bath - BA" style majors, "Fixtures"/"Vanity" style subs
  let section = '', subsection = '';
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const prod = String(r[1] || '').trim();
    if (!/^[A-Z]{1,3}-/.test(prod)) {
      const label = String(r[0] || '').trim();
      if (label && !String(r[4] || '').trim() && !/master finish|customer|project address|^#$/i.test(label)) {
        if (/\s-\s[A-Z]{1,4}$/.test(label)) { section = label.slice(0, 80); subsection = ''; }
        else if (label.length <= 60) subsection = label.slice(0, 80);
      }
      continue;
    }
    out.seen++;
    let code = canonicalCodeFromCategory(String(r[2] || '').trim());
    // Same unmistakable-by-name overrides the finish-schedule reader applies
    const nameText = (String(r[0] || '') + ' ' + String(r[4] || '')).toLowerCase();
    if (/water heater|wtr htr|tankless/.test(nameText)) code = '2e';
    if (/shower door|shower glass|shower enclosure/.test(nameText)) code = '3e';
    if (!code) { out.skippedNoCat++; continue; }
    const model = String(r[5] || '').trim();
    const cost = Number(String(r[12] || '').replace(/[^0-9.]/g, '')) || null;
    const qty = parseInt(r[7], 10) || 1;
    const rawUrl = String(r[23] || '').trim();   // column X: product link
    const itemUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl.slice(0, 500) : (rawUrl && /^[\w-]+\.[a-z]{2,}/i.test(rawUrl) ? ('https://' + rawUrl).slice(0, 500) : null);
    await pool.query(
      `INSERT INTO item_catalog (prod_code, item_role, category_code, brand, product_name, model_no, model_norm, finish, qty_default, supplier, cost, section, subsection, sheet_row, item_url, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (prod_code) DO UPDATE SET item_role=$2, category_code=$3, brand=$4, product_name=$5,
         model_no=$6, model_norm=$7, finish=$8, qty_default=$9, supplier=$10, cost=$11, section=$12, subsection=$13, sheet_row=$14, item_url=$15, updated_at=NOW()`,
      [prod.slice(0, 40), String(r[0] || '').trim().slice(0, 120), code, String(r[3] || '').trim().slice(0, 120),
       String(r[4] || '').trim(), model.slice(0, 120), normModel(model).slice(0, 120) || null,
       String(r[6] || '').trim().slice(0, 120), qty, normalizeSupplier(String(r[14] || '').trim()).slice(0, 120), cost,
       section || null, subsection || null, ri + 1, itemUrl]);
    out.upserted++;
  }
  console.log('catalog sync:', JSON.stringify(out));
  return out;
}
app.post('/catalog/sync', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await syncMasterCatalog()) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// ── Per-project item checklist ──────────────────────────────────────────────────
// Expected items = the project's finish schedule (its shopping list), resolved through
// the catalog for buckets/models. Delivered ✓ = the model # appeared in a completed
// Ferguson delivery for this project. Re-synced from the sheet on every view (cached 5 min).
// The DB (project_expected_items) is the store the pages read; the Google Sheet only
// REFRESHES it, at most every 10 min per project. The rewrite happens in ONE transaction
// (a concurrent page load can never catch the list half-rebuilt) and a failed/empty sheet
// read keeps the last good data instead of wiping the list.
const EXP_SYNC_TTL_MS = 10 * 60 * 1000;
const _expSyncAt = new Map();   // `${projectId}|${scheduleUrl}` -> last successful sync ms
async function syncProjectExpected(projectId) {
  const { rows: [proj] } = await pool.query('SELECT id, finish_schedule_url FROM projects WHERE id=$1', [projectId]);
  if (!proj || !proj.finish_schedule_url) return { ok: false, error: 'No finish schedule linked to this project yet.' };
  const syncKey = projectId + '|' + proj.finish_schedule_url;   // URL in the key → changing the sheet re-syncs immediately
  const last = _expSyncAt.get(syncKey);
  if (last && (Date.now() - last) < EXP_SYNC_TTL_MS) return { ok: true, cached: true };
  const values = await fetchScheduleValues(proj.finish_schedule_url);
  const parsed = parseScheduleRows(values).filter(r => r.type === 'item');
  const { rows: cat } = await pool.query('SELECT prod_code, category_code, model_no, model_norm, supplier FROM item_catalog');
  const catBy = {}; cat.forEach(c => { catBy[c.prod_code] = c; });
  const rowsToInsert = [];
  for (const it of parsed) {
    const c = catBy[it.prodCode] || {};
    const supplier = normalizeSupplier(it.supplier || c.supplier || '');
    if (/contractor to proc|not in scope|^n\/a$/i.test(supplier) || /not in scope/i.test(it.prodCode || '')) continue;
    const model = (it.model || c.model_no || '').trim();
    if (!it.prodCode && !model) continue;
    const catCode = canonicalCodeFromCategory(it.category) || c.category_code || null;
    rowsToInsert.push([
      projectId, (it.prodCode || '').slice(0, 40) || null, (it.name || it.product || '').slice(0, 200), catCode,
      model.slice(0, 120), normModel(model).slice(0, 120) || null, parseInt(it.qty, 10) || 1, supplier.slice(0, 120),
    ]);
  }
  if (!rowsToInsert.length) return { ok: false, error: 'Schedule parsed to 0 items — kept the previous sync.' };
  // Atomic swap: delete + batched insert inside one transaction (readers see old rows until commit).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM project_expected_items WHERE project_id=$1', [projectId]);
    const cols = 8;
    const placeholders = rowsToInsert.map((_, r) => '(' + Array.from({ length: cols }, (_, c) => '$' + (r * cols + c + 1)).join(',') + ')').join(',');
    await client.query(
      `INSERT INTO project_expected_items (project_id, prod_code, name, category_code, model_no, model_norm, qty, supplier)
       VALUES ${placeholders}`, rowsToInsert.flat());
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) {}
    throw e;
  } finally {
    client.release();
  }
  _expSyncAt.set(syncKey, Date.now());
  return { ok: true, items: rowsToInsert.length };
}
// Per-item state for one project: ⬜ not seen → 📦 ordered → 🚚 scheduled → ✅ delivered.
// Sources: rep order-confirmation PDFs (ordered), pending Ferguson updates (scheduled),
// completed updates (delivered — the full ordered package counts once its bucket completes).
async function projectItemStates(projectId) {
  const { rows: expected } = await pool.query(
    'SELECT * FROM project_expected_items WHERE project_id=$1 ORDER BY category_code NULLS LAST, prod_code', [projectId]);
  const agg = {};
  if (!expected.length) return { expected, agg };
  // All independent — run in parallel (was 6 sequential DB round-trips).
  const [{ rows: fu }, { rows: ol }, { rows: al }, { rows: mk }, { rows: boardRows }, { rows: oi }] = await Promise.all([
    pool.query('SELECT items, po, kind, auto_done_at, scheduled_for FROM ferguson_updates WHERE project_id=$1', [projectId]),
    pool.query('SELECT model_norm FROM project_order_lines WHERE project_id=$1', [projectId]),
    pool.query("SELECT prod_code, alt_models FROM item_catalog WHERE alt_models IS NOT NULL AND alt_models <> ''"),
    pool.query('SELECT item_key, state, sched_when FROM project_item_marks WHERE project_id=$1', [projectId]),
    pool.query('SELECT item_code, status FROM project_items WHERE project_id=$1', [projectId]),
    pool.query('SELECT item_key FROM project_item_orders WHERE project_id=$1', [projectId]),
  ]);
  const done = fu.filter(f => f.kind === 'delivered' || f.auto_done_at);
  const pend = fu.filter(f => f.kind === 'scheduled' && !f.auto_done_at);
  const deliveredBlob = done.map(f => normModel(f.items || '')).join('|');
  const completedCodes = new Set();
  done.forEach(f => fergusonPoCodes(f.po).forEach(c => completedCodes.add(c)));
  const schedBlob = pend.map(f => normModel(f.items || '')).join('|');
  const schedInfo = {};
  pend.forEach(f => fergusonPoCodes(f.po).forEach(c => { if (!(c in schedInfo)) schedInfo[c] = f.scheduled_for || ''; }));
  const ordered = new Set(ol.map(o => o.model_norm));
  // Alternate model #s: Ferguson substitutes its own SKUs for generic accessories; alt_models
  // on the catalog row lists those equivalents so the item still matches.
  const aliasBy = {};
  al.forEach(r => { aliasBy[r.prod_code.toUpperCase()] = r.alt_models.split(',').map(normModel).filter(x => x.length >= 5); });
  const marks = {};
  mk.forEach(m => marks[m.item_key] = m);
  const boardDelivered = new Set(boardRows.filter(r => r.status === 'Delivered' || r.status === 'Delivered from Inv.').map(r => r.item_code));
  const orderedKeys = new Set(oi.map(r => r.item_key));
  expected.forEach(e => {
    e.key = itemKeyFor(e.prod_code, e.model_no, e.name);
    const mn = e.model_norm && e.model_norm.length >= 5 ? e.model_norm : null;
    const norms = mn ? [mn] : [];
    (aliasBy[(e.prod_code || '').toUpperCase()] || []).forEach(n => { if (!norms.includes(n)) norms.push(n); });
    const onOrder = norms.some(n => ordered.has(n));
    const explicitlyDelivered = norms.some(n => deliveredBlob.includes(n));
    const explicitlyScheduled = norms.some(n => schedBlob.includes(n));
    // Explicit item-level evidence beats bucket inference: an item named on a PENDING
    // delivery is 🚚 even if an earlier parcel already completed the same bucket.
    e.delivered = explicitlyDelivered || (!explicitlyScheduled && onOrder && e.category_code && completedCodes.has(e.category_code));
    e.scheduled = !e.delivered && (explicitlyScheduled || (onOrder && e.category_code && (e.category_code in schedInfo)));
    e.schedWhen = e.scheduled ? (schedInfo[e.category_code] || '') : '';
    e.onOrder = !e.delivered && !e.scheduled && (onOrder || orderedKeys.has(e.key));
    // A manual mark (clicked in the UI) beats automatic evidence — vendors other than
    // Ferguson don't self-confirm, so this is how those items get tracked.
    const m = marks[e.key];
    if (m && m.state) {
      e.manual = true;
      e.delivered = m.state === 'delivered';
      e.scheduled = m.state === 'scheduled';
      e.onOrder = m.state === 'ordered';
      e.schedWhen = e.scheduled ? (m.sched_when || e.schedWhen || '') : '';
    }
    // Board floor: a whole category being Delivered on the main page rolls down to ✅ here
    // (deliveries land as a unit). Ordering is per-item (orderedKeys above), NOT category-wide.
    // Explicit per-item evidence (manual marks, Ferguson) still wins.
    if (!e.manual && e.category_code && boardDelivered.has(e.category_code) && !e.delivered) {
      e.delivered = true; e.scheduled = false; e.onOrder = false; e.fromBoard = true;
    }
    const k = e.category_code || '—';
    const a = agg[k] = agg[k] || { total: 0, delivered: 0, scheduled: 0, ordered: 0 };
    a.total++;
    if (e.delivered) a.delivered++; else if (e.scheduled) a.scheduled++; else if (e.onOrder) a.ordered++;
  });
  return { expected, agg };
}
// Set/clear a manual per-item delivery mark, then return that item's recomputed state
// plus the fresh per-bucket aggregate so the page can update without a reload.
app.post('/projects/:id/item-mark', requireAuth, async (req, res) => {
  try {
    const { key, state, when } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'Missing item key.' });
    if (state && !['ordered', 'scheduled', 'delivered'].includes(state)) return res.status(400).json({ ok: false, error: 'Bad state.' });
    if (!state) {
      await pool.query('DELETE FROM project_item_marks WHERE project_id=$1 AND item_key=$2', [req.params.id, key]);
    } else {
      await pool.query(
        `INSERT INTO project_item_marks (project_id, item_key, state, sched_when) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id, item_key) DO UPDATE SET state=$3, sched_when=$4, marked_at=NOW()`,
        [req.params.id, key, state, when || null]);
    }
    const { expected, agg } = await projectItemStates(req.params.id);
    const e = expected.find(x => x.key === key);
    const st = e
      ? (e.delivered ? { st: 'd', m: e.manual ? 1 : 0 } : e.scheduled ? { st: 's', when: e.schedWhen || '', m: e.manual ? 1 : 0 } : e.onOrder ? { st: 'o', m: e.manual ? 1 : 0 } : null)
      : (state ? { st: state[0], when: when || '', m: 1 } : null);
    // Bridge a hand-typed checklist schedule to the bucket-level board so the Deliveries
    // page and the day-before confirmation pick it up — the same project_items.delivery_date
    // Ferguson sets automatically. Non-Ferguson items (windows, JEDCO, stock, etc.) are
    // scheduled this way. project_items holds one date per category bucket, so within a
    // bucket the most recently scheduled date wins, and a later real Ferguson delivery date
    // supersedes a manual guess — both acceptable, since deliveries are tracked per category.
    if (e && e.category_code) {
      const cat = e.category_code;
      const iso = state === 'scheduled' ? parseLooseDateISO(when) : '';
      if (iso) {
        await pool.query('INSERT INTO project_items (project_id, item_code) VALUES ($1,$2) ON CONFLICT (project_id, item_code) DO NOTHING', [req.params.id, cat]);
        await pool.query(
          `UPDATE project_items SET delivery_date=$1
           WHERE project_id=$2 AND item_code=$3 AND status NOT IN ('Delivered','Delivered from Inv.','N/A')`,
          [iso, req.params.id, cat]);
        await pool.query(
          `UPDATE project_items SET status='Order Placed'
           WHERE project_id=$1 AND item_code=$2 AND status IN ('Not yet placed','RFQ sent')`,
          [req.params.id, cat]);
      } else if (agg[cat] && agg[cat].scheduled === 0) {
        // Left the scheduled state and nothing else in this bucket is scheduled (manual or
        // Ferguson) → drop the board date we may have set, so /deliveries and the day-before
        // confirmation stop showing an item that's no longer scheduled. Never touch a
        // delivered bucket, and never run when Ferguson still has this bucket scheduled.
        await pool.query(
          `UPDATE project_items SET delivery_date=NULL
           WHERE project_id=$1 AND item_code=$2 AND status NOT IN ('Delivered','Delivered from Inv.','N/A')`,
          [req.params.id, cat]);
      }
    }
    // Cascade up: every expected item in the bucket delivered → the bucket itself is
    // Delivered (forward only — never downgrades a pill someone set further along).
    let bucketStatus = null;
    if (e && e.category_code) {
      const c = agg[e.category_code];
      if (c && c.total && c.delivered === c.total) {
        const bumped = await bumpItemsForward(req.params.id, [e.category_code], 'Delivered');
        if (bumped.length) bucketStatus = { code: e.category_code, status: 'Delivered' };
      }
    }
    res.json({ ok: true, st, agg: e && e.category_code ? { code: e.category_code, counts: agg[e.category_code] } : null, bucketStatus });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get('/projects/:id/checklist', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: [proj] } = await pool.query('SELECT id, address, finish_schedule_url FROM projects WHERE id=$1', [req.params.id]);
    if (!proj) return res.status(404).send('Project not found.');
    syncProjectExpected(proj.id).catch(() => {});   // background refresh — don't block on the Sheets API
    const { expected } = await projectItemStates(proj.id);
    res.render('checklist', { proj, expected, syncErr: null });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/catalog', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: items } = await pool.query('SELECT * FROM item_catalog ORDER BY sheet_row NULLS LAST, prod_code');
    res.render('catalog', { items });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ── Ferguson order confirmations ────────────────────────────────────────────────
// Reps email the full order as a PDF ("23712 SINGAPORE ST - PLUMBING.pdf"). The
// delivery alerts only list the bulky items, so the order PDF is the real record of
// what's coming. We parse each PDF, keep every model # that exists in the catalog,
// and match the project by the address in the subject/filename.
async function sweepFergusonOrders() {
  if (!useGmail) return;
  try {
    const { data } = await gmailClient.users.messages.list({
      userId: 'me', maxResults: 20,
      q: 'from:ferguson.com -from:alerts -from:no-reply has:attachment filename:pdf newer_than:30d',
    });
    for (const mm of (data.messages || [])) {
      const { rows: seen } = await pool.query('SELECT 1 FROM ferg_order_seen WHERE gmail_message_id=$1', [mm.id]);
      if (seen.length) continue;
      await pool.query('INSERT INTO ferg_order_seen (gmail_message_id) VALUES ($1) ON CONFLICT DO NOTHING', [mm.id]);
      const { data: full } = await gmailClient.users.messages.get({ userId: 'me', id: mm.id, format: 'full' });
      const H = full.payload.headers || [];
      const hv = n => { const h = H.find(x => x.name.toLowerCase() === n.toLowerCase()); return h ? h.value : ''; };
      const subject = hv('Subject');
      const atts = [];
      (function w(p) { if (!p) return; if (p.filename && p.body && p.body.attachmentId && /\.pdf$/i.test(p.filename)) atts.push({ filename: p.filename, aid: p.body.attachmentId }); (p.parts || []).forEach(w); })(full.payload);
      if (!atts.length) continue;
      const { rows: cat } = await pool.query("SELECT prod_code, model_norm, alt_models, category_code FROM item_catalog WHERE (model_norm IS NOT NULL AND LENGTH(model_norm) >= 5) OR (alt_models IS NOT NULL AND alt_models <> '')");
      for (const a of atts) {
        const proj = await matchBidToProject(a.filename) || await matchBidToProject(subject);
        if (!proj) continue;
        const ab = await gmailClient.users.messages.attachments.get({ userId: 'me', messageId: mm.id, id: a.aid });
        const buf = Buffer.from(String(ab.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const text = await docTextOrOcr(buf, a.filename);
        if (!text || !/ferguson/i.test(text.slice(0, 800))) continue;
        const tn = normModel(text);
        let lines = 0;
        const bucketCodes = new Set();
        for (const c of cat) {
          // Match the catalog model # or any alternate SKU (Ferguson's substitutes for
          // generic accessories). The line stores whichever number the PDF actually used.
          const norms = [];
          if (c.model_norm && c.model_norm.length >= 5) norms.push(c.model_norm);
          String(c.alt_models || '').split(',').map(normModel).filter(x => x.length >= 5).forEach(n => { if (!norms.includes(n)) norms.push(n); });
          const hit = norms.find(n => tn.includes(n));
          if (!hit) continue;
          if (c.category_code) bucketCodes.add(c.category_code);
          const { rows: [dup] } = await pool.query('SELECT 1 FROM project_order_lines WHERE project_id=$1 AND model_norm=$2 LIMIT 1', [proj.id, hit]);
          if (dup) continue;
          await pool.query('INSERT INTO project_order_lines (project_id, model_norm, prod_code, filename, gmail_message_id) VALUES ($1,$2,$3,$4,$5)',
            [proj.id, hit, c.prod_code, a.filename.slice(0, 255), mm.id]);
          lines++;
        }
        if (lines) {
          console.log('ferguson order swept: ' + proj.address + ' | ' + a.filename + ' | ' + lines + ' items');
          // A confirmed order means those buckets are at least "Order Placed" — advance the
          // Materials pills and stamp the order date so nobody has to do it by hand.
          const codes = [...bucketCodes];
          if (codes.length) {
            const bumped = await bumpItemsForward(proj.id, codes, 'Order Placed');
            const emailDate = new Date(hv('Date'));
            await pool.query('UPDATE project_items SET order_date=COALESCE(order_date, $3) WHERE project_id=$1 AND item_code = ANY($2)',
              [proj.id, codes, isNaN(emailDate) ? new Date() : emailDate]);
            if (bumped.length) console.log('ferguson order: ' + proj.address + ' → Order Placed: ' + bumped.map(b => b.code).join(', '));
          }
        }
      }
    }
  } catch (e) { console.error('sweepFergusonOrders:', e.message); }
}

// ── Branded delivery-notice email to the on-site party ──────────────────────────
// Strip manufacturer/brand tokens out of a description so the GC/super sees the item
// type without our proprietary sourcing (brand + model stay internal).
const BRAND_TOKENS = ['GE', 'Café', 'Cafe', 'LG', 'Kohler', 'Milgard', 'Nest', 'Google', 'Badger', 'InSinkErator', 'Kwikset', 'Moen', 'Delta', 'Panasonic', 'Broan', 'Samsung', 'Whirlpool', 'Bosch', 'Frigidaire', 'Amerfit', 'Elkay', 'Milwaukee', 'Rite-Temp', 'Purist', 'Trinsic', 'Elate', 'Crue'];
function stripBrands(s) {
  let t = String(s || '').replace(/[®™©]/g, '');
  BRAND_TOKENS.forEach(b => { t = t.replace(new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\s*', 'gi'), ''); });
  return t.replace(/\s{2,}/g, ' ').replace(/^[\s,\-–—]+/, '').trim();
}
function deliveryNoticeEmail({ contactName, jobName, stage, supplier, groups, window, method, tracking }) {
  const isUps = String(method || '').toLowerCase() === 'ups';
  const methodText = isUps ? 'UPS Parcel' : 'Delivery Truck';
  const trackUrl = tracking ? 'https://www.ups.com/track?loc=en_US&requester=ST&tracknum=' + encodeURIComponent(tracking) : '';
  // Short "Mon, Jul 6" for the subject line, parsed from the window text.
  const shortWhen = (() => {
    const w = String(window || '');
    const m = w.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+([A-Z][a-z]+)\s+(\d{1,2})/);
    if (m) return m[1] + ', ' + m[2].slice(0, 3) + ' ' + m[3];
    if (/today/i.test(w)) return 'Today';
    return '';
  })();
  const subject = `Delivery Update — ${jobName}` + (shortWhen ? ` · Arriving ${shortWhen}` : (isUps ? ' · Shipping via UPS' : ''));
  // Inbox preview snippet (hidden in the body).
  const preheader = isUps
    ? `${methodText}${tracking ? ' · tracking number enclosed' : ''} · no appointment needed`
    : `${methodText}${window ? ' · ' + window : ''} · someone must be on site to receive it`;
  // Three clean tiers per item: name + qty · maker + model · description + finish.
  const itemRow = it => {
    // Escape each piece first, THEN join with the raw &middot; separator (joining first
    // and escaping after would turn the separator into a literal "&middot;").
    const maker = [it.brand, it.model ? 'Model ' + it.model : ''].filter(Boolean).map(escapeHtml).join(' &middot; ');
    const sub = [it.desc, it.color].filter(Boolean).map(escapeHtml).join(' &middot; ');
    return `<div style="padding:9px 0;border-top:1px solid #f0f1f4">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`
      + `<td style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#111827">${escapeHtml(it.name)}</td>`
      + `<td align="right" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#374151;white-space:nowrap">Qty ${escapeHtml(String(it.qty || '1'))}</td></tr></table>`
      + (maker ? `<div style="font-family:Arial,sans-serif;font-size:12px;font-weight:600;color:#6b7280;margin-top:2px">${maker}</div>` : '')
      + (sub ? `<div style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin-top:1px">${sub}</div>` : '')
      + `</div>`;
  };
  const groupBlock = g => `<div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;color:#2563eb;text-transform:uppercase;margin:14px 0 2px">${escapeHtml(g.label)}</div>${g.items.map(itemRow).join('')}`;
  const intro = isUps
    ? `A material shipment for your project at <strong>${escapeHtml(jobName)}</strong> is on its way via UPS. It does not require an appointment &mdash; <strong>please make sure someone can bring it inside and secure it</strong>.`
    : `A material delivery for your project at <strong>${escapeHtml(jobName)}</strong> is on its way. <strong>Please have someone on site to receive the delivery</strong> during the window below.`;
  const contactBlock = isUps
    ? `<strong style="color:#111827">${escapeHtml(contactName)}, you are the site contact for this shipment.</strong> It is being shipped via UPS and does not require a scheduled appointment. Please ensure the package is received and stored securely on site.${tracking ? ` You can follow its progress using the tracking number below.` : ''}`
    : `<strong style="color:#111827">${escapeHtml(contactName)}, you're listed as the on-site contact</strong> for this delivery. The driver will call you <strong>30&ndash;60 minutes before arrival</strong>, so please keep your phone available.`;
  const html =
`<div style="margin:0;padding:0;background:#f3f4f6">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f3f4f6;opacity:0">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <tr><td bgcolor="#000000" style="background-color:#000000;background:#000000;padding:20px 32px"><img src="https://buildoly.up.railway.app/logo-white.png" alt="buildoly" width="150" style="display:block;width:150px;max-width:150px;height:auto;border:0;color:#ffffff;font-family:Arial,sans-serif;font-size:24px;font-weight:800;letter-spacing:.3px;line-height:36px"></td></tr>
  <tr><td style="padding:30px 32px 4px">
    <div style="font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:#2563eb;text-transform:uppercase">Delivery Update <span style="color:#111827">(${escapeHtml(jobName)})</span></div>
    <p style="font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:1.6;margin:16px 0 0">Hi ${escapeHtml(contactName)},</p>
    <p style="font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:1.6;margin:14px 0 0">${intro}</p>
  </td></tr>
  <tr><td style="padding:18px 32px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eff4ff;border:1px solid #d3e0fd;border-radius:10px"><tr><td style="padding:16px 18px">
    <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;color:#2563eb;text-transform:uppercase">Delivery Method</div>
    <div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#111827;margin-top:4px">${escapeHtml(methodText)}</div>
    ${window ? `<div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;color:#2563eb;text-transform:uppercase;margin-top:12px">${isUps ? 'Estimated Arrival' : 'Delivery Window'}</div><div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;color:#111827;margin-top:4px">${escapeHtml(window)}</div>` : ''}
    ${(isUps && tracking) ? `<div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;color:#2563eb;text-transform:uppercase;margin-top:12px">Tracking Number</div><div style="font-family:Arial,sans-serif;font-size:16px;font-weight:700;margin-top:4px"><a href="${trackUrl}" style="color:#2563eb;text-decoration:none">${escapeHtml(tracking)} &rsaquo;</a></div>` : ''}
  </td></tr></table></td></tr>
  <tr><td style="padding:12px 32px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px"><tr><td style="padding:14px 18px;font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:1.55">
    ${contactBlock}
  </td></tr></table></td></tr>
  <tr><td style="padding:16px 32px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px"><tr><td style="padding:14px 18px 16px">
    <div style="font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#111827">Items being delivered</div>
    <div style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin-bottom:2px">${escapeHtml(stage)}${supplier ? ` &middot; from ${escapeHtml(supplier)}` : ''}</div>
    ${groups.map(groupBlock).join('')}
  </td></tr></table></td></tr>
  <tr><td style="padding:20px 32px 6px">
    <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;color:#2563eb;text-transform:uppercase;border-top:1px solid #eeeeee;padding-top:16px">Please note</div>
    ${isUps ? '' : `<div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.65;color:#6b7280;margin-top:8px"><strong style="color:#374151">Someone must be on site to accept the delivery.</strong> If no one is available to receive it, a redelivery fee may apply. Deliveries must be rescheduled or cancelled a minimum of <strong style="color:#374151">24 hours in advance</strong>.</div>`}
    <div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.65;color:#6b7280;margin-top:10px"><strong style="color:#374151">Please inspect all materials at the time of delivery.</strong> Any damage or shortages must be reported to Buildoly within 24&ndash;48 hours of receipt. Damage reported after this window cannot be verified as delivery-related, and responsibility for that damage will rest with the receiving party.</div>
  </td></tr>
  <tr><td style="padding:16px 32px 4px" align="center"><span style="font-family:Arial,sans-serif;font-size:13px;color:#6b7280">Questions about this delivery? Just reply to this email.</span></td></tr>
  <tr><td style="padding:12px 32px 26px"><p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#6b7280;margin:0"><span style="color:#374151">Thank you,</span><br><strong style="color:#111827">Logan Hauser</strong><br>Buildoly<br><a href="mailto:logan@buildoly.com" style="color:#6b7280;text-decoration:none">logan@buildoly.com</a><br><a href="tel:+12137283041" style="color:#6b7280;text-decoration:none">213-728-3041</a></p></td></tr>
  <tr><td style="background:#f9fafb;border-top:1px solid #eeeeee;padding:14px 32px" align="center"><span style="font-family:Arial,sans-serif;font-size:11px;color:#6b7280">Buildoly &middot; 915 Wilshire Blvd #700, Los Angeles, CA 90017</span></td></tr>
</table></td></tr></table></div>`;
  return { subject, html };
}
// Junk model values on the sheet that aren't real model numbers.
const MODEL_JUNK = /refer to|per plan|see plan|^n\/?a$|^qty|tbd|^\-+$/i;
// Assemble + send the branded notice for a project's delivery of one or more buckets.
// Recipient = the project's assigned super(s) (the on-site party), or toOverride for tests.
// method: 'truck' (freight/appointment) or 'ups' (parcel). Each item advertises its
// maker + model number; the description is cleaned of the brand token to avoid repeating it.
// manifestBlob: normalized model#s actually on THIS shipment (from a Ferguson truck manifest)
//   → the notice lists only those items. exceptBlob: model#s already shipped another way
//   (e.g. by truck) → the notice lists the bucket MINUS those (the UPS half of a split order).
async function buildDeliveryNotice({ projectId, codes, window, toOverride, method, tracking, manifestBlob, exceptBlob }) {
  const { rows: [proj] } = await pool.query(
    'SELECT id, address, full_address, super_email, finish_schedule_url, rec_lighting_source, range_hood_source, jedco_source, bifold_source, sliding_door_source FROM projects WHERE id=$1', [projectId]);
  if (!proj) return { ok: false, reason: 'no project' };
  const sups = parseSuperEmails(proj.super_email);
  const recipients = toOverride ? [toOverride] : sups.map(s => s.email).filter(Boolean);
  if (!recipients.length) return { ok: false, reason: 'no on-site contact assigned (add a super with an email)' };
  // Item detail comes from the project's finish schedule when one is linked. Without a schedule
  // (or for a category the sheet doesn't list), fall back to a category-name-only line so the
  // notice still works — the office confirms specifics on review.
  let byCanon = {};
  if (proj.finish_schedule_url) {
    try {
      const rows = await fetchScheduleValues(proj.finish_schedule_url);
      parseScheduleRows(rows).filter(r => r.type === 'item').forEach(it => {
        const c = canonicalCodeFromCategory(it.category);
        if (c) (byCanon[c] = byCanon[c] || []).push(it);
      });
    } catch (e) { byCanon = {}; }   // unreadable schedule → category-only notice
  }
  const groups = []; let supplierName = '';
  for (const code of codes) {
    let raw = byCanon[code] || [];
    // Split-order handling: match a shipment manifest to schedule items. The model # can
    // live in the model OR color column (data quirk — fans put "FV-0510VSC1" under color),
    // so gather every model-like token (has a digit + a letter, len >= 5) and match any.
    const idTokens = it => [it.model, it.color].map(normModel).filter(t => t.length >= 5 && /\d/.test(t) && /[A-Z]/.test(t));
    if (manifestBlob) raw = raw.filter(it => idTokens(it).some(t => manifestBlob.includes(t)));
    else if (exceptBlob) raw = raw.filter(it => !idTokens(it).some(t => exceptBlob.includes(t)));
    const items = raw.filter(it => !/contractor to proc|not in scope|^n\/a$/i.test(normalizeSupplier(it.supplier || ''))).map(it => {
      const brand = /^generic$/i.test((it.brand || '').trim()) ? '' : (it.brand || '').trim();
      const model = MODEL_JUNK.test(it.model || '') ? '' : (it.model || '').trim();
      let name = (it.name || '').trim();
      let desc = stripBrands(it.product || '');
      // Generic schedule names ("Required Accessory") → use the actual product as the name.
      if (/^(required accessory|w\/d accessory|accessory)$/i.test(name) && desc) { name = desc; desc = ''; }
      return { name, brand, model, desc, color: it.color, qty: it.qty };
    });
    if (items.length) {
      if (!supplierName && raw[0]) supplierName = normalizeSupplier(raw[0].supplier || '');
      groups.push({ label: CODE_NAME[code] || code.toUpperCase(), items });
    } else if (!manifestBlob && !exceptBlob) {
      // No schedule detail for this category (or no schedule at all) — list the category itself.
      groups.push({ label: CODE_NAME[code] || code.toUpperCase(), items: [{ name: CODE_NAME[code] || code.toUpperCase() }] });
    }
  }
  if (!groups.length) return { ok: false, reason: 'no items for ' + codes.join(', ') };
  const contactName = (sups[0] && sups[0].name) || 'there';
  const jobName = shortAddress(proj.full_address || proj.address);
  const { subject, html } = deliveryNoticeEmail({ contactName, jobName, stage: groups.length === 1 ? groups[0].label : 'Materials', supplier: supplierName, groups, window: window || '', method, tracking });
  return { ok: true, subject, html, recipients, jobName, window: window || '', method: method || 'truck', tracking: tracking || null, codes, items: groups.flatMap(g => g.items.map(i => i.name)), groups: groups.map(g => g.label + ' (' + g.items.length + ')') };
}
// Build + send the branded delivery notice, then log the send.
async function sendDeliveryNotice(params) {
  const b = await buildDeliveryNotice(params);
  if (!b.ok) return b;
  await sendMail({ to: b.recipients.join(', '), subject: b.subject, html: b.html });
  try { await pool.query('INSERT INTO delivery_notices (project_id, method, codes, items) VALUES ($1,$2,$3,$4)', [params.projectId, b.method, (params.codes || []).join(','), b.groups.join(', ').slice(0, 200)]); } catch (e) { /* non-fatal */ }
  return { ok: true, to: b.recipients, jobName: b.jobName, window: b.window, method: b.method, tracking: b.tracking, items: b.items, groups: b.groups };
}
// Queue a delivery notice for the office to approve before it emails the on-site contact.
async function enqueueDeliveryNotice({ projectId, codes, window, method, tracking, manifestBlob, exceptBlob, jobName, silent, source, sourceDate, vendorEmailId }) {
  try {
    // Only queue notices that can actually be built + sent (recipient + schedule + items),
    // so the approval queue and its badge don't fill with permanently un-sendable rows.
    const b = await buildDeliveryNotice({ projectId, codes, window, method, tracking, manifestBlob, exceptBlob });
    if (!b.ok) { console.log('delivery notice NOT queued (' + b.reason + ') — project ' + projectId + ' (' + (codes || []).join(',') + ')'); return { ok: false, reason: b.reason }; }
    // Canonical code order so ['1a','1b'] and ['1b','1a'] dedup as the same notice.
    const codesStr = (codes || []).slice().sort().join(',');
    const m = method || 'truck';
    // Dedup: never queue a notice already waiting/sending for the same project+codes+window+method
    // +tracking. 'sent'/'rejected' are intentionally NOT blocked here so a later day (or a manual
    // re-send) can queue again; the daily cron guards its own same-day re-runs. Including tracking
    // lets a genuinely different Ferguson second parcel (distinct tracking) still queue.
    const { rows: dup } = await pool.query(
      "SELECT 1 FROM pending_delivery_notices WHERE project_id=$1 AND codes=$2 AND COALESCE(delivery_window,'')=COALESCE($3,'') AND method=$4 AND COALESCE(tracking,'')=COALESCE($5,'') AND status IN ('pending','sending') LIMIT 1",
      [projectId, codesStr, window || null, m, tracking || null]);
    if (dup.length) { console.log('delivery notice already queued — skipping duplicate (project ' + projectId + ', ' + codesStr + ')'); return { ok: true, queued: false, duplicate: true }; }
    await pool.query(
      `INSERT INTO pending_delivery_notices (project_id, codes, delivery_window, method, tracking, manifest_blob, except_blob, job_name, source, source_date, vendor_email_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [projectId, codesStr, window || null, m, tracking || null, manifestBlob || null, exceptBlob || null, jobName || b.jobName || null, source || 'email', sourceDate || null, vendorEmailId || null]);
    console.log('delivery notice QUEUED for approval — project ' + projectId + ' (' + codesStr + ')');
    // Ping Logan in the private Bids chat so he can preview + approve before it emails the super.
    // The daily cron sends one batched summary instead (silent:true) to avoid a ping per delivery.
    if (!silent) { try { await postNoticeForReview(projectId, jobName || b.jobName, (codes || []).map(c => CODE_NAME[c] || c), m); } catch (e) {} }
    return { ok: true, queued: true };
  } catch (e) { console.error('enqueueDeliveryNotice:', e.message); return { ok: false, reason: e.message }; }
}

// One-off/backfill: queue approval notices for Ferguson deliveries that were scheduled
// but never enqueued (unmapped PO name, bug, downtime). Only future-dated deliveries
// from the last 14 days; anything already in the queue (any status) is left alone.
// Run via /_test/run?key=…&job=requeue-missed-notices
async function requeueMissedNotices() {
  const out = { scanned: 0, queued: 0, skipped: 0, unmapped: [] };
  const todayISO = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    SELECT f.id, f.project_id, f.po, f.scheduled_for, f.items, p.address, p.full_address
    FROM ferguson_updates f JOIN projects p ON p.id = f.project_id
    WHERE f.kind='scheduled' AND f.created_at > NOW() - INTERVAL '14 days'
    ORDER BY f.created_at`);
  for (const r of rows) {
    out.scanned++;
    const dISO = fergusonSchedDateISO(r.scheduled_for);
    if (!dISO || dISO < todayISO) { out.skipped++; continue; }   // past (or unparseable) delivery
    // Manifest match first (schedule categories are authoritative), keyword map as fallback.
    let codes = [];
    if (r.items) {
      const blob = normModel(r.items);
      const { rows: exp } = await pool.query(
        "SELECT DISTINCT category_code, model_norm FROM project_expected_items WHERE project_id=$1 AND category_code IS NOT NULL AND category_code <> '' AND model_norm IS NOT NULL AND LENGTH(model_norm) >= 5", [r.project_id]);
      codes = [...new Set(exp.filter(x => blob.includes(x.model_norm)).map(x => x.category_code))];
    }
    if (!codes.length) codes = fergusonPoCodes(r.po);
    if (!codes.length) { out.unmapped.push(r.po); continue; }
    const codesStr = codes.slice().sort().join(',');
    const { rows: seen } = await pool.query(
      "SELECT 1 FROM pending_delivery_notices WHERE project_id=$1 AND codes=$2 AND COALESCE(delivery_window,'')=COALESCE($3,'') LIMIT 1",
      [r.project_id, codesStr, r.scheduled_for || null]);
    if (seen.length) { out.skipped++; continue; }   // already queued/sent/rejected for this window
    const q = await enqueueDeliveryNotice({ projectId: r.project_id, codes, window: r.scheduled_for, method: 'truck', manifestBlob: normModel(r.items || '') || null, jobName: shortAddress(r.full_address || r.address), source: 'ferguson' });
    if (q.ok && q.queued) out.queued++; else out.skipped++;
  }
  console.log('requeueMissedNotices:', JSON.stringify(out));
  return out;
}

// ── Ferguson delivery tracker ───────────────────────────────────────────────────
// Ferguson's shipping alerts (project44/Convey for UPS parcels, DispatchTrack for
// appliance deliveries) carry the job address, PO (material stage), and schedule.
// Match each to the project by address, log it, and ping the delivery chat —
// threaded per Ferguson order so "out for delivery" and "delivered" stack together.
// The one Delivery Alerts message we agreed on: "Delivery scheduled" → @super → check
// email. Routed to the private Bids chat until DELIVERY_ALERT_LIVE=on flips it to the real
// Delivery Alerts space. Posts directly, bypassing the global CHAT_PAUSED — the one alert.
async function postDeliveryScheduled(projectId, jobName) {
  try {
    const { rows: [proj] } = await pool.query('SELECT address, full_address, super_email FROM projects WHERE id=$1', [projectId]);
    if (!proj) return;
    const name = jobName || shortAddress(proj.full_address || proj.address);
    const mentions = parseSuperEmails(proj.super_email).map(s => s.chatId ? `<users/${s.chatId}>` : (s.name || '')).filter(Boolean).join(' ');
    const text = `🚚 *Delivery scheduled* — *${name}*` + (mentions ? `\n${mentions}` : '') + `\nCheck your email for the delivery details.`;
    const live = String(process.env.DELIVERY_ALERT_LIVE || '').toLowerCase() === 'on';
    const url = live ? CHAT_WEBHOOK_URL : process.env.BIDS_WEBHOOK_URL;
    if (!url) return;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
    console.log('delivery-scheduled alert → ' + (live ? 'delivery-alerts' : 'bids') + ' (project ' + projectId + ')');
  } catch (e) { console.error('postDeliveryScheduled:', e.message); }
}
// Ping Logan (only) in the private Bids chat when a delivery notice is queued for review, so he
// can open it, preview the exact email, and approve before it goes to the on-site contact.
async function postNoticeForReview(projectId, jobName, codeLabels, method) {
  try {
    const url = process.env.BIDS_WEBHOOK_URL;
    if (!url) return;
    const m = method === 'ups' ? '📦 UPS' : '🚚 Truck';
    const cats = (codeLabels || []).filter(Boolean).join(', ');
    const text = `🔔 *Delivery notice ready to review* — *${jobName || 'a project'}*`
      + (cats ? `\n${cats}` : '') + `  ·  ${m}`
      + `\nPreview & approve → https://buildoly.up.railway.app/delivery-notices`;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
    console.log('notice-review ping → bids (project ' + projectId + ')');
  } catch (e) { console.error('postNoticeForReview:', e.message); }
}
// Daily (morning): auto-send the DAY-BEFORE reminder to the on-site contact for every delivery whose
// vendor-CONFIRMED date (source_date, parsed from the reply) is TOMORROW — but ONLY where Logan already
// approved that specific initial notice (source='email', status='sent'). No re-approval: he vetted the
// content once. Consumed via reminded_at; Ferguson/manual notices are excluded (different source).
async function dayBeforeDeliveryReminders() {
  try {
    const todayLA = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const [ty, tm, td] = todayLA.split('-').map(Number);
    const tomorrowLA = new Date(Date.UTC(ty, tm - 1, td) + 86400000).toISOString().slice(0, 10);
    const { rows: inits } = await pool.query(
      "SELECT id, project_id, codes, method, tracking FROM pending_delivery_notices WHERE source='email' AND status='sent' AND reminded_at IS NULL AND source_date = $1 ORDER BY created_at",
      [tomorrowLA]);
    const sent = [];
    const win = 'Arriving tomorrow, ' + chatDate(tomorrowLA);
    const done = new Set();   // project:code already reminded today — never double-send one delivery
    for (const init of inits) {
      const codes = String(init.codes || '').split(',').map(c => c.trim()).filter(c => c && !done.has(init.project_id + ':' + c));
      if (!codes.length) { try { await pool.query("UPDATE pending_delivery_notices SET reminded_at=NOW() WHERE id=$1", [init.id]); } catch (e) {} continue; }
      let dn;
      try { dn = await sendDeliveryNotice({ projectId: init.project_id, codes, window: win, method: init.method || 'truck', tracking: init.tracking || null }); }
      catch (e) { console.error('day-before reminder send (project ' + init.project_id + '):', e.message); continue; }
      if (!dn || !dn.ok) { console.log('day-before reminder NOT sent (' + (dn && dn.reason) + ') — project ' + init.project_id + ' ' + codes.join(',')); continue; }
      codes.forEach(c => done.add(init.project_id + ':' + c));
      try { await pool.query("UPDATE pending_delivery_notices SET reminded_at=NOW() WHERE id=$1", [init.id]); } catch (e) { /* non-fatal */ }
      sent.push({ projectId: init.project_id, codes });
    }
    if (sent.length) await postRemindersSentSummary(sent, tomorrowLA);
    console.log('dayBeforeDeliveryReminders: ' + sent.length + ' reminder(s) auto-sent for ' + tomorrowLA);
  } catch (e) { console.error('dayBeforeDeliveryReminders:', e.message); }
}
// FYI to the private Bids chat noting which day-before reminders auto-sent (visibility only — no
// approval needed since Logan pre-approved the initial notice).
async function postRemindersSentSummary(items, dateISO) {
  try {
    const url = process.env.BIDS_WEBHOOK_URL;
    if (!url || !items.length) return;
    const byProj = {};
    for (const it of items) { const cs = it.codes || [it.code]; (byProj[it.projectId] = byProj[it.projectId] || []).push(...cs.map(c => CODE_NAME[c] || c)); }
    const ids = Object.keys(byProj);
    const { rows } = await pool.query('SELECT id, address, full_address FROM projects WHERE id = ANY($1)', [ids]);
    const nameById = {}; rows.forEach(r => { nameById[r.id] = shortAddress(r.full_address || r.address); });
    const lines = ids.map(id => `• *${nameById[id] || ('Project ' + id)}* — ${[...new Set(byProj[id])].join(', ')}`);
    const text = `📨 *Day-before reminder auto-sent* to the on-site contact (delivery ${chatDate(dateISO)})\n` + lines.join('\n');
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
    console.log('reminders-sent summary → bids (' + items.length + ')');
  } catch (e) { console.error('postRemindersSentSummary:', e.message); }
}
async function pollFergusonEmails() {
  if (!useGmail) return;
  try {
    const q = 'from:(project44.com OR getconvey.com OR dispatchtrack.io) newer_than:7d '
      + '(subject:"Your Ferguson shipment has been delivered" OR subject:"Your Ferguson shipment is out for delivery" OR subject:"Delivery and Installation Update for BUILDOLY INC")';
    const { data } = await gmailClient.users.messages.list({ userId: 'me', q, maxResults: 30 });
    const msgs = (data.messages || []).slice().reverse();   // oldest first so threads read in order
    for (const mm of msgs) {
      const { rows: seen } = await pool.query('SELECT 1 FROM ferguson_updates WHERE gmail_message_id=$1', [mm.id]);
      if (seen.length) continue;
      const { data: full } = await gmailClient.users.messages.get({ userId: 'me', id: mm.id, format: 'full' });
      const H = full.payload.headers || [];
      const hv = n => { const h = H.find(x => x.name.toLowerCase() === n.toLowerCase()); return h ? h.value : ''; };
      const subject = hv('Subject');
      const kind = /has been delivered/i.test(subject) ? 'delivered' : /out for delivery/i.test(subject) ? 'out' : /Delivery and Installation Update/i.test(subject) ? 'scheduled' : null;
      if (!kind) continue;
      // Carrier is decided by which Ferguson system sent it — DispatchTrack = freight truck,
      // project44/getconvey = UPS parcel. This is how Ferguson tells us a split order apart.
      const from = hv('From');
      const carrier = /dispatchtrack/i.test(from) ? 'truck' : 'ups';
      const chunks = [];
      (function walk(p) { if (!p) return; if (p.body && p.body.data) chunks.push(Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); (p.parts || []).forEach(walk); })(full.payload);
      const text = chunks.join(' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&zwnj;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
      let orderNo = '', po = '', tracking = '', address = '', schedFor = '', items = '';
      if (kind === 'scheduled') {
        orderNo = (text.match(/Your order\s+([\w_]+)/i) || [])[1] || '';
        po = (text.match(/Customer PO:\s*(.+?)\s+and Job Name/i) || [])[1] || '';
        const jobName = (text.match(/Job Name:\s*(.+?)\s+is scheduled/i) || [])[1] || '';
        schedFor = (text.match(/scheduled for [^.]*? on\s+(.+?[AP]M\s*-\s*[\d:]+\s*[AP]M)/i) || [])[1] || '';
        address = (text.match(/order address as:\s*(.+?)(?:\s+You will receive|\s+Everything look)/i) || [])[1] || jobName;
        items = ((text.match(/Item SKU#?\s*Quantity\s*(.+?)\s*Click below/i) || [])[1] || '').slice(0, 400);
      } else {
        tracking = (text.match(/Tracking:\s*#?(\w+)/i) || [])[1] || '';
        orderNo = (text.match(/Order Number:\s*(\w+)/i) || [])[1] || '';
        po = (text.match(/PO Number:\s*(.+?)\s+Job Name/i) || [])[1] || '';
        address = (text.match(/Shipping Address:\s*(.+?)(?:\s*,\s*US\b|\s+Delivery Window)/i) || [])[1] || '';
      }
      // The appliance emails use "6488286_571_26", the UPS ones plain "6488304" — the base
      // ties one order's whole lifecycle together (scheduled → out → delivered).
      const orderBase = orderNo.split('_')[0];
      let proj = address ? await matchBidToProject(address) : null;
      // Same order seen before? Inherit its project/PO when this email is missing them, and vice versa.
      if (orderBase) {
        const { rows: [sib] } = await pool.query(
          'SELECT project_id, po FROM ferguson_updates WHERE order_base=$1 AND project_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [orderBase]);
        if (!proj && sib) {
          const { rows: [sp] } = await pool.query('SELECT id, address FROM projects WHERE id=$1', [sib.project_id]);
          if (sp) proj = sp;
        }
        if (!po && sib && sib.po) po = sib.po;
        if (proj) await pool.query('UPDATE ferguson_updates SET project_id=$1 WHERE order_base=$2 AND project_id IS NULL', [proj.id, orderBase]);
      }
      const emailDate = isNaN(new Date(hv('Date')).getTime()) ? new Date() : new Date(hv('Date'));
      // DELIVERED + matched project → push the matching material(s) to Delivered on the board
      let applied = '';
      if (kind === 'delivered' && proj) {
        const codes = fergusonPoCodes(po);
        if (codes.length) {
          const { rows: upd } = await pool.query(
            `UPDATE project_items SET status='Delivered'
             WHERE project_id=$1 AND item_code = ANY($2) AND status NOT IN ('Delivered','Delivered from Inv.','N/A')
             RETURNING item_code`, [proj.id, codes]);
          if (upd.length) applied = upd.map(u => (CODE_NAME[u.item_code] || u.item_code)).join(', ') + ' → Delivered';
        }
      }
      // SCHEDULED + matched project → Ferguson's date becomes the board's delivery date
      if (kind === 'scheduled' && proj) {
        const dISO = fergusonSchedDateISO(schedFor);
        const codes = fergusonPoCodes(po);
        if (dISO && codes.length) {
          const { rows: updD } = await pool.query(
            `UPDATE project_items SET delivery_date = $1,
                    delivery_date_end = CASE WHEN delivery_date_end IS NOT NULL AND delivery_date_end < $1::date THEN NULL ELSE delivery_date_end END
             WHERE project_id = $2 AND item_code = ANY($3)
               AND status NOT IN ('Delivered','Delivered from Inv.','N/A')
               AND (delivery_date IS DISTINCT FROM $1::date)
             RETURNING item_code`, [dISO, proj.id, codes]);
          if (updD.length) {
            const nice = new Date(dISO + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            applied = (applied ? applied + '; ' : '') + updD.map(u => (CODE_NAME[u.item_code] || u.item_code)).join(', ') + ' date → ' + nice;
          }
          // Ferguson booking the delivery means the order is real → advance RFQ sent to Order Placed
          const { rows: updS } = await pool.query(
            `UPDATE project_items SET status='Order Placed'
             WHERE project_id=$1 AND item_code = ANY($2) AND status IN ('Not yet placed','RFQ sent')
             RETURNING item_code`, [proj.id, codes]);
          if (updS.length) applied = (applied ? applied + '; ' : '') + updS.map(u => (CODE_NAME[u.item_code] || u.item_code)).join(', ') + ' → Order Placed';
        }
      }
      await pool.query(
        `INSERT INTO ferguson_updates (gmail_message_id, kind, order_no, order_base, po, tracking, address, project_id, scheduled_for, items, created_at, applied)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (gmail_message_id) DO NOTHING`,
        [mm.id, kind, orderNo.slice(0, 60), orderBase.slice(0, 40) || null, po.slice(0, 120), tracking.slice(0, 60), address.slice(0, 250), proj ? proj.id : null, schedFor.slice(0, 160), items || null, emailDate, applied || null]);
      // Testing phase: notifications go to the BIDS space (per Logan), threaded per order
      const projLabel = proj ? proj.address : (address || 'unmatched address');
      const line = kind === 'delivered'
        ? '✅ *Ferguson DELIVERED* — ' + projLabel + (po ? ' · ' + po : '') + (tracking ? '\nTracking ' + tracking : '') + (applied ? '\n✔ ' + applied + ' on the board' : '')
        : kind === 'out'
        ? '🚚 *Ferguson out for delivery TODAY* — ' + projLabel + (po ? ' · ' + po : '') + (tracking ? '\nTracking ' + tracking : '')
        : '📅 *Ferguson delivery scheduled* — ' + projLabel + (po ? ' · ' + po : '') + '\n' + schedFor + (items ? '\nItems: ' + items.slice(0, 160) + (items.length > 160 ? '…' : '') : '') + (applied ? '\n📌 ' + applied + ' on the board' : '');
      postBidsText(line, orderBase ? 'ferguson-' + orderBase : undefined);   // whole order lifecycle = one chat thread
      console.log('ferguson update: ' + kind + ' → ' + projLabel);
      // Auto-email the on-site party a branded notice, split correctly by carrier.
      // Skips if no super/contact is assigned or there are no matching items.
      if (proj) {
        // Bucket mapping: the manifest is authoritative — match the email's model #s
        // against this project's expected items (synced from the finish schedule) and
        // take THEIR categories. The PO-name keyword map is only the fallback for
        // emails with no parsable manifest. (Highland's "SHOWER TRIM" kit lives under
        // 1b on the schedule — a keyword guess of 2d would build an empty notice.)
        let nCodes = [];
        if (items) {
          try {
            const blob = normModel(items);
            const { rows: exp } = await pool.query(
              "SELECT DISTINCT category_code, model_norm FROM project_expected_items WHERE project_id=$1 AND category_code IS NOT NULL AND category_code <> '' AND model_norm IS NOT NULL AND LENGTH(model_norm) >= 5", [proj.id]);
            nCodes = [...new Set(exp.filter(r => blob.includes(r.model_norm)).map(r => r.category_code))];
            if (nCodes.length) console.log('ferguson PO "' + po + '" mapped via manifest → ' + nCodes.join(','));
          } catch (e) { /* fall back to the keyword map */ }
        }
        if (!nCodes.length) nCodes = fergusonPoCodes(po);
        // Still unmapped on a real scheduled delivery → say so in chat instead of
        // silently skipping the notice (this is how Highland's SHOWER TRIM got missed).
        // force=true: this must land even while CHAT_PAUSED is on — a delivery is coming
        // and the site got no heads-up, same always-deliver class as material requests.
        if (kind === 'scheduled' && !nCodes.length) {
          postBidsText('⚠ Ferguson PO "' + (po || '?') + '" didn\'t match any material bucket — NO delivery notice was queued for ' + projLabel + '. Queue one from the project page if the site needs a heads-up.', orderBase ? 'ferguson-' + orderBase : undefined, true);
        }
        try {
          if (kind === 'scheduled' && nCodes.length) {
            // Freight truck: list ONLY the items on this truck's manifest. Queue for approval.
            await enqueueDeliveryNotice({ projectId: proj.id, codes: nCodes, window: schedFor, method: 'truck', manifestBlob: normModel(items) || null, jobName: shortAddress(proj.full_address || proj.address), source: 'ferguson' });
          } else if (kind === 'out' && carrier === 'ups' && nCodes.length) {
            // UPS parcel: no manifest in the email, so list the bucket MINUS whatever
            // already shipped by truck for this PO — that's the UPS half of a split order.
            const { rows: trucked } = await pool.query(
              "SELECT items FROM ferguson_updates WHERE project_id=$1 AND kind='scheduled' AND po=$2 AND items IS NOT NULL", [proj.id, po]);
            const exceptBlob = trucked.map(r => normModel(r.items || '')).join('|');
            await enqueueDeliveryNotice({ projectId: proj.id, codes: nCodes, window: 'Arriving today', method: 'ups', tracking, exceptBlob: exceptBlob || null, jobName: shortAddress(proj.full_address || proj.address), source: 'ferguson' });
          }
        } catch (e) { console.error('delivery notice:', e.message); }
      }
    }
  } catch (e) { console.error('pollFergusonEmails:', e.message); }
}

// Appliance deliveries don't send a "delivered" confirmation — the scheduled window IS
// the signal. Once the window end (+2h grace, Pacific time) passes, mark it delivered
// and flip the board items, same as a UPS confirmation would.
const FERG_MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
function fergusonWindowEndUtc(schedFor) {
  const m = String(schedFor || '').match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\w*,?\s+(\d{4}).*?-\s*(\d{1,2}):(\d{2})\s*([AP])M/i);
  if (!m) return null;
  let hh = Number(m[4]) % 12;
  if (/p/i.test(m[6])) hh += 12;
  return new Date(Date.UTC(Number(m[3]), FERG_MONTHS[m[1].toLowerCase()], Number(m[2]), hh + 8, Number(m[5])));   // PT → UTC (+8 covers PST; PDT lands an hour late, inside the grace)
}
// "Monday, July 6th 2026 between …" → 2026-07-06 (for the board's delivery_date)
function fergusonSchedDateISO(schedFor) {
  const m = String(schedFor || '').match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\w*,?\s+(\d{4})/i);
  if (!m) return null;
  return m[3] + '-' + String(FERG_MONTHS[m[1].toLowerCase()] + 1).padStart(2, '0') + '-' + String(Number(m[2])).padStart(2, '0');
}
// Lenient parse for a hand-typed checklist schedule date. Accepts "2026-07-12",
// "7/12", "07/12/2026", "Jul 12", "July 12th 2026". Returns 'YYYY-MM-DD' or ''
// when the text isn't a date (so a free-text note like "confirm w/ GC" is ignored).
// A bare month/day assumes the current year, rolling to next year if that date is
// already well in the past.
function parseLooseDateISO(s) {
  s = String(s || '').trim();
  if (!s) return '';
  const pad = n => String(n).padStart(2, '0');
  const roll = (y, mo, d) => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    if (!y) { y = new Date().getFullYear(); const cand = new Date(y, mo - 1, d); if ((new Date() - cand) > 40 * 864e5) y += 1; }
    else if (y < 100) y += 2000;
    return `${y}-${pad(mo)}-${pad(d)}`;
  };
  let m;
  if (m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)) return roll(+m[1], +m[2], +m[3]);
  if (m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/)) return roll(m[3] ? +m[3] : 0, +m[1], +m[2]);
  if (m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/)) {
    const pre = m[1].toLowerCase().slice(0, 3);
    let moIdx;
    for (const name in FERG_MONTHS) { if (name.startsWith(pre)) { moIdx = FERG_MONTHS[name]; break; } }
    if (moIdx !== undefined) return roll(m[3] ? +m[3] : 0, moIdx + 1, +m[2]);
  }
  return '';
}
async function fergusonAutoComplete() {
  try {
    const { rows } = await pool.query(`
      SELECT f.*, p.address AS project_address FROM ferguson_updates f
      LEFT JOIN projects p ON p.id = f.project_id
      WHERE f.kind = 'scheduled' AND f.auto_done_at IS NULL AND f.scheduled_for IS NOT NULL`);
    for (const f of rows) {
      const end = fergusonWindowEndUtc(f.scheduled_for);
      if (!end || Date.now() < end.getTime() + 2 * 3600 * 1000) continue;   // window not over yet
      // A real "delivered" email for the same order already handled it → close quietly
      let sibling = false;
      if (f.order_base) {
        const { rows: [sib] } = await pool.query("SELECT 1 FROM ferguson_updates WHERE order_base=$1 AND kind='delivered' LIMIT 1", [f.order_base]);
        sibling = !!sib;
      }
      let applied = '';
      if (!sibling && f.project_id) {
        const codes = fergusonPoCodes(f.po);
        if (codes.length) {
          const { rows: upd } = await pool.query(
            `UPDATE project_items SET status='Delivered'
             WHERE project_id=$1 AND item_code = ANY($2) AND status NOT IN ('Delivered','Delivered from Inv.','N/A')
             RETURNING item_code`, [f.project_id, codes]);
          if (upd.length) applied = upd.map(u => (CODE_NAME[u.item_code] || u.item_code)).join(', ') + ' → Delivered';
        }
      }
      await pool.query('UPDATE ferguson_updates SET auto_done_at=NOW(), applied=COALESCE(applied, $1) WHERE id=$2', [applied || null, f.id]);
      if (!sibling) {
        const label = f.project_address || f.address || 'unmatched address';
        postBidsText('✅ *Ferguson delivery window passed — marked DELIVERED* — ' + label + (f.po ? ' · ' + f.po : '') + (applied ? '\n✔ ' + applied + ' on the board' : ''),
          f.order_base ? 'ferguson-' + f.order_base : undefined);
      }
      console.log('ferguson auto-complete: ' + (f.project_address || f.address) + ' | ' + (f.po || '') + (applied ? ' | ' + applied : ''));
    }
  } catch (e) { console.error('fergusonAutoComplete:', e.message); }
}

// Day-before delivery confirmations: for everything due tomorrow, email the vendor
// inside the existing RFQ/order thread asking them to confirm. Never sends twice for
// the same item+date. Runs from the button on Deliveries (and daily if AUTO_DELIVERY_CONFIRM=on).
async function sendDeliveryConfirmations() {
  const out = { due: 0, sent: 0, alreadySent: 0, noThread: 0 };
  if (!useGmail) return out;
  try {
    const { rows } = await pool.query(`
      SELECT pi.id, pi.project_id, pi.item_code, pi.delivery_date, p.address
      FROM project_items pi JOIN projects p ON p.id = pi.project_id
      WHERE pi.delivery_date = CURRENT_DATE + 1
        AND pi.status NOT IN ('Delivered','Delivered from Inv.','N/A')`);
    out.due = rows.length;
    for (const r of rows) {
      const { rows: [done] } = await pool.query('SELECT 1 FROM delivery_confirms WHERE project_item_id=$1 AND delivery_date=$2', [r.id, r.delivery_date]);
      if (done) { out.alreadySent++; continue; }
      const { rows: [ve] } = await pool.query(
        `SELECT supplier_name, supplier_email, gmail_thread_id FROM vendor_emails
         WHERE project_id=$1 AND gmail_thread_id IS NOT NULL
           AND (item_code=$2 OR (',' || REPLACE(COALESCE(item_codes,''),' ','') || ',') LIKE ('%,' || $2 || ',%'))
         ORDER BY sent_at DESC LIMIT 1`, [r.project_id, r.item_code]);
      if (!ve || !ve.supplier_email) { out.noThread++; continue; }
      const material = (typeof ITEM_NAME !== 'undefined' && ITEM_NAME[r.item_code]) || r.item_code;
      const dateStr = new Date(r.delivery_date).toLocaleDateString('en-US', { weekday: 'long', month: 'numeric', day: 'numeric' });
      const body = 'Hi ' + (ve.supplier_name || 'there') + ',\n\n'
        + 'Just confirming tomorrow’s delivery (' + dateStr + '):\n\n'
        + '• ' + material + '\n• Deliver to: ' + r.address + '\n\n'
        + '**Please reply to confirm it’s on track (or flag any changes to the ETA).** Thank you!';
      let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${emailBodyHtml(body)}</div>`;
      const sig = await getGmailSignature();
      if (sig) html += `<br><br>${sig}`;
      await sendMail({ to: ve.supplier_email, subject: 'Confirming tomorrow’s delivery — ' + material + ' to ' + r.address, html, threadId: ve.gmail_thread_id });
      await pool.query('INSERT INTO delivery_confirms (project_item_id, delivery_date, supplier_email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.id, r.delivery_date, ve.supplier_email]);
      out.sent++;
    }
    console.log('delivery confirmations:', JSON.stringify(out));
  } catch (e) { console.error('sendDeliveryConfirmations:', e.message); }
  return out;
}

// ── Bounce watcher ──────────────────────────────────────────────────────────────
// When an email we sent comes back "failed to deliver" (Mail Delivery Subsystem),
// flag the matching sub's address with a red warning on the Subs page. No chat post —
// the warning lives where the fix happens. Saving a new email clears it.
async function pollEmailBounces() {
  if (!useGmail) return;
  try {
    const { data } = await gmailClient.users.messages.list({
      userId: 'me', maxResults: 20,
      q: 'from:(mailer-daemon OR postmaster) newer_than:3d',
    });
    for (const mm of (data.messages || [])) {
      const { rows: seen } = await pool.query('SELECT 1 FROM email_bounces WHERE gmail_message_id=$1', [mm.id]);
      if (seen.length) continue;
      const { data: full } = await gmailClient.users.messages.get({ userId: 'me', id: mm.id, format: 'full' });
      const H = full.payload.headers || [];
      const hv = n => { const h = H.find(x => x.name.toLowerCase() === n.toLowerCase()); return h ? h.value : ''; };
      const chunks = [];
      (function walk(p) { if (!p) return; if (p.body && p.body.data) chunks.push(Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); (p.parts || []).forEach(walk); })(full.payload);
      const text = chunks.join(' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const failed = (hv('X-Failed-Recipients')
        || (text.match(/(?:wasn't|was not|couldn't be|could not be) delivered to\s+([\w.+-]+@[\w.-]+\.\w+)/i) || [])[1]
        || (text.match(/([\w.+-]+@[\w.-]+\.\w+)\s+because the address/i) || [])[1]
        || '').trim().replace(/[>,;]+$/, '');
      // The bounce lands in the same thread as the original send — pull its subject.
      let origSubject = '';
      try {
        const { data: th } = await gmailClient.users.threads.get({ userId: 'me', id: full.threadId, format: 'metadata', metadataHeaders: ['Subject'] });
        const fp = ((th.messages || [])[0] || {}).payload;
        const sh = ((fp && fp.headers) || []).find(x => x.name.toLowerCase() === 'subject');
        origSubject = sh ? sh.value : '';
      } catch (e) { /* subject is a nice-to-have */ }
      let subId = null;
      if (failed) {
        const { rows: [sub] } = await pool.query('SELECT id FROM subcontractors WHERE LOWER(email)=LOWER($1) LIMIT 1', [failed]);
        if (sub) {
          subId = sub.id;
          await pool.query('UPDATE subcontractors SET email_bounced_at=NOW(), email_bounce_note=$2 WHERE id=$1',
            [sub.id, (origSubject || '').slice(0, 200) || null]);
          console.log('email bounce: flagged sub #' + sub.id + ' (' + failed + ')');
        }
      }
      await pool.query('INSERT INTO email_bounces (gmail_message_id, recipient, orig_subject, sub_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [mm.id, failed || null, (origSubject || '').slice(0, 300) || null, subId]);
    }
  } catch (e) { console.error('pollEmailBounces:', e.message); }
}

// ── Morning brief ───────────────────────────────────────────────────────────────
// One 7am message to the Bids space that ties every system together: today's trucks
// (with supers), the next few days, what the Order Planner says to order now, bids
// sitting on a decision, and insurance about to lapse. Skips empty sections; posts
// nothing at all on a quiet day.
async function sendMorningBrief() {
  try {
    const lines = [];
    const { rows: del } = await pool.query(`
      SELECT p.address, p.super_email, pi.item_code, pi.delivery_date
      FROM project_items pi JOIN projects p ON p.id = pi.project_id
      WHERE p.phase IN ('Pre-Construction','Under Construction')
        AND pi.status NOT IN ('Delivered','Delivered from Inv.','N/A')
        AND pi.delivery_date IS NOT NULL
        AND pi.delivery_date <= CURRENT_DATE + INTERVAL '3 days'
        AND COALESCE(pi.delivery_date_end, pi.delivery_date) >= CURRENT_DATE
      ORDER BY pi.delivery_date`);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const fmt = d => new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const short = a => String(a || '').split(',')[0];
    const todays = del.filter(r => new Date(r.delivery_date) <= today);
    const soon = del.filter(r => new Date(r.delivery_date) > today);
    if (todays.length) {
      lines.push('🚚 *Arriving today:*');
      const by = {};
      todays.forEach(r => { (by[r.address] = by[r.address] || { sups: parseSuperEmails(r.super_email), items: [] }).items.push(ITEM_NAME[r.item_code] || r.item_code); });
      Object.keys(by).forEach(a => {
        const g = by[a];
        lines.push('   • ' + short(a) + ' — ' + g.items.join(', ') + (g.sups.length ? '  (super: ' + g.sups.map(s => s.name).join(', ') + ')' : '  ⚠ no super assigned'));
      });
    }
    if (soon.length) lines.push('📅 *Next 3 days:* ' + soon.map(r => short(r.address) + ' — ' + (ITEM_NAME[r.item_code] || r.item_code) + ' ' + fmt(r.delivery_date)).join(' · '));
    // What the Order Planner says should be ordered within a week (same rules as /ordering)
    const { rows: ruleRows } = await pool.query('SELECT * FROM order_rules');
    const ruleMap = {}; ruleRows.forEach(r => ruleMap[r.item_code] = r);
    const { rows: projs } = await pool.query(`SELECT id, address, phase_dates FROM projects WHERE phase IN ('Pre-Construction','Under Construction')`);
    const ids = projs.map(p => p.id);
    let items = [];
    if (ids.length) ({ rows: items } = await pool.query('SELECT project_id, item_code, status FROM project_items WHERE project_id = ANY($1)', [ids]));
    const im = {}; items.forEach(i => { (im[i.project_id] = im[i.project_id] || {})[i.item_code] = i.status; });
    const due = [];
    for (const p of projs) {
      const pd = p.phase_dates || {};
      for (const it of ALL_ITEMS) {
        const rule = ruleMap[it.code]; if (!rule) continue;
        const st = (im[p.id] && im[p.id][it.code]) || 'Not yet placed';
        if (st === 'N/A' || (STATUS_RANK[st] ?? 0) >= STATUS_RANK['Order Placed']) continue;
        const aDate = pd[rule.anchor === 'precon' ? 'Pre-Construction' : 'Under Construction'];
        if (!aDate) continue;
        const d = new Date(aDate + 'T00:00:00'); d.setDate(d.getDate() + rule.offset_weeks * 7);
        const days = Math.round((d - today) / 86400000);
        if (days <= 7) due.push({ address: p.address, name: it.name, days, rfqOut: st === 'RFQ sent' });
      }
    }
    if (due.length) {
      due.sort((a, b) => a.days - b.days);
      lines.push('🛒 *Order now:* ' + due.slice(0, 8).map(d =>
        short(d.address) + ' — ' + d.name + (d.days < 0 ? ' (overdue ' + (-d.days) + 'd)' : d.days === 0 ? ' (today)' : ' (in ' + d.days + 'd)') + (d.rfqOut ? ' — RFQ out' : '')
      ).join(' · ') + (due.length > 8 ? ' · +' + (due.length - 8) + ' more' : ''));
    }
    const { rows: bids } = await pool.query("SELECT company, owner FROM subcontractors WHERE status ILIKE '%bid under review%'");
    if (bids.length) lines.push('📋 *Bids waiting on a decision (' + bids.length + '):* ' + bids.slice(0, 8).map(b => b.company || b.owner).join(', ') + (bids.length > 8 ? ', …' : ''));
    const { rows: ins } = await pool.query(
      "SELECT company, owner, ins_expires FROM subcontractors WHERE ins_expires IS NOT NULL AND status NOT ILIKE '%reject%' AND status NOT ILIKE '%black%' AND ins_expires <= CURRENT_DATE + INTERVAL '14 days' ORDER BY ins_expires LIMIT 5");
    if (ins.length) lines.push('🛡 *Insurance lapsing ≤14d:* ' + ins.map(s => (s.company || s.owner) + ' (' + new Date(s.ins_expires).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) + ')').join(', '));
    if (!lines.length) return;
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
    await postBidsText('☀️ *Morning brief — ' + dateStr + '*\n' + lines.join('\n'), 'morning-brief');
    console.log('morning brief sent: ' + lines.length + ' lines');
  } catch (e) { console.error('sendMorningBrief:', e.message); }
}

async function sendWeeklyDigest() {
  if (!emailEnabled) return;
  try {
    const { rows: [s] } = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE overall_status='In Progress') AS in_progress,
      COUNT(*) FILTER (WHERE overall_status='Not Yet') AS not_yet,
      COUNT(*) AS total FROM projects`);
    const { rows: deliv } = await pool.query(`SELECT COUNT(*) c FROM project_items WHERE delivery_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND status NOT IN ('Delivered','Delivered from Inv.','N/A')`);
    const { rows: overdue } = await pool.query(`SELECT COUNT(*) c FROM project_items WHERE COALESCE(delivery_date_end, delivery_date) < CURRENT_DATE AND status NOT IN ('Delivered','Delivered from Inv.','N/A')`);
    const { rows: [unr] } = await pool.query(`SELECT COUNT(DISTINCT project_id) c FROM vendor_emails WHERE has_unread=true`);
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
      <h2 style="margin:0 0 10px">Weekly Buildoly Office Digest</h2>
      <ul style="line-height:1.7">
        <li><strong>${s.total}</strong> projects (${s.in_progress} in progress, ${s.not_yet} not started)</li>
        <li><strong>${deliv[0].c}</strong> deliveries due this week${Number(overdue[0].c) ? `, <span style="color:#cc0000"><strong>${overdue[0].c} overdue</strong></span>` : ''}</li>
        <li><strong>${unr.c}</strong> project(s) with unread vendor replies</li>
      </ul>
      <p><a href="https://buildoly.up.railway.app">Open the app →</a></p></div>`;
    await sendMail({ to: NOTIFY_TO, subject: 'Weekly Buildoly Office Digest', html });
    console.log('Weekly digest sent');
  } catch (e) { console.error('sendWeeklyDigest:', e.message); }
}

// A year after a project enters Under Warranty it graduates to Complete on its own.
async function autoCompleteWarranty() {
  try {
    const { rows } = await pool.query(
      `UPDATE projects SET phase='Complete', overall_status='Fully Delivered', updated_at=NOW()
       WHERE phase='Under Warranty' AND warranty_started_at IS NOT NULL AND warranty_started_at < NOW() - INTERVAL '1 year'
       RETURNING address`);
    if (rows.length) console.log('Warranty ended, auto-completed:', rows.map(r => r.address).join(', '));
  } catch (e) { console.error('autoCompleteWarranty:', e.message); }
}

// License Watchdog: weekly re-check of every contractor license against CSLB.
// Chat-alerts any red/amber findings (expired / expiring / suspended / disciplinary).
async function licenseWatchdog() {
  try {
    const { rows } = await pool.query("SELECT id, company, notes, license_number FROM subcontractors WHERE license_number IS NOT NULL AND license_number <> ''");
    const findings = [];
    for (const s of rows) {
      try {
        const r = await verifySubLicense(s);
        if (r.ok) {
          const bad = (r.flags || []).filter(f => f.level === 'red' || f.level === 'amber');
          if (bad.length) findings.push('• *' + (s.company || 'Lic ' + s.license_number) + '* — ' + bad.map(f => f.text).join('; '));
        }
      } catch (e) { /* single-license failure shouldn't kill the run */ }
      await new Promise(r => setTimeout(r, 900));
    }
    if (findings.length) {
      // Recruiting intel lives in the Bids space — the delivery chat stays quiet
      postBidsText(['🛡️ *License Watchdog* — ' + findings.length + ' contractor(s) need attention:', ...findings.slice(0, 15)].join('\n'));
    }
    console.log('licenseWatchdog: checked ' + rows.length + ', flagged ' + findings.length);
  } catch (e) { console.error('licenseWatchdog:', e.message); }
}

// ── Weekly recruiting digest → the Bids chat space ─────────────────────────────
// One short Monday post: coverage gaps vs the 4-per-area minimum, expiring licenses
// and insurance, and the bids that came in during the week.
const COVERAGE_AREAS = ['LA County', 'Orange County', 'Riverside County', 'San Diego County', 'Ventura County', 'San Bernardino County', 'The Valley'];
async function coverageDigest() {
  if (CHAT_PAUSED) return;
  if (!process.env.BIDS_WEBHOOK_URL) return;
  try {
    const COV_MIN = 4;
    const { rows: subs } = await pool.query('SELECT company, type, status, location, category, license_expire, license_flags, ins_expires FROM subcontractors');
    // Coverage counts Active subs only — matching the Coverage matrix on the Subs page
    const usable = subs.filter(s => /^\s*active\s*$/i.test(s.status || '') &&
      !(s.category === 'gc' || (!s.category && /general\s*contractor|^\s*gc\b/i.test(s.type || ''))));
    const lines = [];
    // Coverage vs the minimum
    const short = [];
    let noArea = 0;
    const covLine = COVERAGE_AREAS.map(a => {
      const n = usable.filter(s => String(s.location || '').toLowerCase().includes(a.toLowerCase())).length;
      if (n < COV_MIN) short.push(a + ' has ' + n + ' (need ' + (COV_MIN - n) + ' more)');
      return a.replace(' County', '') + ' ' + n;
    }).join(' · ');
    noArea = usable.filter(s => !String(s.location || '').trim()).length;
    lines.push('📍 *Sub coverage:* ' + covLine);
    if (short.length) lines.push('🚨 Below the ' + COV_MIN + '-sub minimum: ' + short.join('; '));
    if (noArea) lines.push('⚠ ' + noArea + ' subs have no service area set (they count nowhere)');
    // Licenses expiring ≤60d or flagged red
    const now = Date.now();
    const licBad = subs.filter(s => {
      if (/reject|black/i.test(s.status || '')) return false;
      let flags = []; try { flags = JSON.parse(s.license_flags || '[]'); } catch (e) {}
      const expSoon = s.license_expire && (new Date(s.license_expire) - now) / 86400000 <= 60;
      return expSoon || flags.some(f => f.level === 'red');
    }).slice(0, 6);
    if (licBad.length) lines.push('📜 *License attention:* ' + licBad.map(s => s.company).join(', '));
    // Insurance expired / expiring ≤30d
    const insBad = subs.filter(s => !/reject|black/i.test(s.status || '') && s.ins_expires && (new Date(s.ins_expires) - now) / 86400000 <= 30).slice(0, 6);
    if (insBad.length) lines.push('🛡 *Insurance lapsing:* ' + insBad.map(s => s.company + ' (' + new Date(s.ins_expires).toLocaleDateString() + ')').join(', '));
    // Bids this week
    try {
      const { rows: wk } = await pool.query(`
        SELECT b.amount, s.company FROM bids b JOIN subcontractors s ON s.id = b.sub_id
        WHERE b.received_at > NOW() - INTERVAL '7 days' ORDER BY b.received_at DESC`);
      if (wk.length) lines.push('📥 *Bids this week (' + wk.length + '):* ' + wk.slice(0, 6).map(b =>
        b.company + (b.amount != null ? ' $' + Number(b.amount).toLocaleString() : '')).join(', '));
    } catch (e) { /* bids table may be empty/new */ }
    // Bid-out tracker: of everyone we've asked for a bid, who has answered — broken out by trade.
    // "Answered" = their bid came in (Bid Under Review) or they emailed back after our request.
    try {
      const { rows: bidOut } = await pool.query(`
        SELECT s.id, s.company, s.type, s.status,
          (SELECT MAX(created_at) FROM sub_emails e WHERE e.sub_id = s.id AND e.direction = 'out') AS last_out,
          (SELECT MAX(created_at) FROM sub_emails e WHERE e.sub_id = s.id AND e.direction = 'in')  AS last_in
        FROM subcontractors s WHERE s.status IN ('Bid Requested', 'Bid Under Review')`);
      if (bidOut.length) {
        const byTrade = {};
        bidOut.forEach(s => {
          const t = (String(s.type || '').split(',')[0] || '').trim() || 'Other';
          const answered = /bid under review/i.test(s.status || '') || (s.last_in && (!s.last_out || new Date(s.last_in) > new Date(s.last_out)));
          const b = byTrade[t] = byTrade[t] || { asked: 0, answered: 0 };
          b.asked++;
          if (answered) b.answered++;
        });
        const parts = Object.keys(byTrade).sort().map(t => t + ' ' + byTrade[t].answered + '/' + byTrade[t].asked);
        lines.push('🔨 *Bid-outs — responded/asked by trade:* ' + parts.join(' · '));
      }
    } catch (e) { /* keep the digest going */ }
    const base = process.env.APP_URL || 'https://buildoly.up.railway.app';
    const text = ['🧭 *Weekly recruiting digest*', ...lines, base + '/subs'].join('\n');
    await fetch(process.env.BIDS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
    console.log('coverageDigest posted');
  } catch (e) { console.error('coverageDigest:', e.message); }
}

// ── Direct-email bid ingest ─────────────────────────────────────────────────────
// Subs who don't use QuickBooks email their bids as PDFs, Word docs, or scans.
// When the reply-checker logs one, read it: a bid-looking doc with a labeled total
// gets the exact same treatment as a QuickBooks estimate. Conservative on purpose —
// no readable total, or it looks like an insurance cert, and nothing changes.
function normBidAmount(s) {
  s = String(s).replace(/\s/g, '').replace(/[.,]$/, '');
  const m = s.match(/^(\d{1,3}(?:[.,]\d{3})*)(?:[.,](\d{2}))?$/);   // handles 14,000.00 AND 14.000.00
  if (!m) { const n = Number(s.replace(/,/g, '')); return isFinite(n) ? n : null; }
  return Number(m[1].replace(/[.,]/g, '')) + (m[2] ? Number('0.' + m[2]) : 0);
}
function parseBidTotal(text) {
  const t = String(text || '');
  let best = null, m;
  const labeled = /(?:grand\s*total|total[^\n$]{0,60}?|sum\s+of|balance\s+due|amount\s+due)[^0-9$\n]{0,80}\$?\s*([\d][\d.,]*)/gi;
  while ((m = labeled.exec(t))) { const v = normBidAmount(m[1]); if (v && v >= 100 && v <= 5000000 && (best == null || v > best)) best = v; }
  if (best == null) {   // fallback: largest $-prefixed amount in a sane range
    const dollar = /\$\s*([\d][\d.,]*)/g;
    while ((m = dollar.exec(t))) { const v = normBidAmount(m[1]); if (v && v >= 500 && v <= 5000000 && (best == null || v > best)) best = v; }
  }
  return best;
}
const BIDDOC_RE = /bid|proposal|estimate|quote/i;
async function maybeIngestDirectBid(subId, gmailMessageId, atts, subject, bodyText, when) {
  if (!atts || !atts.length || !gmailClient) return;
  const { rows: [dup] } = await pool.query('SELECT id FROM bids WHERE gmail_message_id=$1 LIMIT 1', [gmailMessageId]);
  if (dup) return;
  const cands = atts.filter(a => /\.(pdf|docx?|png|jpe?g)$/i.test(a.filename || '') && !COI_FILE_RE.test(a.filename || '')).slice(0, 3);
  for (const a of cands) {
    const att = await gmailClient.users.messages.attachments.get({ userId: 'me', messageId: gmailMessageId, id: a.attachmentId });
    const buf = Buffer.from(String(att.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const text = await docTextOrOcr(buf, a.filename);
    if (!text || /certificate of liability|acord\b|workers'? comp(?:ensation)? insurance/i.test(text.slice(0, 1500))) continue;
    const bidish = BIDDOC_RE.test(a.filename || '') || BIDDOC_RE.test(String(subject || '')) || BIDDOC_RE.test(text.slice(0, 1200));
    if (!bidish) continue;
    const amount = parseBidTotal(text);
    if (!amount) continue;
    const { rows: [sub] } = await pool.query('SELECT id, company, status, bid_status FROM subcontractors WHERE id=$1', [subId]);
    if (!sub) return;
    const priceStr = '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const newBidStatus = /awarded/i.test(sub.bid_status || '') ? sub.bid_status : 'Bid Received';
    await pool.query('UPDATE subcontractors SET bid_status=$1, bid_price=$2 WHERE id=$3', [newBidStatus, priceStr.slice(0, 40), sub.id]);
    if (!/active|approv|inactive|reject|black|bid under review/i.test(sub.status || '')) {
      await pool.query("UPDATE subcontractors SET status='Bid Under Review', group_label='Bid Under Review' WHERE id=$1", [sub.id]);
    }
    const hint = bidJobHint(subject, text);
    const proj = hint ? await matchBidToProject(hint) : null;
    await pool.query(
      `INSERT INTO bids (sub_id, project_id, amount, estimate_no, subject, job_hint, gmail_message_id, filename, gmail_attachment_id, auto_matched, received_at, seen)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,false)`,
      [sub.id, proj ? proj.id : null, amount, String(subject || '').slice(0, 250), hint, gmailMessageId, a.filename, a.attachmentId, !!proj, when || new Date()]);
    await postBidToBidsSpace(
      '📥 *' + sub.company + '* — *' + priceStr + '*' + (proj ? '\n🏠 ' + proj.address : ''),
      String(subject || '').slice(0, 140),
      [{ filename: a.filename, mime: a.mimeType, aid: a.attachmentId }], gmailMessageId);
    console.log('direct bid ingested: ' + sub.company + ' ' + priceStr + (proj ? ' -> ' + proj.address : ' (no project match)'));
    return true;
  }
  return false;
}
// Post a bid to the Bids chat space — Chat API with the real file attached, webhook links as fallback
async function postBidToBidsSpace(header, subjectLine, docs, messageId) {
  if (CHAT_PAUSED) return;
  if (!(process.env.BIDS_SPACE || process.env.BIDS_WEBHOOK_URL)) return;
  let posted = false;
  if (process.env.BIDS_SPACE && gOauth2) {
    try {
      const space = process.env.BIDS_SPACE;
      const at = (await gOauth2.getAccessToken()).token;
      const refs = [];
      for (const a of (docs || []).slice(0, 3)) {
        const r = await gmailClient.users.messages.attachments.get({ userId: 'me', messageId, id: a.aid });
        const buf = Buffer.from(String(r.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const boundary = 'qbbid' + Math.floor(Math.random() * 1e9);
        const body = Buffer.concat([
          Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ filename: a.filename }) + '\r\n--' + boundary + '\r\nContent-Type: ' + (a.mime || 'application/pdf') + '\r\n\r\n'),
          buf, Buffer.from('\r\n--' + boundary + '--')]);
        const up = await fetch('https://chat.googleapis.com/upload/v1/' + space + '/attachments:upload?uploadType=multipart', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
        const upd = await up.json();
        if (!up.ok) throw new Error('upload HTTP ' + up.status + ': ' + JSON.stringify(upd).slice(0, 120));
        refs.push({ attachmentDataRef: upd.attachmentDataRef });
      }
      const mr = await fetch('https://chat.googleapis.com/v1/' + space + '/messages', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: header + '\n' + subjectLine, attachment: refs }) });
      if (!mr.ok) throw new Error('message HTTP ' + mr.status);
      posted = true;
    } catch (e) { console.error('bids chat api (fallback to webhook):', e.message); }
  }
  if (!posted && process.env.BIDS_WEBHOOK_URL) {
    try {
      const base = process.env.APP_URL || 'https://buildoly.up.railway.app';
      const links = (docs || []).slice(0, 3).map(a => '📄 ' + a.filename + '\n' + base + '/threads/messages/' + messageId + '/attachment/' + a.aid + '?name=' + encodeURIComponent(a.filename) + '&mime=' + encodeURIComponent(a.mime || 'application/pdf'));
      await fetch(process.env.BIDS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text: [header, subjectLine, ...links].join('\n') }) });
    } catch (e) { console.error('bids webhook:', e.message); }
  }
}

// ── Platform-bid sweep ──────────────────────────────────────────────────────────
// Estimating platforms (FieldGroove, JobTread, etc.) send bids from THEIR address in
// a fresh thread, so neither the reply-checker nor the QuickBooks ingester sees them.
// This sweeps recent inbox attachments, matches the SUBJECT/SENDER to a contractor
// already on the list (never creates one), and runs the same bid gauntlet.
async function sweepPlatformBids() {
  if (!useGmail) return;
  try {
    const { data } = await gmailClient.users.messages.list({
      userId: 'me', maxResults: 25,
      q: 'in:inbox has:attachment (filename:pdf OR filename:docx) newer_than:10d -from:intuit.com -from:quickbooks.com -from:buildoly.com',
    });
    const msgs = (data.messages || []).slice().reverse();   // oldest first
    for (const mm of msgs) {
      const { rows: seen } = await pool.query('SELECT 1 FROM qb_seen WHERE gmail_message_id=$1', [mm.id]);
      if (seen.length) continue;
      const { rows: logged } = await pool.query('SELECT 1 FROM sub_emails WHERE gmail_message_id=$1', [mm.id]);
      if (logged.length) { await pool.query('INSERT INTO qb_seen (gmail_message_id) VALUES ($1) ON CONFLICT DO NOTHING', [mm.id]); continue; }
      const { data: full } = await gmailClient.users.messages.get({ userId: 'me', id: mm.id, format: 'full' });
      const H = full.payload.headers || [];
      const hv = n => { const h = H.find(x => x.name.toLowerCase() === n.toLowerCase()); return h ? h.value : ''; };
      const subject = hv('Subject'), from = hv('From');
      await pool.query('INSERT INTO qb_seen (gmail_message_id) VALUES ($1) ON CONFLICT DO NOTHING', [mm.id]);   // processed either way
      // Match ONLY against contractors already on the list — by name in the subject or sender
      const normFull = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const hay = normFull(subject + ' ' + from);
      const { rows: subsAll } = await pool.query("SELECT id, company, owner FROM subcontractors WHERE status !~* 'reject|black'");
      const sub = subsAll.find(s => {
        const k = normFull(s.company);
        if (k.length >= 8 && hay.includes(k)) return true;
        const o = normFull(s.owner);   // one-man shops: match the guy's full name too
        return o.length >= 8 && hay.includes(o);
      });
      if (!sub) continue;
      const atts = [];
      (function wa(p) { if (!p) return; if (p.filename && p.body && p.body.attachmentId) atts.push({ filename: p.filename, mimeType: p.mimeType, size: p.body.size, attachmentId: p.body.attachmentId }); (p.parts || []).forEach(wa); })(full.payload);
      const chunks = [];
      (function walk(p) { if (!p) return; if (p.body && p.body.data && /text\/plain/i.test(p.mimeType || '')) chunks.push(Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); (p.parts || []).forEach(walk); })(full.payload);
      const bodyText = chunks.join('\n').replace(/\s+/g, ' ').trim().slice(0, 1500);
      const when = isNaN(new Date(hv('Date')).getTime()) ? new Date() : new Date(hv('Date'));
      // Gauntlet first — only a genuine bid gets logged under the sub at all
      const ingested = await maybeIngestDirectBid(sub.id, mm.id, atts, subject, bodyText, when);
      if (!ingested) continue;
      const bodyHtml = gmailHtmlFromPayload(full.payload, mm.id) || null;
      const fromEmail = (from.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || ['unknown'])[0].toLowerCase();
      const { rows: [em] } = await pool.query(
        `INSERT INTO sub_emails (sub_id, to_email, from_email, subject, body, body_html, sent_by, direction, gmail_thread_id, gmail_message_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'sub','in',$7,$8,$9) RETURNING id`,
        [sub.id, gmailUser, fromEmail, subject.slice(0, 250), bodyText, bodyHtml, full.threadId, mm.id, when]);
      for (const a of atts) {
        await pool.query('INSERT INTO sub_email_attachments (sub_email_id, filename, mime, size, gmail_message_id, gmail_attachment_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [em.id, a.filename, a.mimeType || null, a.size || null, mm.id, a.attachmentId]);
      }
      await pool.query('UPDATE subcontractors SET reply_unread=true WHERE id=$1', [sub.id]);
      console.log('platform bid swept: ' + sub.company + ' | ' + subject.slice(0, 60));
    }
  } catch (e) { console.error('sweepPlatformBids:', e.message); }
}

// ── Bid → project matching ─────────────────────────────────────────────────────
// Estimates often carry the job address ("840 N Edgemond") that's spelled slightly
// differently from the project ("842 N Edgemont St") — so match on street name
// similarity + house number proximity, not equality.
function parseStreetAddr(s) {
  const m = String(s || '').match(/\b(\d{2,6})\s+((?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z' ]{2,40}?)(?:\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Pl|Place|Cir|Circle|Ter|Terrace)\.?\b|\s*[,#]|$)/i);
  if (!m) return null;
  return { num: parseInt(m[1], 10), street: m[2].toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim() };
}
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
// Find the best project for an address hint. Returns { id, address } or null.
async function matchBidToProject(hint) {
  const want = parseStreetAddr(hint);
  if (!want) return null;
  const { rows: projects } = await pool.query('SELECT id, address, full_address FROM projects');
  let best = null, bestScore = 1e9;
  for (const p of projects) {
    const have = parseStreetAddr(p.address) || parseStreetAddr(p.full_address);
    if (!have) continue;
    const dist = editDistance(want.street, have.street);
    const numDiff = Math.abs(want.num - have.num);
    if (dist > Math.max(2, Math.floor(have.street.length / 5)) || numDiff > 8) continue;   // not the same street / block
    const score = dist * 10 + numDiff;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}
// Pull an address-looking string out of estimate text (subject line first, then body).
// The street suffix is REQUIRED here — otherwise "Estimate 1586 from Mac Electric"
// reads as house number 1586 on a street called "from Mac Electric".
function bidJobHint(subject, bodyText) {
  const re = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z'. ]{2,40}?\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Pl|Place|Cir|Circle|Ter|Terrace)\.?\b/i;
  for (const src of [subject, String(bodyText || '').slice(0, 3000)]) {
    const m = String(src || '').match(re);
    if (m) return m[0].trim();
  }
  return null;
}

// ── QuickBooks bid ingester ────────────────────────────────────────────────────
// Subs send QuickBooks estimates from Intuit's notification address (not their own
// email), so the reply-checker never sees them. This watches the inbox for those,
// matches them to the right contractor (or creates one), logs the email + PDF under
// the sub, puts estimates into the bid pipeline, and CSLB-verifies any license
// number found in the sender name (QB From-names often carry it).
function qbTradeFromName(n) {
  n = String(n || '').toLowerCase();
  if (/cabinet/.test(n)) return 'Cabinets';
  if (/electric/.test(n)) return 'Electrician';
  if (/plumb/.test(n)) return 'Plumber';
  if (/roof/.test(n)) return 'Roofing';
  if (/paint/.test(n)) return 'Painter';
  if (/hvac|\bair\b/.test(n)) return 'HVAC';
  if (/floor/.test(n)) return 'Flooring';
  if (/concrete/.test(n)) return 'Concrete';
  if (/fram/.test(n)) return 'Framing';
  if (/drywall/.test(n)) return 'Drywall';
  if (/landscap/.test(n)) return 'Landscaping';
  if (/solar/.test(n)) return 'Solar';
  if (/stucco|plaster/.test(n)) return 'Stucco';
  if (/insulat/.test(n)) return 'Insulation';
  if (/tile/.test(n)) return 'Tile';
  if (/demo/.test(n)) return 'Demolition';
  if (/glass|shower/.test(n)) return 'Windows & Doors';
  if (/build|construction|design/.test(n)) return 'General Contractor';
  return '';
}
async function ingestOneQb(messageId) {
  const { data } = await gmailClient.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const H = data.payload.headers || [];
  const hv = n => { const h = H.find(x => x.name.toLowerCase() === n.toLowerCase()); return h ? h.value : ''; };
  const from = hv('From'), subject = hv('Subject'), replyTo = (hv('Reply-To').match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0].toLowerCase();
  if (!/intuit\.com|quickbooks/i.test(from)) return null;
  const fromName = (from.match(/^"?([^"<]+?)"?\s*</) || [, ''])[1].trim();
  const kind = /estimate/i.test(subject) ? 'estimate' : 'doc';
  // Business name: prefer the subject ("Estimate 1664 from BUSINESS"), strip a trailing job address
  let biz = ((subject.match(/(?:estimate|invoice|proposal|receipt|payment request)[^a-z0-9]*(?:#?\s*[\w-]+)?\s+from\s+(.{2,80})/i) || [])[1] || fromName).trim();
  biz = biz.replace(/[\s,.-]*\b\d{2,6}\s+.*$/, '').replace(/\s*-\s*(invoice|estimate).*$/i, '').trim() || fromName;   // cut a trailing job address ("… 840 N Edgemont St, LA")
  const bizClean = biz.replace(/\s*(?:LIC\.?#?\s*\d{5,8}|C-?\d{1,2}\s+\d{5,8})\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  // License number hiding in the sender name ("P & K ELECTRIC CORP C-10 939525")
  const licM = fromName.match(/(?:lic(?:ense)?\.?\s*#?\s*|c-?\d{1,2}\s+)(\d{5,8})/i);
  // Amount from the email body
  const chunks = [];
  (function walk(p) { if (!p) return; if (p.body && p.body.data) chunks.push(Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); (p.parts || []).forEach(walk); })(data.payload);
  const text = chunks.join('\n').replace(/<[^>]+>/g, ' ').replace(/&[a-z#\d]+;/gi, ' ');
  const amt = (text.match(/(?:total|amount|balance)[^\d$]{0,25}\$\s?([\d,]+\.\d{2})/i) || text.match(/\$\s?([\d,]+\.\d{2})/) || [])[1] || '';
  // Match to a contractor: reply-to email → exact name → word-stripped name → long contains
  const normFull = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normWords = s => String(s || '').toLowerCase().replace(/\b(inc|llc|corp|co|company|corporation|svc|svcs|service|services|electric|electrical|plumbing|construction|builders?|contractors?|design|build)\b/g, '').replace(/[^a-z0-9]/g, '');
  const { rows: subsAll } = await pool.query('SELECT id, company, email, status, license_number, bid_status FROM subcontractors');
  const bk = normFull(bizClean), bw = normWords(bizClean);
  const sub = (replyTo && subsAll.find(s => (s.email || '').toLowerCase() === replyTo))
    || subsAll.find(s => normFull(s.company) && normFull(s.company) === bk)
    || subsAll.find(s => bw && normWords(s.company) === bw)
    || subsAll.find(s => bk.length >= 8 && normFull(s.company).length >= 8 && (normFull(s.company).includes(bk) || bk.includes(normFull(s.company))));
  // Only pull bids for contractors already on the list (matched by their email or name).
  // Unknown senders are ignored — QuickBooks never creates new subs.
  if (!sub) return null;
  // Log the email under the sub (+ attachments), flag unread
  const when = isNaN(new Date(hv('Date')).getTime()) ? new Date() : new Date(hv('Date'));
  const bodyText = text.replace(/\s+/g, ' ').trim().slice(0, 1500);
  const bodyHtml = gmailHtmlFromPayload(data.payload, messageId) || null;   // keep the real email for the Gmail-style viewer
  const { rows: [em] } = await pool.query(
    `INSERT INTO sub_emails (sub_id, to_email, from_email, subject, body, body_html, sent_by, direction, gmail_thread_id, gmail_message_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'sub','in',$7,$8,$9) RETURNING id`,
    [sub.id, gmailUser, replyTo || 'quickbooks@notification.intuit.com', subject.slice(0, 250), bodyText, bodyHtml, data.threadId, messageId, when]);
  const atts = [];
  (function wa(p) { if (!p) return; if (p.filename && p.body && p.body.attachmentId) atts.push({ filename: p.filename, mime: p.mimeType, size: p.body.size, aid: p.body.attachmentId }); (p.parts || []).forEach(wa); })(data.payload);
  for (const a of atts) {
    await pool.query('INSERT INTO sub_email_attachments (sub_email_id, filename, mime, size, gmail_message_id, gmail_attachment_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [em.id, a.filename, a.mime || null, a.size || null, messageId, a.aid]);
  }
  await pool.query('UPDATE subcontractors SET reply_unread=true WHERE id=$1', [sub.id]);
  // Estimates feed the bid pipeline (never downgrade an Awarded bid)
  if (kind === 'estimate' && amt) {
    const newStatus = /awarded/i.test(sub.bid_status || '') ? sub.bid_status : 'Bid Received';
    await pool.query('UPDATE subcontractors SET bid_status=$1, bid_price=$2 WHERE id=$3', [newStatus, ('$' + amt).slice(0, 40), sub.id]);
    // …and the sub moves from Under Review into the "Bid Under Review" section so the
    // new bid is impossible to miss in the list. Actives/Approved/Flagged stay put.
    if (!/active|approv|inactive|reject|black|bid under review/i.test(sub.status || '')) {
      await pool.query("UPDATE subcontractors SET status='Bid Under Review', group_label='Bid Under Review' WHERE id=$1", [sub.id]);
    }
  }
  // …and the bid board: one row per estimate, auto-matched to a project by job address
  if (kind === 'estimate') {
    try {
      const estNo = (subject.match(/estimate\s*#?\s*([\w-]+)/i) || [])[1] || null;
      const hint = bidJobHint(subject, text);
      const pdf = atts.find(a => /pdf/i.test(a.mime || a.filename));
      const numAmt = amt ? Number(amt.replace(/,/g, '')) : null;
      const { rows: [dup] } = await pool.query(
        'SELECT id FROM bids WHERE gmail_message_id=$1 OR (sub_id=$2 AND estimate_no IS NOT NULL AND estimate_no=$3) LIMIT 1',
        [messageId, sub.id, estNo]);
      if (dup) {
        await pool.query('UPDATE bids SET amount=COALESCE($1, amount), subject=$2, job_hint=COALESCE($3, job_hint) WHERE id=$4',
          [numAmt, subject.slice(0, 250), hint, dup.id]);
      } else {
        const proj = hint ? await matchBidToProject(hint) : null;
        await pool.query(
          `INSERT INTO bids (sub_id, project_id, amount, estimate_no, subject, job_hint, gmail_message_id, filename, gmail_attachment_id, auto_matched, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [sub.id, proj ? proj.id : null, numAmt, estNo, subject.slice(0, 250), hint,
           messageId, pdf ? pdf.filename : null, pdf ? pdf.aid : null, !!proj, when]);
      }
    } catch (e) { console.error('bid board insert:', e.message); }
  }
  // License number from the sender name → save + verify against CSLB
  if (licM && !(sub.license_number || '').trim()) {
    try { await verifySubLicense({ id: sub.id, company: sub.company, notes: '', license_number: licM[1] }); } catch (e) { /* keep ingesting */ }
  }
  // Estimates post to the dedicated "Bids" chat space — never the delivery chat.
  // Preferred: Chat API as the Gmail user with the real PDF(s) attached (needs BIDS_SPACE
  // + a refresh token carrying chat.messages.create). Fallback: webhook with PDF links.
  if (kind === 'estimate' && !CHAT_PAUSED && (process.env.BIDS_SPACE || process.env.BIDS_WEBHOOK_URL)) {
    const header = '📥 *' + (sub.company || bizClean) + '*' + (amt ? ' — *$' + amt + '*' : '');
    const pdfs = atts.filter(a => /pdf/i.test(a.mime || a.filename)).slice(0, 3);
    let posted = false;
    if (process.env.BIDS_SPACE && gOauth2) {
      try {
        const space = process.env.BIDS_SPACE; // e.g. spaces/AAQAjYQmAoc
        const at = (await gOauth2.getAccessToken()).token;
        const refs = [];
        for (const a of pdfs) {
          const r = await gmailClient.users.messages.attachments.get({ userId: 'me', messageId, id: a.aid });
          const buf = Buffer.from(String(r.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
          const boundary = 'qbbid' + Math.floor(Math.random() * 1e9);
          const body = Buffer.concat([
            Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ filename: a.filename }) + '\r\n--' + boundary + '\r\nContent-Type: ' + (a.mime || 'application/pdf') + '\r\n\r\n'),
            buf, Buffer.from('\r\n--' + boundary + '--')]);
          const up = await fetch('https://chat.googleapis.com/upload/v1/' + space + '/attachments:upload?uploadType=multipart', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
          const upd = await up.json();
          if (!up.ok) throw new Error('upload HTTP ' + up.status + ': ' + JSON.stringify(upd).slice(0, 150));
          refs.push({ attachmentDataRef: upd.attachmentDataRef });
        }
        const mr = await fetch('https://chat.googleapis.com/v1/' + space + '/messages', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: header + '\n' + subject.slice(0, 140), attachment: refs }) });
        if (!mr.ok) throw new Error('message HTTP ' + mr.status + ': ' + JSON.stringify(await mr.json()).slice(0, 150));
        posted = true;
      } catch (e) { console.error('bids chat api (falling back to webhook):', e.message); }
    }
    if (!posted && process.env.BIDS_WEBHOOK_URL) {
      try {
        const base = process.env.APP_URL || 'https://buildoly.up.railway.app';
        const docLinks = pdfs.map(a =>
          '📄 ' + a.filename + '\n' + base + '/threads/messages/' + messageId + '/attachment/' + a.aid + '?name=' + encodeURIComponent(a.filename) + '&mime=' + encodeURIComponent(a.mime || 'application/pdf'));
        await fetch(process.env.BIDS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text: [header, subject.slice(0, 140), ...docLinks].join('\n') }) });
      } catch (e) { console.error('bids webhook:', e.message); }
    }
  }
  return { sub: sub.company, kind, amt };
}
async function ingestQuickBooksEmails() {
  if (!useGmail) return;
  try {
    const list = await gmailClient.users.messages.list({ userId: 'me', q: 'from:(notification.intuit.com OR quickbooks.com) newer_than:280d', maxResults: 40 });
    // Gmail returns newest first — process oldest→newest so the LATEST estimate wins the bid price
    for (const m of (list.data.messages || []).slice().reverse()) {
      const { rows: [seen] } = await pool.query('SELECT 1 FROM qb_seen WHERE gmail_message_id=$1', [m.id]);
      if (seen) continue;
      await pool.query('INSERT INTO qb_seen (gmail_message_id) VALUES ($1) ON CONFLICT DO NOTHING', [m.id]);
      try {
        const r = await ingestOneQb(m.id);
        if (r) console.log('qb ingested: ' + r.kind + ' ' + r.sub + (r.amt ? ' $' + r.amt : ''));
      } catch (e) { console.error('qb ingest ' + m.id + ':', e.message); }
    }
  } catch (e) { console.error('ingestQuickBooksEmails:', e.message); }
}

// ── Test runner ──────────────────────────────────────────────────────────────────
// Drives any automated job on demand for an isolated end-to-end test. Only works while
// ISOLATION MODE is on (every email is redirected to MAIL_REDIRECT_ALL) and requires the
// TEST_KEY, so it can never fire real notifications. GET /_test/run?key=…&job=list
app.get('/_test/run', async (req, res) => {
  if (!ISOLATION_ON) return res.status(403).json({ ok: false, error: 'Isolation mode is OFF (set MAIL_REDIRECT_ALL to enable the test runner).' });
  if (!process.env.TEST_KEY || req.query.key !== process.env.TEST_KEY) return res.status(403).json({ ok: false, error: 'Missing or bad key.' });
  const JOBS = {
    'morning-brief': sendMorningBrief, 'weekly-digest': sendWeeklyDigest, 'coverage-digest': coverageDigest,
    'delivery-reminder': sendDeliveryReminder, 'delivery-confirmations': sendDeliveryConfirmations,
    'day-before-reminders': dayBeforeDeliveryReminders,
    'requeue-missed-notices': requeueMissedNotices,
    'license-watchdog': licenseWatchdog, 'insurance-scan': insuranceScanAll,
    'qb-bids': ingestQuickBooksEmails, 'platform-bids': sweepPlatformBids,
    'ferguson-emails': pollFergusonEmails, 'ferguson-autocomplete': fergusonAutoComplete, 'ferguson-orders': sweepFergusonOrders,
    'bounces': pollEmailBounces, 'unread-threads': checkUnreadThreads, 'sub-replies': checkSubReplies, 'warranty': autoCompleteWarranty,
    'delivery-replies': processDeliveryReplies,
    // Proof job: addresses a clearly-external inbox. With isolation on it must land in
    // MAIL_REDIRECT_ALL tagged "[TEST → probe-external-sub@example.com]", never actually sent out.
    'probe-external': async () => {
      await sendMail({ to: 'probe-external-sub@example.com', subject: 'Isolation probe (should never leave your inbox)',
        html: '<p>If you are reading this in loganghauser@gmail.com, isolation caught an email addressed to an external party.</p>' });
      return 'probe sent to probe-external-sub@example.com (redirected)';
    },
  };
  const job = String(req.query.job || '');
  // Parameterized: fire the branded delivery notice for a project + bucket(s) + window.
  // e.g. /_test/run?key=…&job=delivery-notice&project=1&code=3b&window=Monday, July 6th 2026 between 07:30 AM - 10:30 AM
  if (job === 'delivery-notice') {
    const projectId = parseInt(req.query.project || '1', 10);
    const codes = String(req.query.code || '1b').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const window = req.query.window || '';
    const toOverride = req.query.to || undefined;
    const method = req.query.method || 'truck';
    const tracking = req.query.tracking || undefined;
    const manifestBlob = req.query.manifest ? normModel(req.query.manifest) : undefined;
    const exceptBlob = req.query.except ? normModel(req.query.except) : undefined;
    try { return res.json({ ok: true, job, result: await sendDeliveryNotice({ projectId, codes, window, toOverride, method, tracking, manifestBlob, exceptBlob }) }); }
    catch (e) { return res.json({ ok: false, job, error: e.message }); }
  }
  if (job === 'list' || !job) return res.json({ ok: true, isolation: MAIL_REDIRECT_ALL, jobs: [...Object.keys(JOBS), 'delivery-notice (params: project,code,window,to)'] });
  const fn = JOBS[job];
  if (!fn) return res.status(400).json({ ok: false, error: 'unknown job: ' + job, jobs: Object.keys(JOBS) });
  const t0 = Date.now();
  try {
    const result = await fn();
    res.json({ ok: true, job, ms: Date.now() - t0, result: result === undefined ? 'ran (see email/Bids space + logs)' : result });
  } catch (e) {
    res.json({ ok: false, job, ms: Date.now() - t0, error: e.message, stack: (e.stack || '').split('\n').slice(0, 4) });
  }
});

function startCron() {
  // Times are UTC on Railway. 15:00 UTC ≈ 7-8am Pacific.
  cron.schedule('*/20 * * * *', checkUnreadThreads);   // every 20 min
  cron.schedule('*/20 * * * *', processDeliveryReplies); // every 20 min — parse vendor delivery-date replies → queue notice
  cron.schedule('*/20 * * * *', checkSubReplies);      // every 20 min — pull sub replies into the log
  cron.schedule('*/20 * * * *', ingestQuickBooksEmails); // every 20 min — QuickBooks bids from the inbox
  cron.schedule('*/20 * * * *', sweepPlatformBids);      // every 20 min — FieldGroove-style platform bids
  cron.schedule('*/20 * * * *', pollFergusonEmails);     // every 20 min — Ferguson shipment/appliance alerts
  cron.schedule('*/20 * * * *', sweepFergusonOrders);    // every 20 min — rep order-confirmation PDFs
  cron.schedule('*/25 * * * *', () => { if (!_heldRefreshing) { _heldRefreshing = true; refreshHeldUsages().catch(e => console.error('held usages refresh:', e.message)).finally(() => { _heldRefreshing = false; }); } });  // keep the inventory cache warm
  cron.schedule('*/20 * * * *', pollEmailBounces);       // every 20 min — flag bounced sub emails on the Subs page
  cron.schedule('*/20 * * * *', fergusonAutoComplete);   // every 20 min — window passed → mark delivered
  cron.schedule('20 15 * * *', autoCompleteWarranty);  // daily — 1-year warranty graduation
  cron.schedule('0 15 * * *', sendDeliveryReminder);    // daily ~7am PT
  cron.schedule('10 15 * * *', dayBeforeDeliveryReminders); // daily ~7am PT — auto-send day-before delivery reminders
  cron.schedule('0 14 * * *', sendMorningBrief);        // daily 7am PT — the everything brief (Bids space)
  if (process.env.RUN_BRIEF_ON_BOOT === '1') sendMorningBrief();   // local testing hook
  if (process.env.AUTO_DELIVERY_CONFIRM === 'on') cron.schedule('30 15 * * *', sendDeliveryConfirmations);   // day-before vendor confirmations (opt-in)
  cron.schedule('0 15 * * 1', sendWeeklyDigest);        // Mondays ~7am PT
  cron.schedule('40 15 * * 1', licenseWatchdog);        // Mondays — CSLB license re-check
  cron.schedule('0 14 * * 0', () => insuranceScanAll().then(o => console.log('insurance scan:', JSON.stringify(o))).catch(e => console.error('insurance scan:', e.message)));   // Sundays — re-read COIs
  cron.schedule('10 15 * * 1', coverageDigest);         // Mondays — recruiting digest to the Bids space
  console.log('Cron jobs scheduled');
}

// ── Start ─────────────────────────────────────────────────────────────────────

// Allow one-off maintenance scripts to reuse the DB + schedule logic
// (require('./server.js')) without starting the HTTP server.
module.exports = { pool, computeHeldUsages, initDb, HELD_STATUSES, fetchScheduleValues, readScheduleByCategory, readScheduleVendors };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}
initDb().then(() => { console.log('DB ready'); loadAccess(); loadPeople(); loadTeamLogins(); _heldRefreshing = true; refreshHeldUsages().then(c => console.log('inventory cache warm: ' + c.usages.length + ' usages, ' + c.fails.length + ' sheet(s) failed')).catch(e => console.error('warm held usages:', e.message)).finally(() => { _heldRefreshing = false; }); startCron(); checkUnreadThreads(); checkSubReplies(); ingestQuickBooksEmails(); sweepPlatformBids(); pollFergusonEmails().then(fergusonAutoComplete); sweepFergusonOrders(); pollEmailBounces(); autoCompleteWarranty(); }).catch(err => console.error('DB init failed:', err.message));
