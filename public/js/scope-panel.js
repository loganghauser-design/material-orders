// Scope & Selections panel — one implementation, used inline on the project
// page (expands above the checklist) and full-page at /projects/:id/selections.
// Data comes from /projects/:id/selections.json; every edit posts to the same
// routes either way. Injects its own CSS so host pages carry no styling.
(function () {
  var CSS = ''
    + '.scp .scp-top { display:flex; align-items:center; gap:.7rem; margin-bottom:.35rem; }'
    + '.scp .scp-title { font-size:15px; font-weight:700; color:var(--text); letter-spacing:-.01em; }'
    + '.scp .scp-right { margin-left:auto; display:flex; gap:.35rem; align-items:center; }'
    + '.scp .scp-btn { border:1px solid var(--border); background:var(--bg); border-radius:7px; padding:4px 10px; font:inherit; font-size:12px; font-weight:600; color:var(--muted); cursor:pointer; }'
    + '.scp .scp-btn:hover { color:var(--text); border-color:#b9c2cc; }'
    + '.scp.editing .scp-btn.edit { background:#111; color:#fff; border-color:#111; }'
    + '.scp .scp-link { font-size:12px; color:var(--muted); text-decoration:none; }'
    + '.scp .scp-link:hover { color:var(--text); }'
    + '.scp .scp-chips { display:flex; gap:.4rem; margin:0 0 .7rem; flex-wrap:wrap; }'
    + '.scp .scp-chip { display:inline-flex; gap:.3rem; align-items:center; font-size:11.5px; font-weight:600; border-radius:6px; padding:2px 8px; }'
    + '.scp .scp-chip.ok { color:#1a7f37; background:rgba(26,127,55,.08); border:1px solid rgba(26,127,55,.25); }'
    + '.scp .scp-chip.warn { color:#9a6b0b; background:rgba(180,120,10,.08); border:1px solid rgba(180,120,10,.28); }'
    + '.scp .scp-cols { columns:3 270px; column-gap:1.7rem; }'
    + '.scp .scp-secblock { break-inside:avoid; -webkit-column-break-inside:avoid; margin:0 0 1rem; }'
    + '.scp .scp-sec { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin:0 0 .3rem; }'
    + '.scp .scp-row { display:grid; grid-template-columns:145px 1fr; gap:.7rem; align-items:start; padding:2px 0; }'
    + '.scp .scp-label { color:var(--muted); font-size:12px; padding-top:2px; line-height:1.45; }'
    + '.scp .scp-val { display:flex; align-items:flex-start; gap:.35rem; min-height:1.25rem; }'
    + '.scp .scp-text { font-size:13px; color:#2f6fd6; font-weight:500; white-space:pre-wrap; line-height:1.45; }'
    + '.scp .scp-text.empty { color:#b45309; font-weight:400; font-style:italic; font-size:12px; }'
    + '.scp .scp-text.opt { color:var(--muted); font-weight:400; font-style:italic; font-size:12px; opacity:.75; }'
    + '.scp .scp-up { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:4px; border:1px solid rgba(47,111,214,.4); background:rgba(47,111,214,.1); color:#2f6fd6; font-size:11px; font-weight:800; flex:none; margin-top:1px; user-select:none; }'
    + '.scp .scp-up.ghost { display:none; opacity:.35; }'
    + '.scp.editing .scp-up.ghost { display:inline-flex; cursor:pointer; }'
    + '.scp.editing .scp-up.ghost:hover { opacity:.8; }'
    + '.scp.editing .scp-up.on { cursor:pointer; }'
    + '.scp .scp-pencil { display:none; border:none; background:none; cursor:pointer; font-size:.78rem; color:var(--muted); padding:.02rem .28rem; border-radius:5px; flex:none; }'
    + '.scp .scp-pencil:hover { color:var(--text); background:var(--bg); }'
    + '.scp.editing .scp-pencil { display:inline-block; }'
    + '.scp .scp-editorbox { flex:1; min-width:0; }'
    + '.scp .scp-editorbox select, .scp .scp-editorbox input, .scp .scp-editorbox textarea { font:inherit; font-size:.82rem; border:1px solid #4f8ef7; border-radius:7px; padding:.3rem .5rem; background:var(--bg); color:var(--text); width:100%; max-width:100%; }'
    + '.scp .scp-editorbox textarea { min-height:80px; }'
    + '.scp .scp-addline { display:none; margin:.2rem 0 0; }'
    + '.scp.editing .scp-addline { display:block; }'
    + '.scp .scp-addline button { border:none; background:none; color:var(--muted); font:inherit; font-size:.74rem; cursor:pointer; text-decoration:underline; padding:0; }'
    + '.scp .scp-addline button:hover { color:var(--text); }'
    + '.scp .scp-hint { display:none; color:var(--muted); font-size:.74rem; margin:.5rem 0 0; }'
    + '.scp.editing .scp-hint { display:block; }'
    + '.scp-toast { position:fixed; bottom:16px; right:16px; background:#111; color:#fff; border-radius:8px; padding:.55rem .9rem; font-size:.8rem; opacity:0; transition:opacity .2s; pointer-events:none; z-index:80; }'
    + '.scp-toast.show { opacity:1; }';

  function ensureCss() {
    if (document.getElementById('scope-panel-css')) return;
    var st = document.createElement('style');
    st.id = 'scope-panel-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  var toastEl, toastT;
  function toast(msg, bad) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'scp-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.style.background = bad ? '#7f1d1d' : '#111';
    toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }
  async function api(path, body) {
    var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.ScopePanel = {
    init: async function (root, pid, opts) {
      opts = opts || {};
      ensureCss();
      root.classList.add('scp');
      root.innerHTML = '<p style="color:var(--muted);font-size:.8rem">Loading scope…</p>';
      var data;
      try {
        var r = await fetch('/projects/' + pid + '/selections.json');
        data = await r.json();
        if (!data.ok) throw new Error(data.error || 'load failed');
      } catch (e) { root.innerHTML = '<p style="color:#dc2626;font-size:.8rem">Could not load scope: ' + esc(e.message) + '</p>'; return; }
      var state = { slots: data.slots, values: data.values, editing: false };
      var byKey = {}; state.slots.forEach(function (s) { byKey[s.key] = s; });
      function isUp(slot, v) {
        var ups = Array.isArray(slot && slot.upgrades) ? slot.upgrades : [];
        return ups.some(function (u) { return String(u).toLowerCase() === String(v).toLowerCase(); });
      }

      function render() {
        var secs = []; var idx = {};
        state.slots.forEach(function (s) {
          if (!(s.section in idx)) { idx[s.section] = secs.length; secs.push({ name: s.section, slots: [] }); }
          secs[idx[s.section]].slots.push(s);
        });
        var h = '<div class="scp-top"><span class="scp-title">' + (opts.title === undefined ? 'Project Scope of Work' : esc(opts.title)) + '</span>'
          + '<div class="scp-right">'
          + (opts.fullPageLink ? '<a class="scp-link" href="/projects/' + pid + '/selections">Full page ↗</a>' : '')
          + '<button class="scp-btn edit" data-act="toggle">' + (state.editing ? '✓ Done editing' : '✎ Edit scope') + '</button></div></div>';
        // Optional lines (Design Mod etc.) sit outside the completeness math.
        var total = 0, filled = 0;
        state.slots.forEach(function (s) { if (s.optional) return; total++; if (String(state.values[s.key] || '').trim()) filled++; });
        h += '<div class="scp-chips"><span class="scp-chip ok">✓ Scope · ' + filled + ' of ' + total + ' selected</span>'
          + (total - filled > 0 ? '<span class="scp-chip warn">' + (total - filled) + ' not set</span>' : '')
          + '</div>';
        if (!state.slots.length) h += '<p style="color:var(--muted);font-size:.8rem">No scope lines defined yet — press ✎ Edit scope, then “+ Add line”.</p>';
        h += '<div class="scp-cols">';
        secs.forEach(function (sec) {
          h += '<div class="scp-secblock"><div class="scp-sec">' + esc(sec.name) + '</div>';
          sec.slots.forEach(function (s) {
            var v = state.values[s.key] || '';
            var up = v && isUp(s, v);
            h += '<div class="scp-row" data-key="' + esc(s.key) + '"><div class="scp-label">' + esc(s.label) + '</div>'
              + '<div class="scp-val">'
              + (up ? '<span class="scp-up on" data-act="upflag" title="Upgrade (click in edit mode to unmark)">↑</span>' : '')
              + (v && !up ? '<span class="scp-up ghost" data-act="upflag" title="Mark this pick as an upgrade">↑</span>' : '')
              + '<span class="scp-text' + (v ? '' : (s.optional ? ' opt' : ' empty')) + '">' + (v ? esc(v) : (s.optional ? 'optional' : 'not set')) + '</span>'
              + '<button class="scp-pencil" data-act="edit" title="Edit ' + esc(s.label) + '">✎</button>'
              + '<span class="scp-editorbox"></span></div></div>';
          });
          h += '<div class="scp-addline"><button data-act="addline" data-section="' + esc(sec.name) + '">＋ Add line to ' + esc(sec.name) + '</button></div></div>';
        });
        h += '</div>';
        h += '<div class="scp-addline"><button data-act="addsection">＋ Add a new section…</button></div>';
        h += '<p class="scp-hint">Pick from each dropdown — “＋ Add option…” adds a choice for every project; “Custom” is one-off for this project. Saves instantly.</p>';
        root.innerHTML = h;
        root.classList.toggle('editing', state.editing);
      }

      function openEditor(row) {
        root.querySelectorAll('.scp-editorbox').forEach(function (b) { b.innerHTML = ''; });
        root.querySelectorAll('.scp-text, .scp-pencil').forEach(function (el) { el.style.display = ''; });
        var key = row.dataset.key;
        var slot = byKey[key] || { input_type: 'dropdown', options: [], label: key };
        var cur = state.values[key] || '';
        row.querySelector('.scp-text').style.display = 'none';
        row.querySelector('.scp-pencil').style.display = 'none';
        var box = row.querySelector('.scp-editorbox');
        var el;
        if (slot.input_type === 'text') {
          el = document.createElement('textarea'); el.value = cur;
          el.addEventListener('blur', function () { save(key, el.value); });
        } else if (slot.input_type === 'number') {
          el = document.createElement('input'); el.type = 'number'; el.value = cur;
          el.addEventListener('change', function () { save(key, el.value); });
          el.addEventListener('blur', function () { save(key, el.value); });
        } else {
          el = document.createElement('select');
          var list = slot.input_type === 'yesno' ? ['Yes', 'No'] : (Array.isArray(slot.options) ? slot.options.slice() : []);
          if (cur && list.indexOf(cur) < 0) list.unshift(cur);
          var oh = '<option value="">— not selected —</option>';
          list.forEach(function (o) {
            oh += '<option value="' + esc(o) + '"' + (o === cur ? ' selected' : '') + '>' + (isUp(slot, o) ? '↑ ' : '') + esc(o) + '</option>';
          });
          if (slot.input_type !== 'yesno') {
            oh += '<option value="__addopt">＋ Add option…</option><option value="__custom">✎ Custom (this project only)…</option>';
          }
          el.innerHTML = oh;
          el.addEventListener('change', async function () {
            if (el.value === '__addopt') {
              var o = prompt('New option for ' + slot.label + ' (added to the dropdown for every project):');
              if (o && o.trim()) {
                var mkUp = confirm('Is "' + o.trim() + '" an UPGRADE option?\n\nOK = upgrade (gets the ↑ badge) · Cancel = standard');
                var d = await api('/selections/slots/add-option', { key: key, option: o.trim(), upgrade: mkUp });
                if (d.ok) { slot.options = d.options; if (d.upgrades) slot.upgrades = d.upgrades; save(key, o.trim()); }
                else { toast(d.error || 'Could not add option', true); openEditor(row); }
              } else openEditor(row);
              return;
            }
            if (el.value === '__custom') {
              var c = prompt('Custom value for ' + slot.label + ' (this project only):', cur);
              if (c != null) save(key, c.trim()); else openEditor(row);
              return;
            }
            save(key, el.value);
          });
        }
        box.appendChild(el); el.focus();
      }

      async function save(key, value) {
        try {
          var d = await api('/projects/' + pid + '/selections/set', { key: key, value: value });
          if (!d.ok) return toast(d.error || 'Not saved', true);
          state.values[key] = value;
          render();
          if (d.slidingSource) {
            // The patio-door rule just retargeted the sliding-door sourcing.
            var sel = document.getElementById('slidingSel');
            if (sel) sel.value = d.slidingSource;
            toast('Saved — sliding door sourcing → ' + (d.slidingSource === 'buildoly' ? 'Buildoly Stock (trifold)' : 'Vendor / Ganahl (sliding glass)'));
          } else if (d.scheduleRows) {
            toast('Saved — updated ' + d.scheduleRows + ' finish schedule row' + (d.scheduleRows === 1 ? '' : 's'));
          } else toast('Saved');
        } catch (e) { toast('Not saved: ' + e.message, true); }
      }

      root.addEventListener('click', async function (e) {
        var btn = e.target.closest('[data-act]');
        if (!btn || !root.contains(btn)) return;
        var act = btn.dataset.act;
        if (act === 'toggle') { state.editing = !state.editing; render(); return; }
        if (act === 'edit') { openEditor(btn.closest('.scp-row')); return; }
        if (act === 'upflag') {
          if (!state.editing) return;                       // badge is read-only outside edit mode
          var urow = btn.closest('.scp-row');
          var ukey = urow.dataset.key;
          var uslot = byKey[ukey];
          var uval = state.values[ukey];
          if (!uslot || !uval) return;
          var mk = !isUp(uslot, uval);
          var ud = await api('/selections/slots/toggle-upgrade', { key: ukey, option: uval, upgrade: mk });
          if (ud.ok) { uslot.upgrades = ud.upgrades; render(); toast(mk ? 'Marked as upgrade ↑' : 'Unmarked — standard'); }
          else toast(ud.error || 'Failed', true);
          return;
        }
        if (act === 'addline' || act === 'addsection') {
          var section = btn.dataset.section;
          if (act === 'addsection') {
            section = prompt('Name of the new section (e.g. Kitchen, Exterior):');
            if (!section || !section.trim()) return;
            section = section.trim();
          }
          var label = prompt('Name of the new line in ' + section + ':');
          if (!label || !label.trim()) return;
          var d = await api('/selections/slots/add', { section: section, label: label.trim() });
          if (!d.ok) return toast(d.error || 'Could not add', true);
          var r2 = await fetch('/projects/' + pid + '/selections.json');
          var d2 = await r2.json();
          if (d2.ok) {
            state.slots = d2.slots; state.values = d2.values;
            state.slots.forEach(function (s) { byKey[s.key] = s; });
            state.editing = true; render();
          }
        }
      });

      render();
    }
  };
})();
