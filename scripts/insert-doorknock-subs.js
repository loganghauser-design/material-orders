// One-off: load the door-knock / Marvin sub batch, tagged recent_add=TRUE for verification.
// Run with:  railway.cmd run node scripts/insert-doorknock-subs.js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const M = 'Marvin Han';
const D = 'Door knock';

const SUBS = [
  // ── From Marvin Han's text thread ──
  { company: 'James Kim', owner: 'James Kim', type: 'Handyman, Tile', cat: 'sub', phone: '213-703-1113', ref: M },
  { company: 'Juan', owner: 'Juan', type: 'Framing', cat: 'sub', phone: '323-691-2393', ref: M },
  { company: 'Oscar', owner: 'Oscar', type: 'Framing', cat: 'sub', phone: '323-867-1824', ref: M },
  { company: 'Alex', owner: 'Alex', type: 'Drywall', cat: 'sub', phone: '323-972-4591', ref: M },
  { company: 'Joe', owner: 'Joe', type: 'Drywall, Metal framing', cat: 'sub', phone: '909-961-5246', ref: M, notes: '"All Metal".' },
  { company: 'David Choi', owner: 'David Choi', type: 'General Contractor', cat: 'gc', phone: '562-991-8986', ref: M, notes: 'Does all GC work; good handyman work, detail finishers.' },
  { company: 'Whang', owner: 'Whang', type: 'Tile, Stone, Handyman', cat: 'sub', phone: '213-278-3548', ref: M },

  // ── Door-knock cards / site signs ──
  { company: 'Santiago Blanco', owner: 'Santiago Blanco', type: 'Electrical', cat: 'sub', phone: '818-577-9207', email: '5757santee@gmail.com', ref: D, notes: 'Residential/commercial/industrial; Tesla chargers, panels, data/TV/low-voltage, security cameras, ADU specialist.' },
  { company: 'Romanson Concrete Inc', owner: 'Fred De Oliviera', type: 'Concrete', cat: 'sub', phone: '805-206-5439', email: 'fdeoliviera@yahoo.com', location: 'Simi Valley, CA', ref: D, notes: '292 Clevenger Ave, Simi Valley CA 93065.' },
  { company: 'JBS Concrete Inc', type: 'Concrete', cat: 'sub', phone: '818-578-3751', ref: D, notes: 'Lic #998461. Commercial & residential concrete specialist.' },
  { company: 'Lindy Construction Inc', type: 'Plumbing', cat: 'sub', phone: '818-339-5640 / 818-408-1778', ref: D, notes: 'Lic #1123120. Residential/commercial, repipe, redrain, gas line.' },
  { company: 'LA Metro Plumbing', type: 'Plumbing', cat: 'sub', phone: '626-203-3753', ref: D, notes: 'Your local plumbing company.' },
  { company: 'Kain Tile Inc', owner: 'Jacinto Hernandez', type: 'Tile, Stone, Countertops', cat: 'sub', phone: '323-518-8376 / 323-244-5022', email: 'info@kaintileinc.com', location: 'Palmdale, CA', ref: D, notes: 'CSLB #1109146. kaintileinc.com. Landscape, tile, countertop. Quartz/granite/marble.' },
  { company: 'Alex Altadena', owner: 'Alex', type: 'Drywall, Tile, Finish', cat: 'sub', phone: '714-631-9451', ref: D, notes: 'Licensed (no # provided).' },
  { company: 'EC Precise Designs', type: 'General Contractor (all trades)', cat: 'gc', phone: '714-717-2347', ref: D, notes: 'All-in-one design & build; owns all trades. Contact also saved as "Patron Edic".' },
  { company: 'Burgueño Plumbing', type: 'Plumbing', cat: 'sub', phone: '323-561-7050', ref: D, notes: 'New plumbing, repairs & repipe, drain lines, camera inspection, tankless, construction additions.' },
  { company: 'JR Fire Sprinklers LLC', type: 'Fire sprinklers', cat: 'sub', phone: '909-770-2078', ref: D, notes: 'C-16 Lic #1077811. jrfiresprinklersllc.com. Commercial/residential.' },
  { company: 'Chapala Concrete Inc', owner: 'Jorge / Raul Jr.', type: 'Concrete, Masonry', cat: 'sub', phone: '818-254-7436 / 818-652-6765', ref: D, notes: 'Lic #698225. Basements, foundations, hardscape, masonry. Foundation — recommended by a framer.' },
  { company: 'Jose Franquiz Plumbing', type: 'Plumbing', cat: 'sub', phone: '661-212-2178', email: 'Jilfplumb@yahoo.com', location: 'Canyon Country, CA', ref: D, notes: 'CA Lic #813178. Water-sewer-gas. 19425 Soledad Cyn Rd #310, Canyon Country CA 91351.' },
  { company: 'Ludamark Construction Inc', owner: 'Carlota Silvas / Marcelo', type: 'Framing', cat: 'sub', phone: '818-383-1462 / Marcelo 310-912-2721', email: 'ludamarkconstruction@gmail.com', ref: D, notes: 'Licensed GC #1039132 — used for framing only.' },
  { company: 'P&K Electric Corp', type: 'Electrical', cat: 'sub', phone: '818-370-9745 / 818-256-5347', email: 'pandkelectric@gmail.com', location: 'North Hollywood, CA', ref: D, notes: 'Commercial/residential/industrial. 7316 Laurel Canyon Blvd, North Hollywood CA 91605.' },
  { company: 'Rodrigo Rivas', owner: 'Rodrigo Rivas', type: 'Foundation, Framing', cat: 'sub', phone: '562-715-8346', ref: D, notes: 'No license. Also roofing, windows, additions, remodeling, new houses.' },
  { company: 'Cromewell Construction Inc', type: 'General Contractor', cat: 'gc', phone: '818-858-5538', ref: D, notes: 'Lic #1042115 (B, C39, C36). Licensed/bonded/insured.' },
  { company: 'American United Contractors Inc', type: 'General Contractor', cat: 'gc', phone: '818-588-5077', ref: D, notes: 'Contractor.' },
  { company: 'ELS General Building Inc', owner: 'Fidel R. / Emanuel L.', type: 'General Contractor', cat: 'gc', phone: '323-974-4354 / 562-277-5031', ref: D, notes: 'CSLB #1138648. GC but also does sub work; owns all trades. Covers everywhere EXCEPT Orange County & Ventura.' },
  { company: 'J&E Framing Experts Associates', type: 'Framing, Foundation', cat: 'sub', phone: '818-691-9806', ref: D, notes: 'Experts in framing and foundation.' },
  { company: 'Herrejon Plastering', type: 'Plastering', cat: 'sub', phone: '818-219-0801', email: 'Herrejonplastering@gmail.com', ref: D, notes: 'CA Lic #1064286.' },
  { company: 'Crespo Framing', type: 'Framing', cat: 'sub', phone: '626-379-2203', email: 'JCrespo@CrespoFraming.com', ref: D, notes: 'CSLB #1082791.' },
  { company: 'JM Electrical', type: 'Electrical', cat: 'sub', phone: '323-392-3507', ref: D, notes: 'Residential & commercial. Plugs, lights, panels. 24hr emergency / 24-7.' },
  { company: "Fajardo's Plastering", type: 'Plastering, Stucco', cat: 'sub', phone: '951-251-8365', ref: D, notes: 'Stucco. (Phone read off worn hat — verify.)' },
  { company: 'A.C.S. Co Inc', type: 'HVAC', cat: 'sub', phone: '626-798-3649', ref: D, notes: 'A/C, heating, ventilation.' },
  { company: 'Rodriguez Quality Plastering', type: 'Plastering, Stucco', cat: 'sub', phone: '562-318-4129', ref: D, notes: 'CA Lic #1006752. For all your stucco needs.' },
  { company: 'GOP Construction Inc', type: 'General Contractor', cat: 'gc', phone: '818-335-2563', email: 'gopconstructioninc@gmail.com', ref: D, notes: 'Lic #1088993.' },
  { company: 'Insulation Labs', type: 'Insulation', cat: 'sub', phone: '800-559-7168', ref: D, notes: 'Lic #1034380. insulationlabs.com.' },
  { company: 'G.A. Preston', owner: 'Greg Preston', type: 'General Contractor (Seismic, Design, Engineering)', cat: 'gc', phone: '818-761-0178', email: 'gapreston007@aol.com', location: 'North Hollywood, CA', ref: D, notes: 'State Lic #304202. Estab. 1974. P.O. Box 871, North Hollywood CA 91603.' },
  { company: 'Vivere Construction', type: 'General Contractor (Design-Build)', cat: 'gc', phone: '626-763-1376', ref: D, notes: 'Lic #839135. All-in-one design and build; subs out work. vivereconstruction.com. "Altadena United".' },
  { company: 'Progressive Insulation & Windows', type: 'Insulation, Windows, Doors', cat: 'sub', phone: '800-500-6200', ref: D, notes: 'Lic #418046 (truck also shows CA 0257871). Energy solutions. ProgressiveIW.com.' },
  { company: 'Omar', owner: 'Omar', type: 'Tile, Masonry (block), Drywall', cat: 'sub', phone: '626-242-5916', ref: D, notes: 'License unclear — possibly masonry only (verify).' },
  { company: 'SG Construction & Framing', type: 'Framing', cat: 'sub', phone: '805-522-6358', ref: D, notes: 'Lic #610889 (read off truck — verify). Residential/commercial/custom. Framing only.' },
  { company: 'Nieves', owner: 'Nieves', type: 'Framing, Foundation', cat: 'sub', phone: '310-908-7387', ref: D, notes: 'Non-licensed.' },
];

(async () => {
  await pool.query("ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS recent_add BOOLEAN DEFAULT FALSE");
  let n = 0;
  for (const s of SUBS) {
    const grp = 'Under Vetting';   // all start Under Review → intake bucket
    const { rows: [mx] } = await pool.query(
      'SELECT MAX(sort_order) m FROM subcontractors WHERE category=$1 AND group_label IS NOT DISTINCT FROM $2', [s.cat, grp]);
    const so = (mx && mx.m != null) ? Number(mx.m) + 1 : 9999;
    await pool.query(
      `INSERT INTO subcontractors (company, location, type, status, owner, email, phone, notes, group_label, category, sort_order, referenced_by, recent_add)
       VALUES ($1,$2,$3,'Under Review',$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
      [s.company || null, s.location || null, s.type || null, s.owner || null, s.email || null, s.phone || null, s.notes || null, grp, s.cat, so, s.ref]
    );
    n++;
    console.log((n + '.').padEnd(4), (s.cat === 'gc' ? '[GC] ' : '[sub]'), s.company);
  }
  console.log('\nDone — inserted', n, 'subcontractors (recent_add=TRUE).');
  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
