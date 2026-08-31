// Finish schedules stored IN Buildoly (Postgres) instead of a Google Sheet.
//
// How it stays safe: nothing here runs for a project unless its
// finish_schedule_url is explicitly flipped to db://project/<id> by the import
// button. Every project still pointing at a sheet URL takes the exact same code
// path it did yesterday. The stored rows are a verbatim snapshot of the sheet's
// A..S cells (headers included), so fetchScheduleValues serves an identical
// shape either way and every consumer — vendor orders, materials drill-down,
// held stock, expected-items sync — is none the wiser. Revert is one click:
// the original sheet link is kept in projects.schedule_sheet_backup.
//
// Kept out of server.js for the same reason as subs-v2-routes: a bug in the new
// surface can't destabilise the live paths.
module.exports = function ({ app, pool, requireAuth, fetchScheduleValues, syncProjectExpected, bustExpSync, getSheetsClient }) {

  // The master template sheet: one "Fin Sched - <MODEL>" tab per model.
  // Summary/Order/Archive tabs are not schedules (0 item rows) and are skipped.
  const TEMPLATE_SHEET_ID = '1Uvwx29EdQeptcE77icLtnWnpsqFKLyCbSSJvamLVZVU';
  const TEMPLATE_TAB_IGNORE = /project summary|^fin sched$|order|archive/i;

  const DB_URL = id => 'db://project/' + id;
  const isDbUrl = u => /^db:\/\/project\/\d+$/.test(String(u || ''));
  const CATRE = /^(1[a-e]|2[a-e]|3[a-e])\b/i;              // same test every consumer uses
  const ROOMRE = /\s-\s[A-Za-z]{1,4}\d*\s*$/;              // room header, e.g. "Bath 1 - BA"
  const HEADER_ROWS = 5;                                    // consumers read items from row index 5 on

  const cleanCells = a => (Array.isArray(a) ? a : []).map(c => String(c == null ? '' : c).slice(0, 500)).slice(0, 19);
  const itemCount = values => (values || []).filter(v => v && CATRE.test(String(v[4] || '').trim())).length;
  function classify(cells, pos) {
    if (pos < HEADER_ROWS) return 'header';
    if (CATRE.test(String((cells || [])[4] || '').trim())) return 'item';
    const c0 = String((cells || [])[0] || '').replace(/\n/g, ' ').trim();
    if (c0 && ROOMRE.test(c0)) return 'section';
    return 'other';
  }

  async function getProject(id) {
    const { rows: [p] } = await pool.query(
      'SELECT id, COALESCE(full_address, address) AS address, finish_schedule_url, schedule_sheet_backup FROM projects WHERE id=$1', [id]);
    return p || null;
  }
  // Wholesale replace of a project's stored rows, inside the caller's transaction.
  async function replaceRows(client, table, keyCol, keyVal, values) {
    await client.query('DELETE FROM ' + table + (keyCol ? ' WHERE ' + keyCol + '=$1' : ''), keyCol ? [keyVal] : []);
    for (let i = 0; i < values.length; i++) {
      const cells = JSON.stringify(cleanCells(values[i]));
      if (keyCol) await client.query('INSERT INTO ' + table + ' (' + keyCol + ', pos, cells) VALUES ($1,$2,$3::jsonb)', [keyVal, i, cells]);
      else await client.query('INSERT INTO ' + table + ' (pos, cells) VALUES ($1,$2::jsonb)', [i, cells]);
    }
  }
  async function inTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
    catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async function resync(projectId) {
    bustExpSync(projectId);
    const r = await syncProjectExpected(projectId).catch(e => ({ ok: false, error: e.message }));
    return !!(r && r.ok);
  }

  // ── Editor page ────────────────────────────────────────────────────────────
  app.get('/projects/:id/schedule', requireAuth, async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    try {
      const proj = await getProject(req.params.id);
      if (!proj) return res.status(404).send('No such project');
      const dbMode = isDbUrl(proj.finish_schedule_url);
      let values = [], loadError = null;
      try { values = await fetchScheduleValues(proj.finish_schedule_url); } catch (e) { loadError = e.message; }
      const rows = (values || []).map((cells, pos) => ({ pos, cells: cells || [], kind: classify(cells, pos) }));
      const { rows: templates } = await pool.query(
        'SELECT t.id, t.name, count(r.id)::int AS rows FROM schedule_templates t LEFT JOIN schedule_template_rows r ON r.template_id = t.id GROUP BY t.id, t.name ORDER BY t.name');
      res.render('schedule-editor', {
        proj, dbMode, rows, loadError,
        items: itemCount(values),
        templates,
        sheetUrl: dbMode ? (proj.schedule_sheet_backup || '') : (proj.finish_schedule_url || ''),
      });
    } catch (err) { res.status(500).send(err.message); }
  });

  // ── Import: snapshot the sheet into Postgres and flip the project over ─────
  app.post('/projects/:id/schedule/import-from-sheet', requireAuth, async (req, res) => {
    try {
      const proj = await getProject(req.params.id);
      if (!proj) return res.status(404).json({ ok: false, error: 'No such project' });
      const sheetUrl = isDbUrl(proj.finish_schedule_url) ? proj.schedule_sheet_backup : proj.finish_schedule_url;
      if (!sheetUrl) return res.json({ ok: false, error: 'No sheet link on this project to import from.' });
      const values = await fetchScheduleValues(sheetUrl);
      const items = itemCount(values);
      // Same guard syncProjectExpected uses: never replace a schedule with nothing.
      if (!items) return res.json({ ok: false, error: 'Sheet parsed to 0 items — nothing imported.' });
      await inTx(async client => {
        await replaceRows(client, 'project_schedule_rows', 'project_id', proj.id, values);
        await client.query('UPDATE projects SET schedule_sheet_backup=$1, finish_schedule_url=$2 WHERE id=$3',
          [sheetUrl, DB_URL(proj.id), proj.id]);
      });
      res.json({ ok: true, rows: values.length, items, resynced: await resync(proj.id) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Revert: point the project back at its sheet. Stored rows are kept. ─────
  app.post('/projects/:id/schedule/revert-to-sheet', requireAuth, async (req, res) => {
    try {
      const proj = await getProject(req.params.id);
      if (!proj) return res.status(404).json({ ok: false, error: 'No such project' });
      if (!isDbUrl(proj.finish_schedule_url)) return res.json({ ok: false, error: 'Project is already reading from its sheet.' });
      if (!proj.schedule_sheet_backup) return res.json({ ok: false, error: 'No saved sheet link to revert to.' });
      await pool.query('UPDATE projects SET finish_schedule_url=$1 WHERE id=$2', [proj.schedule_sheet_backup, proj.id]);
      res.json({ ok: true, url: proj.schedule_sheet_backup, resynced: await resync(proj.id) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Edit one row's cells: {set: {"0": "Name", "9": "2"}} merges by index ───
  app.post('/projects/:id/schedule/row/:pos', requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.id, pos = +req.params.pos;
      if (!Number.isInteger(projectId) || !Number.isInteger(pos)) return res.status(400).json({ ok: false, error: 'Bad ids' });
      const proj = await getProject(projectId);
      if (!proj) return res.status(404).json({ ok: false, error: 'No such project' });
      if (!isDbUrl(proj.finish_schedule_url)) return res.json({ ok: false, error: 'Project is reading from the sheet — import it into Buildoly first.' });
      if (pos < HEADER_ROWS) return res.json({ ok: false, error: 'Header rows are locked.' });
      const set = (req.body && req.body.set) || {};
      const idxs = Object.keys(set).map(Number);
      if (!idxs.length || idxs.some(i => !Number.isInteger(i) || i < 0 || i > 18)) {
        return res.status(400).json({ ok: false, error: 'set must map column indexes 0–18 to values' });
      }
      const cells = await inTx(async client => {
        const { rows: [r] } = await client.query(
          'SELECT cells FROM project_schedule_rows WHERE project_id=$1 AND pos=$2 FOR UPDATE', [projectId, pos]);
        if (!r) throw new Error('No such row');
        const c = cleanCells(r.cells);
        for (const i of idxs) { while (c.length <= i) c.push(''); c[i] = String(set[i] == null ? '' : set[i]).slice(0, 500); }
        await client.query('UPDATE project_schedule_rows SET cells=$1::jsonb WHERE project_id=$2 AND pos=$3',
          [JSON.stringify(c), projectId, pos]);
        return c;
      });
      res.json({ ok: true, cells, resynced: await resync(projectId) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Insert a row after `afterPos` (blank, or prefilled from the catalog) ───
  app.post('/projects/:id/schedule/rows/insert', requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.id;
      const proj = await getProject(projectId);
      if (!proj) return res.status(404).json({ ok: false, error: 'No such project' });
      if (!isDbUrl(proj.finish_schedule_url)) return res.json({ ok: false, error: 'Project is reading from the sheet — import it into Buildoly first.' });
      const afterPos = Math.max(HEADER_ROWS - 1, parseInt((req.body && req.body.afterPos), 10) || 0);
      let cells = cleanCells((req.body && req.body.cells) || []);
      const prodCode = String((req.body && req.body.prodCode) || '').trim();
      if (prodCode) {
        const { rows: [c] } = await pool.query(
          'SELECT prod_code, category_code, brand, product_name, model_no, finish, supplier FROM item_catalog WHERE prod_code=$1', [prodCode]);
        if (!c) return res.json({ ok: false, error: 'No catalog item with code ' + prodCode });
        cells = cleanCells([c.product_name, '', c.prod_code, '', (c.category_code || '') + '.', c.brand, c.product_name, c.model_no, c.finish, '1', '', '', '', '', c.supplier]);
      }
      const pos = await inTx(async client => {
        // Two-step renumber keeps the (project_id, pos) UNIQUE constraint happy.
        await client.query('UPDATE project_schedule_rows SET pos = -(pos + 1) WHERE project_id=$1 AND pos > $2', [projectId, afterPos]);
        await client.query('UPDATE project_schedule_rows SET pos = -pos WHERE project_id=$1 AND pos < 0', [projectId]);
        const p = afterPos + 1;
        await client.query('INSERT INTO project_schedule_rows (project_id, pos, cells) VALUES ($1,$2,$3::jsonb)',
          [projectId, p, JSON.stringify(cells)]);
        return p;
      });
      res.json({ ok: true, pos, resynced: await resync(projectId) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Delete a row ───────────────────────────────────────────────────────────
  app.post('/projects/:id/schedule/rows/delete', requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.id;
      const pos = parseInt((req.body && req.body.pos), 10);
      const proj = await getProject(projectId);
      if (!proj) return res.status(404).json({ ok: false, error: 'No such project' });
      if (!isDbUrl(proj.finish_schedule_url)) return res.json({ ok: false, error: 'Project is reading from the sheet — import it into Buildoly first.' });
      if (!Number.isInteger(pos) || pos < HEADER_ROWS) return res.json({ ok: false, error: 'Header rows are locked.' });
      await inTx(async client => {
        const del = await client.query('DELETE FROM project_schedule_rows WHERE project_id=$1 AND pos=$2', [projectId, pos]);
        if (!del.rowCount) throw new Error('No such row');
        await client.query('UPDATE project_schedule_rows SET pos = -(pos - 1) WHERE project_id=$1 AND pos > $2', [projectId, pos]);
        await client.query('UPDATE project_schedule_rows SET pos = -pos WHERE project_id=$1 AND pos < 0', [projectId]);
      });
      res.json({ ok: true, resynced: await resync(projectId) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Save this project's stored schedule as a NAMED template ────────────────
  app.post('/projects/:id/schedule/save-as-template', requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.id;
      const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
      if (!name) return res.json({ ok: false, error: 'Template needs a name (e.g. M2, M3+).' });
      const { rows } = await pool.query('SELECT pos, cells FROM project_schedule_rows WHERE project_id=$1 ORDER BY pos', [projectId]);
      if (!rows.length) return res.json({ ok: false, error: 'This project has no stored schedule — import it first.' });
      const values = []; rows.forEach(r => { values[r.pos] = r.cells; });
      for (let i = 0; i < values.length; i++) if (!values[i]) values[i] = [];
      if (!itemCount(values)) return res.json({ ok: false, error: 'Stored schedule has 0 items — refusing to save it as a template.' });
      await inTx(async client => {
        const { rows: [t] } = await client.query(
          'INSERT INTO schedule_templates (name, source_tab, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (name) DO UPDATE SET source_tab=$2, updated_at=NOW() RETURNING id',
          [name, 'project:' + projectId]);
        await replaceRows(client, 'schedule_template_rows', 'template_id', t.id, values);
      });
      res.json({ ok: true, name, rows: values.length, items: itemCount(values) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Start a project from a named template ──────────────────────────────────
  app.post('/projects/:id/schedule/load-template', requireAuth, async (req, res) => {
    try {
      const proj = await getProject(+req.params.id);
      if (!proj) return res.status(404).json({ ok: false, error: 'No such project' });
      const templateId = parseInt((req.body && req.body.templateId), 10);
      if (!Number.isInteger(templateId)) return res.json({ ok: false, error: 'Pick a template.' });
      const { rows: [tpl] } = await pool.query('SELECT id, name FROM schedule_templates WHERE id=$1', [templateId]);
      if (!tpl) return res.json({ ok: false, error: 'No such template.' });
      const { rows } = await pool.query('SELECT pos, cells FROM schedule_template_rows WHERE template_id=$1 ORDER BY pos', [tpl.id]);
      if (!rows.length) return res.json({ ok: false, error: 'Template "' + tpl.name + '" has no rows.' });
      const { rows: [have] } = await pool.query('SELECT count(*)::int AS n FROM project_schedule_rows WHERE project_id=$1', [proj.id]);
      if (have.n && !(req.body && req.body.overwrite)) {
        return res.json({ ok: false, error: 'This project already has a stored schedule (' + have.n + ' rows). Pass overwrite to replace it.' });
      }
      const values = []; rows.forEach(r => { values[r.pos] = r.cells; });
      for (let i = 0; i < values.length; i++) if (!values[i]) values[i] = [];
      await inTx(async client => {
        await replaceRows(client, 'project_schedule_rows', 'project_id', proj.id, values);
        const backup = isDbUrl(proj.finish_schedule_url) ? proj.schedule_sheet_backup : proj.finish_schedule_url;
        await client.query('UPDATE projects SET schedule_sheet_backup=$1, finish_schedule_url=$2 WHERE id=$3',
          [backup || null, DB_URL(proj.id), proj.id]);
      });
      res.json({ ok: true, template: tpl.name, rows: values.length, resynced: await resync(proj.id) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Sync all model templates from the master template sheet ────────────────
  // One template per "Fin Sched - <MODEL>" tab, named after the model. Re-running
  // replaces same-named templates; each tab imports in its own transaction so one
  // bad tab can't take the rest down. Project schedules are never touched.
  app.post('/schedule-templates/sync', requireAuth, async (req, res) => {
    try {
      const sheets = getSheetsClient && getSheetsClient();
      if (!sheets) return res.json({ ok: false, error: 'Google Sheets access is not configured on the server.' });
      const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId: TEMPLATE_SHEET_ID });
      const results = [];
      for (const s of meta.sheets || []) {
        const title = String(s.properties.title || '').trim();
        if (TEMPLATE_TAB_IGNORE.test(title)) continue;
        const name = title.replace(/^fin\s*sched\s*-\s*/i, '').trim() || title;
        try {
          const { data } = await sheets.spreadsheets.values.get({
            spreadsheetId: TEMPLATE_SHEET_ID, range: "'" + title.replace(/'/g, "''") + "'!A1:S400" });
          const values = data.values || [];
          const items = itemCount(values);
          if (!items) { results.push({ name, skipped: '0 items' }); continue; }
          await inTx(async client => {
            const { rows: [t] } = await client.query(
              'INSERT INTO schedule_templates (name, source_tab, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (name) DO UPDATE SET source_tab=$2, updated_at=NOW() RETURNING id',
              [name, title]);
            await replaceRows(client, 'schedule_template_rows', 'template_id', t.id, values);
          });
          results.push({ name, rows: values.length, items });
        } catch (e) { results.push({ name, error: String(e.message || e).slice(0, 120) }); }
      }
      res.json({ ok: true, templates: results });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
};
