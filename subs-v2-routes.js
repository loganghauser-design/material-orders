'use strict';
// ── Subs v2: server-paged contractor list ───────────────────────────────────
// The original /subs renders all 550 contractors, every email log and eight
// modals into one ~5MB page. Here the database does the filtering, sorting and
// paging, so the browser only ever receives the rows actually on screen.
// Kept in its own module so the rebuild can't destabilise server.js.

const SORTS = {
  company: 'LOWER(COALESCE(s.company, s.owner))',
  trade:   "LOWER(COALESCE(s.type,'zzz'))",
  area:    "LOWER(COALESCE(s.location,'zzz'))",
  stage:   "CASE COALESCE(s.bid_status,'') WHEN 'Bid Received' THEN 1 WHEN 'Rate quoted' THEN 2 WHEN 'Bid Sent' THEN 3 WHEN 'Intake' THEN 4 WHEN 'Declined' THEN 5 ELSE 6 END",
  bid:     "NULLIF(REGEXP_REPLACE(COALESCE(s.bid_price,''), '[^0-9.]', '', 'g'), '')::numeric",
  recent:  's.id',
};
// filter key -> SQL predicate. Whitelisted; user input is never interpolated.
const FILTERS = {
  all:       'TRUE',
  sub:       "COALESCE(s.category,'sub') <> 'gc'",
  gc:        "s.category = 'gc'",
  bidin:     "s.bid_status = 'Bid Received'",
  unread:    's.reply_unread = true',
  noemail:   "COALESCE(TRIM(s.email),'') = ''",
  nocontact: "COALESCE(s.bid_status,'') = ''",
  declined:  "s.bid_status = 'Declined'",
  flagged:   "COALESCE(s.status,'') ~* 'reject|black'",
};

function buildWhere(filter, q, params) {
  const f = FILTERS[filter] ? filter : 'all';
  const parts = [];
  // Rejected/blacklisted stay out of every view except the one that asks for them.
  if (f !== 'flagged') parts.push("COALESCE(s.status,'') !~* 'reject|black'");
  parts.push(FILTERS[f]);
  if (q) {
    params.push('%' + q.toLowerCase() + '%');
    const i = '$' + params.length;
    parts.push('(LOWER(COALESCE(s.company,\'\')) LIKE ' + i
      + ' OR LOWER(COALESCE(s.owner,\'\')) LIKE ' + i
      + ' OR LOWER(COALESCE(s.email,\'\')) LIKE ' + i
      + ' OR LOWER(COALESCE(s.type,\'\')) LIKE ' + i
      + ' OR LOWER(COALESCE(s.location,\'\')) LIKE ' + i
      + ' OR COALESCE(s.license_number,\'\') LIKE ' + i + ')');
  }
  return parts.join(' AND ');
}

module.exports = function mountSubsV2(ctx) {
  const { app, pool, requireAuth, initDb } = ctx;

  async function counts() {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int total,'
      + " COUNT(*) FILTER (WHERE s.bid_status='Bid Sent')::int contacted,"
      + " COUNT(*) FILTER (WHERE COALESCE(s.status,'')='Bid Under Review')::int replied,"
      + " COUNT(*) FILTER (WHERE s.bid_status='Bid Received')::int bidin,"
      + " COUNT(*) FILTER (WHERE s.bid_status='Declined')::int declined,"
      + " COUNT(*) FILTER (WHERE COALESCE(s.bid_status,'')='')::int nocontact,"
      + " COUNT(*) FILTER (WHERE COALESCE(s.category,'sub') <> 'gc')::int subs,"
      + " COUNT(*) FILTER (WHERE s.category='gc')::int gcs,"
      + ' COUNT(*) FILTER (WHERE s.reply_unread)::int unread,'
      + " COUNT(*) FILTER (WHERE COALESCE(TRIM(s.email),'')='')::int noemail,"
      + " COUNT(*) FILTER (WHERE COALESCE(s.status,'') ~* 'reject|black')::int flagged"
      + ' FROM subcontractors s');
    return rows[0];
  }

  app.get('/subs/v2', requireAuth, async (req, res) => {
    try {
      await initDb();
      res.render('subs-v2', { counts: await counts(), isSuper: req.session.role === 'super' });
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  app.get('/subs/v2/rows', requireAuth, async (req, res) => {
    try {
      const page = Math.max(0, parseInt(req.query.page, 10) || 0);
      const size = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 30));
      const sortKey = SORTS[req.query.sort] ? req.query.sort : 'company';
      const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      const q = String(req.query.q || '').trim();
      const params = [];
      const where = buildWhere(String(req.query.filter || 'all'), q, params);
      const totalRes = await pool.query('SELECT COUNT(*)::int n FROM subcontractors s WHERE ' + where, params);
      params.push(size, page * size);
      const { rows } = await pool.query(
        'SELECT s.id, s.company, s.owner, s.email, s.phone, s.type, s.location, s.category,'
        + ' s.status, s.bid_status, s.bid_price, s.license_number, s.reply_unread, s.recent_add,'
        + ' (SELECT MAX(e.created_at) FROM sub_emails e WHERE e.sub_id = s.id) AS last_at,'
        + " (SELECT COUNT(*) FROM sub_emails e WHERE e.sub_id = s.id AND e.direction='in')::int replies"
        + ' FROM subcontractors s WHERE ' + where
        + ' ORDER BY ' + SORTS[sortKey] + ' ' + dir + ' NULLS LAST, s.id'
        + ' LIMIT $' + (params.length - 1) + ' OFFSET $' + params.length, params);
      res.json({ ok: true, rows, total: totalRes.rows[0].n, page, size, counts: await counts() });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // One contractor's detail — fetched only when a row is opened, never up front.
  app.get('/subs/v2/sub/:id', requireAuth, async (req, res) => {
    try {
      const { rows: subRows } = await pool.query('SELECT * FROM subcontractors WHERE id=$1', [req.params.id]);
      const sub = subRows[0];
      if (!sub) return res.status(404).json({ ok: false, error: 'Not found' });
      const { rows: emails } = await pool.query(
        "SELECT id, subject, direction, reply_kind, created_at, LEFT(COALESCE(body,''), 400) AS body"
        + ' FROM sub_emails WHERE sub_id=$1 ORDER BY created_at DESC LIMIT 12', [sub.id]);
      const { rows: bids } = await pool.query(
        'SELECT amount, received_at, filename FROM bids WHERE sub_id=$1 AND amount>0 ORDER BY received_at DESC LIMIT 6', [sub.id]);
      res.json({ ok: true, sub, emails, bids });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
};
