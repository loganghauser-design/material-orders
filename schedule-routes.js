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
module.exports = function ({ app, pool, requireAuth, fetchScheduleValues, syncProjectExpected, bustExpSync, getSheetsClient, codeNames }) {

  // Canonical category labels ("1a. Doors" ... "3e. Shower Doors") for the
  // category picker on uncategorized rows.
  const CATEGORY_LABELS = Object.keys(codeNames || {}).sort().map(c => c + '. ' + codeNames[c]);

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
      'SELECT id, COALESCE(full_address, address) AS address, finish_schedule_url, schedule_sheet_backup, schedule_model FROM projects WHERE id=$1', [id]);
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
      // Catalog feeds the prod-code picker: choosing a code fills brand/model/
      // supplier the way the sheet's lookup formulas used to.
      const { rows: catalog } = await pool.query(
        'SELECT prod_code, product_name FROM item_catalog WHERE prod_code IS NOT NULL ORDER BY prod_code LIMIT 1000');
      res.render('schedule-editor', {
        proj, dbMode, rows, loadError,
        items: itemCount(values),
        templates, catalog,
        categories: CATEGORY_LABELS,
        nysOnly: req.query.nys === '1',
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
      // Rows 0-2 and 4 are the sheet's title/labels; row 3 is the layout /
      // build-type selection and IS a per-project choice, so it stays editable.
      if (pos < HEADER_ROWS && pos !== 3) return res.json({ ok: false, error: 'Header rows are locked.' });
      const set = (req.body && req.body.set) || {};
      const idxs = Object.keys(set).map(Number);
      if (!idxs.length || idxs.some(i => !Number.isInteger(i) || i < 0 || i > 18)) {
        return res.status(400).json({ ok: false, error: 'set must map column indexes 0–18 to values' });
      }
      const out = await inTx(async client => {
        const { rows: [r] } = await client.query(
          'SELECT cells FROM project_schedule_rows WHERE project_id=$1 AND pos=$2 FOR UPDATE', [projectId, pos]);
        if (!r) throw new Error('No such row');
        const c = cleanCells(r.cells);
        for (const i of idxs) { while (c.length <= i) c.push(''); c[i] = String(set[i] == null ? '' : set[i]).slice(0, 500); }
        // Prod code changed → fill the row from the catalog, replacing the sheet's
        // old lookup formulas: category, brand, product, model, finish, supplier.
        // A code the catalog doesn't know leaves the other columns alone (custom item).
        let filled = false;
        if (idxs.includes(2)) {
          const code = String(c[2] || '').trim();
          if (code && !/^(not yet selected|nys)$/i.test(code)) {
            const { rows: [cat] } = await client.query(
              'SELECT prod_code, category_code, brand, product_name, model_no, finish, supplier FROM item_catalog WHERE prod_code=$1', [code]);
            if (cat) {
              const put = (i, v) => { while (c.length <= i) c.push(''); c[i] = String(v == null ? '' : v).slice(0, 500); };
              c[2] = cat.prod_code;
              if (cat.category_code) put(4, cat.category_code + '.');
              put(5, cat.brand || ''); put(6, cat.product_name || ''); put(7, cat.model_no || '');
              if (cat.finish) put(8, cat.finish);
              put(14, cat.supplier || '');
              for (const i of [10, 11, 12, 13]) if (/^#N\/A$/i.test(String(c[i] || '').trim())) c[i] = '';
              if (/^(nys|not yet selected)$/i.test(String(c[9] || '').trim()) || !String(c[9] || '').trim()) c[9] = '1';
              filled = true;
            }
          }
        }
        await client.query('UPDATE project_schedule_rows SET cells=$1::jsonb WHERE project_id=$2 AND pos=$3',
          [JSON.stringify(c), projectId, pos]);
        return { cells: c, filled };
      });
      res.json({ ok: true, cells: out.cells, filled: out.filled, resynced: await resync(projectId) });
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
      // Accept either a template id (editor picker) or a name (project-page Model dropdown).
      const templateId = parseInt((req.body && req.body.templateId), 10);
      const byName = String((req.body && req.body.name) || '').trim();
      let tpl;
      if (Number.isInteger(templateId)) ({ rows: [tpl] } = await pool.query('SELECT id, name FROM schedule_templates WHERE id=$1', [templateId]));
      else if (byName) ({ rows: [tpl] } = await pool.query('SELECT id, name FROM schedule_templates WHERE name=$1', [byName]));
      else return res.json({ ok: false, error: 'Pick a template.' });
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
        await client.query('UPDATE projects SET schedule_sheet_backup=$1, finish_schedule_url=$2, schedule_model=$3 WHERE id=$4',
          [backup || null, DB_URL(proj.id), tpl.name, proj.id]);
      });
      res.json({ ok: true, template: tpl.name, rows: values.length, resynced: await resync(proj.id) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Setup wizard: new projects land here after creation ────────────────────
  // Step 1 asks the ADU model and populates the schedule from that model's
  // template; the following steps walk the sourcing choices one at a time.
  // Every answer posts to the same routes the project-page dropdowns use, so
  // the wizard can be re-run or abandoned at any point with no special state.
  app.get('/projects/:id/setup', requireAuth, async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    try {
      const { rows: [proj] } = await pool.query(
        `SELECT id, COALESCE(full_address, address) AS address, schedule_model, finish_schedule_url,
                fixture_package, laundry_unit, rec_lighting_source, range_hood_source,
                bifold_source, sliding_door_source, jedco_source
         FROM projects WHERE id=$1`, [req.params.id]);
      if (!proj) return res.status(404).send('No such project');
      const { rows: templates } = await pool.query(
        'SELECT t.id, t.name, count(r.id)::int AS rows FROM schedule_templates t LEFT JOIN schedule_template_rows r ON r.template_id = t.id GROUP BY t.id, t.name ORDER BY t.name');
      res.render('project-setup', { proj, templates });
    } catch (err) { res.status(500).send(err.message); }
  });

  // ── Template list as JSON — feeds the Model dropdown on the project page ───
  app.get('/schedule-templates', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT t.id, t.name, count(r.id)::int AS rows FROM schedule_templates t LEFT JOIN schedule_template_rows r ON r.template_id = t.id GROUP BY t.id, t.name ORDER BY t.name');
      res.json({ ok: true, templates: rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Scope & selections: the sales-deck choices, per project ────────────────
  // View mode is a clean read of each line's current pick; "Edit scope" reveals
  // a pencil per line, and the pencil opens a dropdown of that line's options.
  app.get('/projects/:id/selections', requireAuth, async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    try {
      const proj = await getProject(req.params.id);
      if (!proj) return res.status(404).send('No such project');
      const { rows: slots } = await pool.query(
        'SELECT key, section, label, input_type, options, sort FROM selection_slots ORDER BY sort, id');
      const { rows: vals } = await pool.query(
        'SELECT slot_key, value FROM project_selections WHERE project_id=$1', [proj.id]);
      const values = {}; vals.forEach(v => { values[v.slot_key] = v.value; });
      res.render('project-selections', { proj, slots, values });
    } catch (err) { res.status(500).send(err.message); }
  });

  // Slots + this project's values as JSON — feeds the shared scope panel.
  app.get('/projects/:id/selections.json', requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.id;
      if (!Number.isInteger(projectId)) return res.status(400).json({ ok: false, error: 'Bad id' });
      const { rows: slots } = await pool.query(
        'SELECT key, section, label, input_type, options, upgrades, sort FROM selection_slots ORDER BY sort, id');
      const { rows: vals } = await pool.query(
        'SELECT slot_key, value FROM project_selections WHERE project_id=$1', [projectId]);
      const values = {}; vals.forEach(v => { values[v.slot_key] = v.value; });
      // Model-aware sections: "Bathroom N" only shows when the project's model
      // has at least N bathrooms (M1 = 1, M2B = 2). Unknown model or unset
      // bathroom count -> show everything rather than hide something real.
      let visible = slots, model = null, bathrooms = null;
      const { rows: [pj] } = await pool.query('SELECT schedule_model FROM projects WHERE id=$1', [projectId]);
      if (pj && pj.schedule_model) {
        model = pj.schedule_model;
        const { rows: [tpl] } = await pool.query('SELECT bathrooms FROM schedule_templates WHERE name=$1', [model]);
        if (tpl && Number.isInteger(tpl.bathrooms)) {
          bathrooms = tpl.bathrooms;
          visible = slots.filter(s => {
            const m = String(s.section || '').match(/^bathroom\s*(\d+)/i);
            return !m || (+m[1] <= bathrooms);
          });
        }
      }
      res.json({ ok: true, slots: visible, values, model, bathrooms });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/projects/:id/selections/set', requireAuth, async (req, res) => {
    try {
      const projectId = +req.params.id;
      const key = String((req.body && req.body.key) || '').trim();
      const value = String((req.body && req.body.value) == null ? '' : req.body.value).slice(0, 2000);
      if (!Number.isInteger(projectId) || !key) return res.status(400).json({ ok: false, error: 'Missing key' });
      const { rows: [slot] } = await pool.query('SELECT key FROM selection_slots WHERE key=$1', [key]);
      if (!slot) return res.status(404).json({ ok: false, error: 'No such line' });
      await pool.query(
        `INSERT INTO project_selections (project_id, slot_key, value, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (project_id, slot_key) DO UPDATE SET value=$3, updated_at=NOW()`, [projectId, key, value]);
      // Patio Door drives the sliding-door sourcing: a trifold ships from
      // Buildoly stock; a sliding glass door is always vendor-supplied (Ganahl).
      let slidingSource = null;
      if (key === 'finishes-patio-door') {
        if (/tri-?fold/i.test(value)) slidingSource = 'buildoly';
        else if (/sliding/i.test(value)) slidingSource = 'vendor';
        if (slidingSource) await pool.query('UPDATE projects SET sliding_door_source=$1 WHERE id=$2', [slidingSource, projectId]);
      }
      res.json({ ok: true, key, value, slidingSource: slidingSource || undefined });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Add one choice to a line's dropdown (global — every project sees it).
  app.post('/selections/slots/add-option', requireAuth, async (req, res) => {
    try {
      const key = String((req.body && req.body.key) || '').trim();
      const option = String((req.body && req.body.option) || '').trim().slice(0, 200);
      if (!key || !option) return res.status(400).json({ ok: false, error: 'Missing key or option' });
      const { rows: [slot] } = await pool.query('SELECT options, upgrades FROM selection_slots WHERE key=$1', [key]);
      if (!slot) return res.status(404).json({ ok: false, error: 'No such line' });
      const opts = Array.isArray(slot.options) ? slot.options.slice() : [];
      if (!opts.some(o => String(o).toLowerCase() === option.toLowerCase())) opts.push(option);
      let ups = Array.isArray(slot.upgrades) ? slot.upgrades.slice() : [];
      if (req.body && req.body.upgrade && !ups.some(u => String(u).toLowerCase() === option.toLowerCase())) ups.push(option);
      await pool.query('UPDATE selection_slots SET options=$1::jsonb, upgrades=$2::jsonb WHERE key=$3',
        [JSON.stringify(opts), JSON.stringify(ups), key]);
      res.json({ ok: true, options: opts, upgrades: ups });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Flag / unflag one of a line's options as an upgrade (global, all projects).
  app.post('/selections/slots/toggle-upgrade', requireAuth, async (req, res) => {
    try {
      const key = String((req.body && req.body.key) || '').trim();
      const option = String((req.body && req.body.option) || '').trim();
      const upgrade = !!(req.body && req.body.upgrade);
      if (!key || !option) return res.status(400).json({ ok: false, error: 'Missing key or option' });
      const { rows: [slot] } = await pool.query('SELECT upgrades FROM selection_slots WHERE key=$1', [key]);
      if (!slot) return res.status(404).json({ ok: false, error: 'No such line' });
      let ups = (Array.isArray(slot.upgrades) ? slot.upgrades : []).filter(u => String(u).toLowerCase() !== option.toLowerCase());
      if (upgrade) ups.push(option);
      await pool.query('UPDATE selection_slots SET upgrades=$1::jsonb WHERE key=$2', [JSON.stringify(ups), key]);
      res.json({ ok: true, upgrades: ups });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Add a whole new line to a section (starts with an empty dropdown).
  app.post('/selections/slots/add', requireAuth, async (req, res) => {
    try {
      const section = String((req.body && req.body.section) || '').trim().slice(0, 60);
      const label = String((req.body && req.body.label) || '').trim().slice(0, 80);
      if (!section || !label) return res.status(400).json({ ok: false, error: 'Missing section or label' });
      const key = (section + ' ' + label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      const { rows: [mx] } = await pool.query('SELECT COALESCE(MAX(sort),0) AS m FROM selection_slots WHERE section=$1', [section]);
      await pool.query(
        `INSERT INTO selection_slots (key, section, label, input_type, options, sort)
         VALUES ($1,$2,$3,'dropdown','[]'::jsonb,$4) ON CONFLICT (key) DO NOTHING`,
        [key, section, label, (+mx.m || 0) + 1]);
      res.json({ ok: true, key });
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
