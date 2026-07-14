// Local design preview — renders the merged Materials & Delivery tab (views/project.ejs).
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

const STAGES = [
  { name: 'Framing Stage', items: [{ code: '1a', name: 'Doors, Windows' }, { code: '1b', name: 'R. Plumb, Fans' }, { code: '1c', name: 'HVAC Trim' }, { code: '1d', name: 'Tile' }, { code: '1e', name: 'Rec. Light' }] },
  { name: 'Warehouse Outbound', items: [{ code: '2a', name: 'Millwork' }, { code: '2b', name: 'Flooring' }, { code: '2c', name: 'Decking' }, { code: '2d', name: 'Fs. Plumb/Light/Hood' }, { code: '2e', name: 'Water Heater' }] },
  { name: '1 Week after Warehouse Outbound', items: [{ code: '3a', name: 'Countertops' }, { code: '3b', name: 'Appliances' }, { code: '3c', name: 'Cabinet Hardware' }, { code: '3d', name: 'Misc' }, { code: '3e', name: 'Shower Doors' }] },
  { name: 'Roofing', items: [{ code: '4a', name: 'Roofing' }] },
  { name: 'Solar', items: [{ code: '5a', name: 'Solar' }] },
];

app.get('/', (req, res, next) => {
  res.render('project', {
    project: { id: 1, address: '33772 Silver Lantern', version: 'V3', phase: 'Under Construction', overall_status: 'On Track', notes: '', super_email: 'kevin@buildoly.com', bifold_source: null, sliding_door_source: null, rec_lighting_source: null, jedco_source: null, range_hood_source: 'buildoly', client_name: '', client_email: '', full_address: '33772 Silver Lantern St' },
    STAGES,
    itemMap: { '1a': { status: 'Delivered', order_date: '2026-06-20', delivery_date: '2026-06-28' }, '1b': { status: 'Delivered', order_date: '2026-07-01', delivery_date: '2026-07-06', delivery_date_end: '2026-07-06', notes: 'AM window' }, '1c': { status: 'In Inventory' }, '2d': { status: 'Order Placed', order_date: '2026-07-01' }, '3b': { status: 'Order Placed', order_date: '2026-07-01' } },
    requestedByCode: {}, issueByCode: {}, projectIssues: [], projectRequests: [],
    ITEM_STATUSES: ['Not yet placed', 'RFQ sent', 'Order Placed', 'In Inventory', 'Delivered', 'Delivered from Inv.'],
    PROJECT_STATUSES: ['On Track', 'At Risk'], EMAIL_PHASES: [], emailConfigured: true,
    suppliers: { '1b': { supplier_name: 'Ferguson', supplier_email: 'trista@ferguson.com' } },
    documents: [], payments: [], ordersByVendor: {}, itemNames: {}, ordersByCategory: {}, categoryRequestData: {},
    supers: [{ name: 'Kevin Leon', email: 'kevin@buildoly.com', role: 'super' }, { name: 'Bobby Li', email: 'bobby@buildoly.com', role: 'super' }],
    itemsAgg: { '1b': { total: 6, delivered: 4, scheduled: 1, ordered: 1 }, '2d': { total: 12, delivered: 0, scheduled: 0, ordered: 8 }, '3b': { total: 13, delivered: 0, scheduled: 0, ordered: 12 } },
    itemStates: { 'PC:B-SHB02W': { st: 'd' }, 'PC:B-SHD01CP': { st: 's', when: 'Monday, July 6th 2026 between 07:30 AM - 10:30 AM' }, 'PC:B-F02': { st: 'o', m: 1 }, 'PC:KT-S01SS': { st: 'o' } },
    checklistItems: [
      { key: 'PC:B-SHB02W', category_code: '1b', prod_code: 'B-SHB02W', name: 'Shower Base 60x30 RH Acrylic', model_no: 'K-8642-0', qty: 1, supplier: 'Ferguson', delivered: true, scheduled: false, onOrder: false, manual: false, schedWhen: '' },
      { key: 'PC:B-SHD01CP', category_code: '1b', prod_code: 'B-SHD01CP', name: 'Shower Drain w/ Strainer', model_no: 'K-9132-CP', qty: 1, supplier: 'Ferguson', delivered: false, scheduled: true, onOrder: false, manual: false, schedWhen: 'Monday, July 6th 2026 between 07:30 AM - 10:30 AM' },
      { key: 'PC:B-F02', category_code: '1b', prod_code: 'B-F02', name: 'Bath Fan WhisperValue DC', model_no: 'PANFV0510VSC1', qty: 2, supplier: 'Ferguson', delivered: false, scheduled: false, onOrder: true, manual: true, schedWhen: '' },
      { key: 'PC:KT-S01SS', category_code: '1b', prod_code: 'KT-S01SS', name: 'Kitchen Sink SS Undermount', model_no: 'ELGRU13322PD', qty: 1, supplier: 'Ferguson', delivered: false, scheduled: false, onOrder: true, manual: false, schedWhen: '' },
      { key: 'PC:B-WIN01', category_code: '1a', prod_code: 'B-WIN01', name: 'Vinyl Window 3040 SH', model_no: 'MI-1620', qty: 6, supplier: 'Milgard', delivered: true, scheduled: false, onOrder: false, manual: false, schedWhen: '' },
      { key: 'PC:B-DR01', category_code: '1a', prod_code: 'B-DR01', name: 'Interior Door Slab', model_no: '', qty: 8, supplier: 'Buildoly Stock', delivered: false, scheduled: false, onOrder: false, manual: false, schedWhen: '' },
      { key: 'PC:KT-H01', category_code: '2d', prod_code: 'KT-H01', name: 'Range Hood 30" insert', model_no: 'HP30IDCHX4', qty: 1, supplier: 'Buildoly Stock', delivered: false, scheduled: false, onOrder: false, manual: false, schedWhen: '' },
      { key: 'PC:KT-FCT01', category_code: '2d', prod_code: 'KT-FCT01', name: 'Kitchen Faucet Pull-down', model_no: 'K-596-VS', qty: 1, supplier: 'Ferguson', delivered: false, scheduled: false, onOrder: true, manual: false, schedWhen: '' },
      { key: 'PC:AP-RNG01', category_code: '3b', prod_code: 'AP-RNG01', name: '30" Slide-in Range', model_no: 'FGIH3047VF', qty: 1, supplier: 'Ferguson', delivered: false, scheduled: false, onOrder: true, manual: false, schedWhen: '' },
      { key: 'PC:AP-DW01', category_code: '3b', prod_code: 'AP-DW01', name: 'Dishwasher 24"', model_no: 'FFCD2418US', qty: 1, supplier: 'Ferguson', delivered: false, scheduled: false, onOrder: true, manual: false, schedWhen: '' },
      { key: 'NM:MISCUNCATEGORIZED', category_code: '', prod_code: '', name: 'Shipping / handling line', model_no: '', qty: 1, supplier: '', delivered: false, scheduled: false, onOrder: false, manual: false, schedWhen: '' },
    ],
  }, (err, html) => {
    if (err) return next(err);
    res.send(html.replace(/<script>if\('serviceWorker'[\s\S]*?<\/script>/, '').replace(/<link rel="manifest"[^>]*>/, ''));
  });
});

app.get('/projects/1/schedule-by-category', (req, res) => {
  res.json({ ok: true, rangeHoodSource: 'default', jedcoSource: 'default', heldStatuses: ['In Office', 'Delivered'], byCode: {
    '1b': [
      { name: 'Shower Base', room: 'Bath', product: '60x30 RH Acrylic Floor', brand: 'Kohler', model: 'K-8642-0', finishColor: 'White', qty: '1', supplier: 'Ferguson', prodCode: 'B-SHB02W' },
      { name: 'Shower Drain', room: 'Bath', product: 'Drain w/ Strainer', brand: 'Kohler', model: 'K-9132-CP', finishColor: 'Chrome', qty: '1', supplier: 'Ferguson', prodCode: 'B-SHD01CP' },
      { name: 'Bath Fan', room: 'Bath', product: 'WhisperValue DC', brand: 'Panasonic', model: 'PANFV0510VSC1', finishColor: '', qty: '2', supplier: 'Ferguson', prodCode: 'B-F02' },
      { name: 'Kitchen Sink', room: 'Kitchen', product: 'SS Undermount', brand: 'Elkay', model: 'ELGRU13322PD', finishColor: 'SS', qty: '1', supplier: 'Ferguson', prodCode: 'KT-S01SS' },
    ],
    '2d': [ { name: 'Range Hood', room: 'Kitchen', product: '30" insert hood', brand: 'Fisher & Paykel', model: 'HP30IDCHX4', finishColor: '', qty: '1', supplier: 'Buildoly Stock', prodCode: 'KT-H01', held: true, allocQty: 1, deliveredQty: 0, location: 'office', hood: true, defaultSupplier: 'Ferguson' } ],
  } });
});
app.post('/projects/1/item-mark', (req, res) => {
  const { state, when } = req.body || {};
  res.json({ ok: true, st: state ? { st: state[0], when: when || '', m: 1 } : null, agg: { code: '1b', counts: { total: 6, delivered: 4, scheduled: 1, ordered: 1 } }, bucketStatus: null });
});
// Terminal preview: bare page with the terminal partial + stubbed parse/send endpoints.
app.get('/term', (req, res) => {
  res.render('_terminal', { termProjectId: null, termProjectAddr: '' }, (err, html) => {
    if (err) return res.status(500).send(String(err));
    res.send('<link rel="stylesheet" href="/css/app.css?v=5"><div style="max-width:900px;margin:2rem auto">' + html + '</div>');
  });
});
app.post('/terminal/parse', (req, res) => {
  const cmd = String((req.body || {}).command || '');
  if (/help/.test(cmd)) return res.json({ ok: false, reply: 'Try: "order the doors and windows for silver lantern"' });
  if (/outstanding|status|what/.test(cmd)) return res.json({ ok: true, reply: 'Milton Ave — 2 buckets not ordered:\n  1d Tile (Not yet placed)\n  3a Countertops (RFQ sent)' });
  if (/email me/.test(cmd)) return res.json({ ok: true, preview: 'Email to you <logan@buildoly.com>  ·  "Outstanding orders"  ·  12 lines', action: { kind: 'email_me', subject: 'Outstanding orders', body: 'x' } });
  if (!/order|deliver|quote|damag|replac/.test(cmd)) return res.json({ ok: false, reply: "I couldn't tell what to send." });
  res.json({ ok: true, preview: 'Order → Milgard <orders@milgard.com>  ·  1a Doors, Windows  ·  6 items  ·  33772 Silver Lantern', action: { kind: 'rfq', projectId: 1, itemCode: '1a', supplierEmail: 'orders@milgard.com', supplierName: 'Milgard', emailType: 'order', itemsHtml: '<table><tr><td>x</td></tr></table>', coveredCodes: ['1a'], orderedKeys: ['PC:B-WIN01'], note: '', asDraft: /draft/.test(cmd) } });
});
app.post('/projects/1/rfq', (req, res) => res.json({ ok: true }));
app.post('/terminal/execute', (req, res) => res.json({ ok: true, done: 'Sent to logan@buildoly.com' }));
app.get(/.*/, (req, res) => res.status(404).json({ ok: false }));
app.listen(4173, () => console.log('preview on http://localhost:4173'));
