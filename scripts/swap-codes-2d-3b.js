// One-off migration: swap material codes 2d <-> 3b in all stored data so existing
// records line up with the renumbered stages (Fs.Plumb/Light/Hood 3b->2d, Appliances 2d->3b).
//   railway run node scripts/swap-codes-2d-3b.js          (dry run — counts only)
//   railway run node scripts/swap-codes-2d-3b.js apply     (performs the swap in a transaction)
const { pool } = require('../server.js');

const TABLES = ['project_items', 'suppliers', 'vendor_emails'];
const APPLY = process.argv[2] === 'apply';
const TMP = '__swap_tmp';

(async () => {
  console.log(APPLY ? '=== APPLYING swap 2d <-> 3b ===' : '=== DRY RUN ===');
  for (const t of TABLES) {
    const { rows } = await pool.query(
      `SELECT item_code, COUNT(*)::int AS n FROM ${t} WHERE item_code IN ('2d','3b') GROUP BY item_code ORDER BY item_code`
    );
    const summary = rows.map(r => `${r.item_code}:${r.n}`).join('  ') || '(none)';
    console.log(`  ${t}: ${summary}`);
  }

  if (!APPLY) { console.log('\nDry run only — re-run with "apply" to perform the swap.'); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of TABLES) {
      await client.query(`UPDATE ${t} SET item_code=$1 WHERE item_code='2d'`, [TMP]);
      await client.query(`UPDATE ${t} SET item_code='2d' WHERE item_code='3b'`);
      await client.query(`UPDATE ${t} SET item_code='3b' WHERE item_code=$1`, [TMP]);
    }
    await client.query('COMMIT');
    console.log('\nSwap committed.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
