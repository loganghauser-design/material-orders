// Run: node scripts/seed.js
// Seeds all projects from the Google Sheet screenshots
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_ETlaU0Q2gvYZ@ep-shy-frog-ak9efl5x.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

const ALL_ITEM_CODES = ['1a','1b','1c','1d','1e','2a','2b','2c','2d','3a','3b','3c','3d'];

const PROJECTS = [
  { address: '33772 Silver Lantern', version: 'V3', overall_status: 'In Progress' },
  { address: '3223 La Clede Ave', version: 'V1/2', overall_status: 'All Delivered' },
  { address: '722 South Highland Avenue', version: 'V3', overall_status: 'In Progress' },
  { address: '1325 Western Ave', version: 'V3', overall_status: 'All Delivered' },
  { address: '2017 Manning', version: 'V1/2', overall_status: 'All Delivered' },
  { address: '4381 Gundry Ave', version: 'V1/2', overall_status: 'All Delivered' },
  { address: '10111 Topeka Dr', version: 'V1/2', overall_status: 'All Delivered' },
  { address: '1092 Bradcliff Dr', version: 'V3', overall_status: 'In Progress' },
  { address: '9555 Vanalden Ave, Northridge', version: 'V3', overall_status: 'In Progress' },
  { address: '842 N Edgemont St, Los Angeles', version: 'V3', overall_status: 'In Progress' },
  { address: '1827 N Alvarado', version: 'V3', overall_status: 'In Progress' },
  { address: '4137 Milton', version: 'V3', overall_status: 'In Progress' },
  { address: '2589 N Raymond Ave', version: 'Custom', overall_status: 'In Progress' },
  { address: '2577 N Raymond Ave ADU', version: 'Custom', overall_status: 'In Progress' },
  { address: '17810 Norwalk Blvd, Artesia', version: 'M3', overall_status: 'Not Yet' },
  { address: '12012 S La Cienega Blvd', version: 'V3', overall_status: 'All Delivered' },
  { address: '2309 Via Rivera, Palos Verdes', version: 'V3', overall_status: 'Not Yet' },
  { address: '22801 Angel Lane', version: 'V3', overall_status: 'Not Yet' },
  { address: '35 E Loma Alta Dr', version: 'V3', overall_status: 'Not Yet' },
  { address: '5102 W 123rd St, Hawthorne', version: 'V3', overall_status: 'Not Yet' },
  { address: '7885 Croydon Ave', version: 'V3', overall_status: 'Not Yet' },
  { address: '14518 Jersey Ave', version: 'V4', overall_status: 'Not Yet' },
  { address: '2168 Rexford Dr', version: 'V4', overall_status: 'Not Yet' },
  { address: '260 Plumosa Ave', version: 'V4', overall_status: 'Not Yet' },
  { address: '1321 South Olive St', version: 'V4', overall_status: 'Not Yet' },
  { address: '2665 Newell St', version: 'V4', overall_status: 'Not Yet' },
  { address: '3717 W 172nd St', version: 'V4', overall_status: 'Not Yet' },
  { address: '14851 Featherhill Rd', version: 'M1', overall_status: 'Not Yet' },
  { address: '13639 Alderton Ln', version: 'Custom', overall_status: 'Not Yet' },
  { address: '5112 Dumont Pl', version: 'Custom', overall_status: 'Not Yet' },
  { address: '1135 Ohio St', version: null, overall_status: 'Not Yet' },
];

async function seed() {
  console.log('Creating tables...');
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
    CREATE TABLE IF NOT EXISTS project_items (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      item_code VARCHAR(10) NOT NULL,
      status VARCHAR(50) DEFAULT 'Not yet placed',
      delivery_date DATE,
      notes TEXT,
      UNIQUE(project_id, item_code)
    );
  `);
  console.log('Seeding projects...');
  for (const p of PROJECTS) {
    const { rows: [existing] } = await pool.query('SELECT id FROM projects WHERE address=$1', [p.address]);
    if (existing) { console.log('Skip (exists):', p.address); continue; }
    const { rows: [row] } = await pool.query(
      `INSERT INTO projects (address, version, overall_status) VALUES ($1,$2,$3) RETURNING id`,
      [p.address, p.version, p.overall_status]
    );
    for (const code of ALL_ITEM_CODES) {
      await pool.query(
        `INSERT INTO project_items (project_id, item_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [row.id, code]
      );
    }
    console.log('Added:', p.address);
  }
  console.log('Done!');
  await pool.end();
}

seed().catch(err => { console.error(err); process.exit(1); });
