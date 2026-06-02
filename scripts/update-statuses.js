const { Pool } = require('pg');
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL before running this script.'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Format: address => { '1a': status, '1b': status, ... }
const D = 'Delivered';
const DI = 'Delivered from Inv.';
const INV = 'In Inventory';
const OP = 'Order Placed';
const RFQ = 'RFQ sent';
const NYP = 'Not yet placed';
const NA = 'N/A';
const FD = 'Fully Delivered'; // overall status marker - all items delivered

const UPDATES = {
  '33772 Silver Lantern': {
    '1a': OP,  '1b': NYP, '1c': INV, '1d': NYP, '1e': NYP,
    '2a': INV, '2b': INV, '2c': INV, '2d': NYP,
    '3a': NYP, '3b': NYP, '3c': NYP, '3d': NYP,
  },
  '3223 La Clede Ave': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': D,
    '2a': D,   '2b': D,   '2c': D,   '2d': D,
    '3a': D,   '3b': D,   '3c': D,   '3d': D,
  },
  '722 South Highland Avenue': {
    '1a': D,   '1b': D,   '1c': DI,  '1d': RFQ, '1e': NA,
    '2a': INV, '2b': INV, '2c': INV, '2d': D,
    '3a': NYP, '3b': D,   '3c': NYP, '3d': NYP,
  },
  '1325 Western Ave': {
    '1a': DI,  '1b': D,   '1c': DI,  '1d': D,   '1e': NA,
    '2a': DI,  '2b': DI,  '2c': DI,  '2d': D,
    '3a': D,   '3b': D,   '3c': D,   '3d': NA,
  },
  '2017 Manning': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': D,
    '2a': D,   '2b': D,   '2c': D,   '2d': D,
    '3a': D,   '3b': D,   '3c': D,   '3d': D,
  },
  '4381 Gundry Ave': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': D,
    '2a': D,   '2b': D,   '2c': D,   '2d': D,
    '3a': D,   '3b': D,   '3c': D,   '3d': D,
  },
  '10111 Topeka Dr': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': D,
    '2a': D,   '2b': D,   '2c': D,   '2d': D,
    '3a': D,   '3b': D,   '3c': D,   '3d': D,
  },
  '1092 Bradcliff Dr': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': NA,
    '2a': DI,  '2b': DI,  '2c': DI,  '2d': OP,
    '3a': RFQ, '3b': OP,  '3c': NYP, '3d': NYP,
  },
  '9555 Vanalden Ave, Northridge': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': NYP,
    '2a': INV, '2b': OP,  '2c': INV, '2d': OP,
    '3a': NYP, '3b': OP,  '3c': NYP, '3d': NYP,
  },
  '842 N Edgemont St, Los Angeles': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': D,
    '2a': DI,  '2b': DI,  '2c': DI,  '2d': D,
    '3a': D,   '3b': D,   '3c': D,   '3d': NYP,
  },
  '1827 N Alvarado': {
    '1a': OP,  '1b': NYP, '1c': INV, '1d': NYP, '1e': NYP,
    '2a': INV, '2b': INV, '2c': INV, '2d': INV,
    '3a': NYP, '3b': NYP, '3c': NYP, '3d': NYP,
  },
  '4137 Milton': {
    '1a': D,   '1b': D,   '1c': DI,  '1d': D,   '1e': D,
    '2a': INV, '2b': INV, '2c': D,   '2d': OP,
    '3a': NYP, '3b': OP,  '3c': NYP, '3d': NYP,
  },
  '2589 N Raymond Ave': {
    '1a': D,   '1b': D,   '1c': DI,  '1d': NA,  '1e': NYP,
    '2a': DI,  '2b': D,   '2c': DI,  '2d': OP,
    '3a': D,   '3b': NYP, '3c': NYP, '3d': NYP,
  },
  '2577 N Raymond Ave ADU': {
    '1a': D,   '1b': D,   '1c': DI,  '1d': D,   '1e': NA,
    '2a': DI,  '2b': DI,  '2c': DI,  '2d': D,
    '3a': D,   '3b': D,   '3c': NYP, '3d': NYP,
  },
  '17810 Norwalk Blvd, Artesia': {
    '1a': NYP, '1b': NYP, '1c': INV, '1d': NYP, '1e': NYP,
    '2a': NYP, '2b': NYP, '2c': NYP, '2d': NYP,
    '3a': NYP, '3b': NYP, '3c': NYP, '3d': NYP,
  },
  '12012 S La Cienega Blvd': {
    '1a': D,   '1b': D,   '1c': D,   '1d': D,   '1e': D,
    '2a': D,   '2b': D,   '2c': D,   '2d': D,
    '3a': D,   '3b': D,   '3c': D,   '3d': D,
  },
};

async function run() {
  for (const [address, items] of Object.entries(UPDATES)) {
    const { rows: [p] } = await pool.query('SELECT id FROM projects WHERE address=$1', [address]);
    if (!p) { console.log('Not found:', address); continue; }
    for (const [code, status] of Object.entries(items)) {
      await pool.query(
        `UPDATE project_items SET status=$1 WHERE project_id=$2 AND item_code=$3`,
        [status, p.id, code]
      );
    }
    console.log('Updated:', address);
  }
  console.log('Done!');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
