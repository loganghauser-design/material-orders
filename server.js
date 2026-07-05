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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
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
  if (!SHEETS_API_KEY) throw new Error('Google Sheets API key not configured.');
  const id = sheetIdFromUrl(scheduleUrl);
  if (!id) throw new Error('Invalid finish-schedule link.');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Fin%20Sched!A1:S400?key=${SHEETS_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) {
    if (r.status === 403) throw new Error('Sheet not shared — set it to "Anyone with the link → Viewer".');
    throw new Error('Could not read the schedule (HTTP ' + r.status + ').');
  }
  const rows = ((await r.json()).values) || [];
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
      finishColor: (row[8] || '').trim(),
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
async function computeHeldUsages() {
  const { rows: projects } = await pool.query(
    "SELECT id, COALESCE(full_address, address) AS address, finish_schedule_url, rec_lighting_source, range_hood_source, jedco_source, bifold_source, sliding_door_source FROM projects WHERE finish_schedule_url IS NOT NULL AND finish_schedule_url <> '' ORDER BY address"
  );
  // Fetch all schedules in parallel (cached) instead of one-at-a-time
  const fetched = await Promise.all(projects.map(async proj => {
    try { return { proj, rows: await fetchScheduleValues(proj.finish_schedule_url) }; }
    catch (e) { return null; }
  }));
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
  return usages;
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
function findSuper(email) {
  const e = String(email || '').trim().toLowerCase();
  return SUPERS.find(s => s.email.toLowerCase() === e) || null;
}
// Additional full-access (admin) logins beyond the env ADMIN account (Logan).
// Default password is "buildoly" — ask to have it changed to something specific.
const ADMINS = [
  { username: 'jeff', name: 'Jeff', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },  // CEO
  { username: 'aziz', name: 'Aziz', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },  // Ops manager
  { username: 'rick', name: 'Rick', passwordHash: '$2b$10$YCz8jB0QM8p7rE1lXwvJZeCNIPYv5GoHoGJIO1xOeoM9ymp4EOFfe' },  // Sales — limited access (see defaultPagesFor)
];
function findAdminByLogin(login) {
  const l = String(login || '').trim().toLowerCase();
  return ADMINS.find(a => a.username.toLowerCase() === l) || null;
}

// ── Page permissions (managed in the /team hub) ───────────────────────────────
// Logan (the env admin) is always full-access and can't be restricted. Everyone
// else's page access is configurable and defaults to their current access.
const PAGE_META = [
  { key: 'projects', label: 'Projects', path: '/projects' },
  { key: 'deliveries', label: 'Deliveries', path: '/deliveries' },
  { key: 'ordering', label: 'Order Planner', path: '/ordering' },
  { key: 'requests', label: 'Requests', path: '/requests' },
  { key: 'issues', label: 'Issues', path: '/issues' },
  { key: 'warranty', label: 'Warranty', path: '/warranty-claims' },
  { key: 'subs', label: 'Subs', path: '/subs' },
  { key: 'bids', label: 'Bids', path: '/bids' },
  { key: 'suppliers', label: 'Suppliers', path: '/suppliers' },
  { key: 'inventory', label: 'Inventory', path: '/inventory' },
  { key: 'driving', label: 'Driving Log', path: '/driving' },
  { key: 'settings', label: 'Settings', path: '/settings' },
];
const PAGE_KEYS = PAGE_META.map(p => p.key);
function teamMembers() {
  return [
    ...ADMINS.map(a => ({ key: a.username, name: a.name, role: 'Admin' })),
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
function defaultPagesFor(key, role) {
  if (key === 'rick') return new Set(['subs']);               // Sales: Subs/bidding only (tune on the Team page)
  if (role === 'admin') return new Set(PAGE_KEYS);            // Jeff/Aziz default to everything
  if (canSuperViewSubs(key)) return new Set(['subs', 'warranty']);  // Bobby keeps his current access
  return new Set();                                          // other supers: portal only
}
function sessionKey(req) { return (req.session && (req.session.userKey || req.session.superEmail)) || ''; }
function allowedPagesFor(key, role) {
  if (key === 'logan') return new Set(PAGE_KEYS);            // Logan: full, locked
  if (ACCESS[key]) return ACCESS[key];
  return defaultPagesFor(key, role);
}
function pageForPath(p) {
  if (p === '/') return null;   // dashboard — open to every admin; supers get sent to /my
  if (p.startsWith('/projects') || p === '/reorder-projects') return 'projects';
  if (p.startsWith('/deliveries')) return 'deliveries';
  if (p.startsWith('/ordering')) return 'ordering';
  if (p.startsWith('/driving')) return 'driving';
  if (p.startsWith('/inventory') || p === '/stock-status') return 'inventory';
  if (p.startsWith('/requests')) return 'requests';
  if (p.startsWith('/issues')) return 'issues';
  if (p.startsWith('/warranty-claims')) return 'warranty';
  if (p.startsWith('/suppliers')) return 'suppliers';
  if (p.startsWith('/subs') || p.startsWith('/sub-photo')) return 'subs';
  if (p.startsWith('/bids')) return 'bids';
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
  return SUPERS.filter(s => set.includes(s.email.toLowerCase()));
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
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS ins_note TEXT;
    ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS ins_checked_at TIMESTAMPTZ;

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

// Expose pending counts to every admin page so the nav can show badges (Issues + Requests)
app.use(async (req, res, next) => {
  if (req.method === 'GET' && req.session && req.session.authenticated) {
    const key = sessionKey(req);
    res.locals.isLogan = (key === 'logan');
    res.locals.navPages = res.locals.isLogan ? '*' : [...allowedPagesFor(key, req.session.role)];
    if (req.session.role === 'admin') {
      try {
        res.locals.pendingIssues = await getPendingIssueCount();
        res.locals.pendingRequests = await getPendingRequestCount();
        res.locals.openWarranty = await getOpenWarrantyCount();
      } catch (e) { /* tables may not exist yet */ }
    }
  }
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
    postToChat(lines.join('\n'), 'request-' + reqRow.id);   // same thread key the office reply uses
    res.redirect('/my?requested=1');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
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

    const pendingIssues = await getPendingIssueCount();
    res.render('projects', { projects, stats, itemMaps, query: req.query, PROJECT_STATUSES, PROJECT_PHASES, ITEM_STATUSES, unread, deliveredCounts, sort, supers: SUPERS, pendingIssues });
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
    await ensureProjectItems(project.id);
    const { rows: items } = await pool.query('SELECT * FROM project_items WHERE project_id=$1', [project.id]);
    const itemMap = {};
    items.forEach(i => itemMap[i.item_code] = i);
    // Pending material requests for this project → flag the requested items on the grid
    const { rows: reqRows } = await pool.query(
      'SELECT id, super_email, codes, needed_by, note, created_at FROM material_requests WHERE project_id=$1 AND fulfilled=FALSE ORDER BY created_at', [project.id]);
    const requestedByCode = {};
    for (const rq of reqRows) {
      const sName = (findSuper(rq.super_email) || {}).name || rq.super_email || 'Super';
      String(rq.codes || '').split(',').map(c => c.trim()).filter(Boolean).forEach(c => {
        if (!requestedByCode[c]) requestedByCode[c] = { sup: sName, needed_by: rq.needed_by };
      });
    }
    // Open issues for this project → label the affected lines
    const { rows: issueRows } = await pool.query(
      "SELECT id, super_email, item_code, item_label, note FROM material_issues WHERE project_id=$1 AND status='pending' AND item_code IS NOT NULL ORDER BY created_at DESC", [project.id]);
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
    const suppliers = await getSuppliers();
    const { rows: documents } = await pool.query('SELECT id, filename, uploaded_at FROM project_documents WHERE project_id=$1 ORDER BY uploaded_at DESC', [project.id]);
    const { rows: payments } = await pool.query('SELECT * FROM milestone_payments WHERE project_id=$1 ORDER BY requested_at DESC', [project.id]);

    // Confirmed vendor orders, grouped by vendor
    const { rows: orderRows } = await pool.query(`
      SELECT vo.id, vo.supplier_name, vo.supplier_email, vo.amount, vo.gmail_thread_id, vo.confirmed_at,
             (vo.receipt_data IS NOT NULL) AS has_receipt, vo.delivery_outcome,
             COALESCE(array_agg(voi.item_code ORDER BY voi.item_code) FILTER (WHERE voi.item_code IS NOT NULL), '{}') AS item_codes
      FROM vendor_orders vo
      LEFT JOIN vendor_order_items voi ON voi.order_id = vo.id
      WHERE vo.project_id=$1
      GROUP BY vo.id
      ORDER BY vo.supplier_name NULLS LAST, vo.confirmed_at DESC`, [project.id]);
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
    // Itemized line items per order (product + price), grouped by category
    const { rows: lineRows } = await pool.query(`
      SELECT vol.item_code, vol.product_code, vol.description, vol.qty, vol.price,
             vo.id AS order_id, vo.supplier_name, vo.supplier_email, (vo.receipt_data IS NOT NULL) AS has_receipt
      FROM vendor_order_lines vol JOIN vendor_orders vo ON vo.id = vol.order_id
      WHERE vo.project_id=$1
      ORDER BY vol.item_code, vol.id`, [project.id]);
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

    res.render('project', { project, STAGES, itemMap, requestedByCode, issueByCode, projectIssues, projectRequests, ITEM_STATUSES, PROJECT_STATUSES, EMAIL_PHASES, emailConfigured: emailEnabled, suppliers, documents, payments, ordersByVendor, itemNames, ordersByCategory, categoryRequestData, supers: SUPERS });
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
    const mention = sups.length ? sups.map(s => `<users/${s.chatId}>`).join(' ') + ' ' : '';
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
${contact}
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
    await pool.query(
      `INSERT INTO vendor_emails (project_id, item_code, item_codes, supplier_name, supplier_email, subject, email_type, gmail_thread_id, gmail_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${name}"`); // inline → PDFs open in the browser
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
      order: { verb: 'Order', intro: `We'd like to order the following <strong>${escapeHtml(catName)}</strong> items for <strong>${addr}</strong>:`, closing: 'Please confirm pricing, availability, and lead time.' },
      quote: { verb: 'RFQ', intro: `Please quote the following <strong>${escapeHtml(catName)}</strong> items for <strong>${addr}</strong>:`, closing: 'Please provide pricing, availability, and lead time.' },
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
<p>${t.closing}</p>
${signoff}
</div>`;

    const sent = await sendMail({ to, subject, html });
    await pool.query(
      `INSERT INTO vendor_emails (project_id, item_code, item_codes, supplier_name, supplier_email, subject, email_type, gmail_thread_id, gmail_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [req.params.id, category || null, category || null, null, to, subject, emailType || 'delivery', sent.threadId || null, sent.messageId || null]
    );
    // Advance the category's material too — quote → "RFQ sent", order → "Order Placed"
    if (category && ALL_ITEMS.find(i => i.code === category) && TYPE_TARGET[emailType]) {
      await bumpItemsForward(req.params.id, [category], TYPE_TARGET[emailType]);
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
        bids: everContacted.filter(s => /received|awarded/i.test(s.bid_status || '')).length,
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
    res.render('subs', { subs, photosBySub, emailsBySub, attByEmail, outreach, imported: req.query.imported, added: req.query.added, isSuper, canEdit, recentCount, emailEnabled,
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
    await initDb(); await loadAccess();
    const members = teamMembers().map(m => ({ key: m.key, name: m.name, role: m.role, pages: [...allowedPagesFor(m.key, m.role.toLowerCase())] }));
    res.render('team', { members, PAGES: PAGE_META, saved: req.query.saved === '1' });
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

// Map a status to the matching section bucket, so status and section stay in sync.
function bucketForStatus(category, status) {
  const s = (status || '').toLowerCase();
  const gc = category === 'gc';
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
      `UPDATE subcontractors SET company=$1, location=$2, type=$3, status=$4, owner=$5, email=$6, phone=$7, notes=$8, category=$9, referenced_by=$10 WHERE id=$11`,
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
const SUB_INLINE_FIELDS = { bid_status: 'text', bid_price: 'text', license_number: 'text', licensed: 'bool', email: 'text', phone: 'text' };
app.post('/subs/:id/field', requireAuth, async (req, res) => {
  try {
    const sets = [], vals = [];
    for (const [k, type] of Object.entries(SUB_INLINE_FIELDS)) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      if (type === 'bool') v = (v === 'true' || v === true) ? true : (v === 'false' || v === false) ? false : null;
      else v = (v != null && String(v).trim()) ? String(v).trim().slice(0, 80) : null;
      sets.push(`${k}=$${vals.length + 1}`); vals.push(v);
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE subcontractors SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
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

// Insurance watchdog: scan every sub's emailed COIs for expiration dates (3-segment path)
app.post('/subs/insurance/scan-all', requireAuth, async (req, res) => {
  try {
    if (!useGmail) return res.status(400).json({ ok: false, error: 'Gmail not configured.' });
    const out = await insuranceScanAll();
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Bid board: every QuickBooks estimate, grouped by the project it's for ──
app.get('/bids', requireAuth, async (req, res) => {
  try {
    await initDb();
    const { rows: bids } = await pool.query(`
      SELECT b.*, s.company, s.type AS sub_type, s.license_flags
      FROM bids b JOIN subcontractors s ON s.id = b.sub_id
      ORDER BY b.received_at DESC`);
    const { rows: projects } = await pool.query('SELECT id, address FROM projects ORDER BY sort_order NULLS LAST, id');
    res.render('bids', { bids, projects });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});
app.post('/bids/:id/assign', requireAuth, async (req, res) => {
  try {
    const pid = req.body.project_id ? Number(req.body.project_id) : null;
    await pool.query('UPDATE bids SET project_id=$1, auto_matched=false WHERE id=$2', [pid, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/bids/:id/status', requireAuth, async (req, res) => {
  try {
    const st = ['received', 'awarded', 'passed'].includes(req.body.status) ? req.body.status : 'received';
    const { rows: [b] } = await pool.query('UPDATE bids SET status=$1 WHERE id=$2 RETURNING sub_id', [st, req.params.id]);
    if (b && st === 'awarded') await pool.query("UPDATE subcontractors SET bid_status='Awarded' WHERE id=$1", [b.sub_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/bids/:id/delete', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM bids WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

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
    // Sending an email advances the outreach pipeline to "Bid Sent"
    await pool.query("UPDATE subcontractors SET bid_status='Bid Sent' WHERE id=$1", [sub.id]);
    res.json({ ok: true, bid_status: 'Bid Sent' });
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
    res.json({ ok: true, subject });
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

    res.render('_inventory-tables', { officeItems, warehouseItems, error });
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
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
      const LOGAN = '106404376271648731086';
      postToChat(['🛡️ *License Watchdog* <users/' + LOGAN + '> — ' + findings.length + ' contractor(s) need attention:', ...findings.slice(0, 15)].join('\n'));
    }
    console.log('licenseWatchdog: checked ' + rows.length + ', flagged ' + findings.length);
  } catch (e) { console.error('licenseWatchdog:', e.message); }
}

// ── Weekly recruiting digest → the Bids chat space ─────────────────────────────
// One short Monday post: coverage gaps vs the 4-per-area minimum, expiring licenses
// and insurance, and the bids that came in during the week.
const COVERAGE_AREAS = ['LA County', 'Orange County', 'Riverside County', 'San Diego County', 'Ventura County', 'San Bernardino County', 'The Valley'];
async function coverageDigest() {
  if (!process.env.BIDS_WEBHOOK_URL) return;
  try {
    const COV_MIN = 4;
    const { rows: subs } = await pool.query('SELECT company, type, status, location, category, license_expire, license_flags, ins_expires FROM subcontractors');
    const usable = subs.filter(s => !/reject|black/i.test(s.status || '') &&
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
    const base = process.env.APP_URL || 'https://buildoly.up.railway.app';
    const text = ['🧭 *Weekly recruiting digest*', ...lines, base + '/subs'].join('\n');
    await fetch(process.env.BIDS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
    console.log('coverageDigest posted');
  } catch (e) { console.error('coverageDigest:', e.message); }
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
  const { rows: subsAll } = await pool.query('SELECT id, company, email, license_number, bid_status FROM subcontractors');
  const bk = normFull(bizClean), bw = normWords(bizClean);
  let sub = (replyTo && subsAll.find(s => (s.email || '').toLowerCase() === replyTo))
    || subsAll.find(s => normFull(s.company) && normFull(s.company) === bk)
    || subsAll.find(s => bw && normWords(s.company) === bw)
    || subsAll.find(s => bk.length >= 8 && normFull(s.company).length >= 8 && (normFull(s.company).includes(bk) || bk.includes(normFull(s.company))));
  let createdNew = false;
  if (!sub && kind !== 'estimate') return null;   // only BIDS may create contractors — supplier invoices etc. are skipped
  if (!sub) {
    // Unknown business with a bid — add it so the bid doesn't fall on the floor
    const trade = qbTradeFromName(bizClean);
    const cat = /general contractor/i.test(trade) ? 'gc' : 'sub';
    const title = bizClean.replace(/\w\S*/g, w => /^(LLC|INC|DBA|USA|HVAC|II|III)\.?,?$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()).slice(0, 200);
    const { rows: [ins] } = await pool.query(
      `INSERT INTO subcontractors (company, type, status, email, notes, group_label, category, sort_order, recent_add)
       VALUES ($1,$2,'Under Review',$3,$4,'Under Vetting',$5,9999,TRUE) RETURNING id, company, email, license_number, bid_status`,
      [title, trade || null, replyTo || null, ('Added automatically from a QuickBooks ' + kind + ' ' + new Date().toLocaleDateString()).slice(0, 300), cat]);
    sub = ins; createdNew = true;
  }
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
  if (kind === 'estimate' && (process.env.BIDS_SPACE || process.env.BIDS_WEBHOOK_URL)) {
    const header = '📥 *' + (sub.company || bizClean) + '*' + (amt ? ' — *$' + amt + '*' : '') + (createdNew ? '  (new contractor 🆕)' : '');
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
  return { sub: sub.company, kind, amt, createdNew };
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
        if (r) console.log('qb ingested: ' + r.kind + ' ' + r.sub + (r.amt ? ' $' + r.amt : '') + (r.createdNew ? ' (new)' : ''));
      } catch (e) { console.error('qb ingest ' + m.id + ':', e.message); }
    }
  } catch (e) { console.error('ingestQuickBooksEmails:', e.message); }
}

function startCron() {
  // Times are UTC on Railway. 15:00 UTC ≈ 7-8am Pacific.
  cron.schedule('*/20 * * * *', checkUnreadThreads);   // every 20 min
  cron.schedule('*/20 * * * *', checkSubReplies);      // every 20 min — pull sub replies into the log
  cron.schedule('*/20 * * * *', ingestQuickBooksEmails); // every 20 min — QuickBooks bids from the inbox
  cron.schedule('20 15 * * *', autoCompleteWarranty);  // daily — 1-year warranty graduation
  cron.schedule('0 15 * * *', sendDeliveryReminder);    // daily ~7am PT
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
initDb().then(() => { console.log('DB ready'); loadAccess(); startCron(); checkUnreadThreads(); checkSubReplies(); ingestQuickBooksEmails(); autoCompleteWarranty(); }).catch(err => console.error('DB init failed:', err.message));
