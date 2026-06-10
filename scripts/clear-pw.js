const { pool, initDb } = require('../server.js');
(async () => {
  await initDb();
  const r = await pool.query('DELETE FROM super_passwords');
  console.log('Cleared ' + r.rowCount + ' custom super password(s) — all now use the default (buildoly).');
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
