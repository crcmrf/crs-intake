(() => {
  'use strict';

  // ---------- Constants ----------
  const MATERIALS = [
    { id: 'Aluminium',    short: 'Alu',     group: 'alu' },
    { id: 'PET - Clear',  short: 'PET Clr', group: 'other' },
    { id: 'PET - Colour', short: 'PET Col', group: 'other' },
    { id: 'HDPE',         short: 'HDPE',    group: 'other' },
    { id: 'LPB',          short: 'LPB',     group: 'other' },
    { id: 'Steel',        short: 'Steel',   group: 'other' },
    { id: 'Glass',        short: 'Glass',   group: 'glass' },
  ];
  const RANGES = [
    { id: '7d',  label: 'Last 7 days',   days: 7 },
    { id: '14d', label: 'Last 14 days',  days: 14 },
    { id: '1m',  label: 'Last month',    months: 1 },
    { id: '3m',  label: 'Last 3 months', months: 3 },
    { id: '6m',  label: 'Last 6 months', months: 6 },
    { id: '12m', label: 'Last 12 months', months: 12 },
  ];
  const groupOf = (material) => (MATERIALS.find(m => m.id === material) || { group: 'other' }).group;
  const MIN_ROWS = 20;
  const RECENT_PAGE = 25;
  const cfg = window.CRS_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const nowIso = () => new Date().toISOString();
  const ymd = (d) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  const todayLocal = () => ymd(new Date());
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };

  // ---------- Local storage helpers ----------
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } },
  };

  // ---------- Settings ----------
  function loadSettings() {
    const s = store.get('crs-settings', {});
    return {
      owner: s.owner || cfg.owner || '',
      repo: s.repo || cfg.repo || '',
      branch: s.branch || cfg.branch || 'main',
      dataDir: (s.dataDir || cfg.dataDir || 'data').replace(/^\/+|\/+$/g, ''),
      token: s.token || '',
    };
  }
  let settings = loadSettings();
  const isConfigured = () => !!(settings.owner && settings.repo && settings.token &&
    settings.owner !== 'your-github-username');

  // ---------- Base64 (UTF-8 safe) ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  // ---------- GitHub API ----------
  function repoUrl(s = settings) {
    return `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;
  }
  function headers(s = settings, extra = {}) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${s.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }
  const contentsUrl = (path) => `${repoUrl()}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  async function apiError(res) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
    if (res.status === 401) return new Error('GitHub token rejected (401). Check ⚙ Settings.');
    if (res.status === 403) return new Error(`Access denied (403). ${msg} – the token needs Contents read/write on this repo.`);
    if (res.status === 404) return new Error('Repository not found (404). Check owner/repo name and token access.');
    return new Error(msg || `GitHub error ${res.status}`);
  }

  async function getFile(path, { checkRepo = true } = {}) {
    const url = `${contentsUrl(path)}?ref=${encodeURIComponent(settings.branch)}`;
    const res = await fetch(url, { headers: headers(), cache: 'no-store' });
    if (res.status === 404) {
      if (checkRepo) {
        // "File missing" and "repo missing" both give 404 – check the repo so we report the right one.
        const repo = await fetch(repoUrl(), { headers: headers(), cache: 'no-store' });
        if (!repo.ok) throw await apiError(repo);
      }
      return null;
    }
    if (!res.ok) throw await apiError(res);
    const j = await res.json();
    let text;
    if (j.encoding === 'base64' && j.content) {
      text = b64decode(j.content);
    } else {
      // Files over 1 MB come back without content – fetch them raw.
      const raw = await fetch(url, { headers: headers(settings, { Accept: 'application/vnd.github.raw' }), cache: 'no-store' });
      if (!raw.ok) throw await apiError(raw);
      text = await raw.text();
    }
    return { doc: JSON.parse(text), sha: j.sha };
  }

  async function putFile(path, doc, sha, message) {
    const body = {
      message,
      content: b64encode(JSON.stringify(doc, null, 2) + '\n'),
      branch: settings.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(contentsUrl(path), {
      method: 'PUT',
      headers: headers(settings, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) {
      const e = await apiError(res); e.conflict = true; throw e;
    }
    if (!res.ok) throw await apiError(res);
    return (await res.json()).content.sha;
  }

  // Run async jobs a few at a time (keeps GitHub happy).
  async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const item = items[i++]; await fn(item); }
    });
    await Promise.all(workers);
  }

  // ---------- Sheet identity ----------
  const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  function buildPath(meta) {
    let name = `${slug(meta.carrier)}__${slug(meta.rego)}`;
    if (meta.bin) name += `__bin-${slug(meta.bin)}`;
    if (meta.location) name += `__loc-${slug(meta.location)}`;
    return `${settings.dataDir}/${meta.date}/${name}.json`;
  }
  function newDoc(meta) {
    return { version: 1, meta, entries: [], deleted: [], createdAt: nowIso(), updatedAt: nowIso() };
  }

  // Combine our copy with someone else's newer copy (two devices editing the same sheet).
  function merge(remote, local) {
    const deleted = new Set([...(remote.deleted || []), ...(local.deleted || [])]);
    const byId = new Map();
    for (const e of [...(remote.entries || []), ...(local.entries || [])]) {
      if (deleted.has(e.id)) continue;
      const cur = byId.get(e.id);
      if (!cur || (e.updatedAt || '') > (cur.updatedAt || '')) byId.set(e.id, e);
    }
    const entries = [...byId.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    return { ...remote, entries, deleted: [...deleted] };
  }

  // ---------- Summary index ----------
  // One small file per month (data/_index/2026-10.json) listing every sheet with its
  // material counts, so the home page loads with a handful of requests.
  const indexPath = (month) => `${settings.dataDir}/_index/${month}.json`;
  const idxCache = new Map(); // index path -> { sha, doc }

  function summarize(path, doc) {
    const counts = {};
    let glassKg = 0, toWeigh = 0;
    for (const e of doc.entries) {
      counts[e.material] = (counts[e.material] || 0) + 1;
      if (groupOf(e.material) === 'glass') {
        if (e.weight === '' || e.weight == null) toWeigh++;
        else glassKg += Number(e.weight) || 0;
      }
    }
    const m = doc.meta;
    return {
      path, date: m.date, carrier: m.carrier, rego: m.rego, bin: m.bin || '', location: m.location || '',
      counts, glassKg: Math.round(glassKg * 10) / 10, toWeigh, total: doc.entries.length,
      updatedAt: doc.updatedAt || nowIso(),
    };
  }

  async function writeIndexEntry(sheetPath, doc) {
    const month = doc.meta.date.slice(0, 7);
    const ipath = indexPath(month);
    const sum = doc.entries.length ? summarize(sheetPath, doc) : null;
    for (let attempt = 0; ; attempt++) {
      let cur = idxCache.get(ipath);
      if (!cur) {
        const f = await getFile(ipath, { checkRepo: false });
        cur = f ? { sha: f.sha, doc: f.doc } : { sha: null, doc: { version: 1, month, sheets: {} } };
      }
      const next = { ...cur.doc, sheets: { ...(cur.doc.sheets || {}) }, updatedAt: nowIso() };
      if (sum) next.sheets[sheetPath] = sum;
      else if (sheetPath in next.sheets) delete next.sheets[sheetPath];
      else { idxCache.set(ipath, cur); return; } // nothing to change
      try {
        const sha = await putFile(ipath, next, cur.sha, `Update summary ${month}`);
        idxCache.set(ipath, { sha, doc: next });
        return;
      } catch (e) {
        idxCache.delete(ipath); // someone else changed it – re-read and try again
        if (!e.conflict || attempt >= 3) throw e;
      }
    }
  }

  // ---------- State ----------
  let sheet = null;       // { path, sha, doc }
  let saving = false, saveAgain = false, dirty = false, lastMsg = 'Update sheet';

  // ---------- Save ----------
  function setSaveStatus(text, kind = '') {
    const s = $('#saveStatus');
    s.textContent = text;
    s.className = `status-btn ${kind}`;
  }

  async function save(message) {
    if (message) lastMsg = message;
    const s = sheet;
    if (!s) return;
    if (saving) { saveAgain = true; return; }
    saving = true;
    setSaveStatus('Saving…', 'busy');
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          s.doc.updatedAt = nowIso();
          s.sha = await putFile(s.path, s.doc, s.sha, lastMsg);
          break;
        } catch (e) {
          if (!e.conflict || attempt >= 2) throw e;
          // Someone else saved first – pull their version, merge, try again.
          const remote = await getFile(s.path);
          if (remote) { s.doc = merge(remote.doc, s.doc); s.sha = remote.sha; }
          else s.sha = null;
          if (sheet === s) render();
        }
      }
      dirty = false;
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      try {
        await writeIndexEntry(s.path, s.doc);
        setSaveStatus(`✓ Saved ${time}`, 'ok');
      } catch {
        setSaveStatus(`✓ Saved ${time} (home summary will update next save)`, 'ok');
      }
    } catch (e) {
      dirty = true;
      setSaveStatus(`⚠ Not saved – tap to retry (${e.message})`, 'err');
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; save(); }
    }
  }

  // ---------- Views ----------
  function showStart() {
    $('#sheetView').hidden = true;
    $('#startView').hidden = false;
    $('#startStatus').textContent = '';
    $('#startStatus').className = 'status';
    loadDashboard();
  }
  function showSheet() {
    $('#startView').hidden = true;
    $('#sheetView').hidden = false;
    window.scrollTo(0, 0);
  }

  function cell(text, cls, entryId) {
    const td = el('td', cls, text);
    if (entryId) { td.dataset.id = entryId; td.classList.add('filled'); td.title = 'Tap to edit'; }
    return td;
  }

  const fmtDate = (d) => (d ? d.split('-').reverse().join('/') : '');

  function render() {
    if (!sheet) return;
    const m = sheet.doc.meta;
    $('#mDate').textContent = fmtDate(m.date);
    $('#mCarrier').textContent = m.carrier || '';
    $('#mRego').textContent = m.rego || '';
    $('#mBin').textContent = m.bin || '';
    $('#mLocation').textContent = m.location || '';

    const entries = sheet.doc.entries;
    const alu = entries.filter(e => groupOf(e.material) === 'alu');
    const oth = entries.filter(e => groupOf(e.material) === 'other');
    const gls = entries.filter(e => groupOf(e.material) === 'glass');
    const rows = Math.max(MIN_ROWS, alu.length, oth.length, gls.length);

    const body = $('#gridBody');
    body.textContent = '';
    for (let i = 0; i < rows; i++) {
      const tr = document.createElement('tr');
      const a = alu[i], o = oth[i], g = gls[i];
      tr.append(
        cell(a ? i + 1 : '', 'idx', a && a.id),
        cell(a ? a.bag : '', '', a && a.id),
        cell(o ? o.material : '', '', o && o.id),
        cell(o ? o.bag : '', '', o && o.id),
        cell(g ? g.ibc : '', '', g && g.id),
        g && (g.weight === '' || g.weight == null)
          ? cell('to weigh', 'pending', g.id)
          : cell(g ? g.weight : '', '', g && g.id),
      );
      body.append(tr);
    }

    const weighed = gls.filter(g => g.weight !== '' && g.weight != null);
    const totalKg = weighed.reduce((s, g) => s + Number(g.weight || 0), 0);
    $('#totAlu').textContent = `${alu.length} bag${alu.length === 1 ? '' : 's'}`;
    $('#totOther').textContent = `${oth.length} bag${oth.length === 1 ? '' : 's'}`;
    $('#totGlass').textContent = `${gls.length} IBC${gls.length === 1 ? '' : 's'}` +
      (weighed.length ? ` · ${+totalKg.toFixed(1)} kg` : '') +
      (gls.length - weighed.length ? ` · ${gls.length - weighed.length} to weigh` : '');

    const summary = $('#summary');
    summary.textContent = '';
    for (const mat of MATERIALS) {
      const n = entries.filter(e => e.material === mat.id).length;
      if (n) summary.append(el('span', 'chip', `${mat.id}: ${n}`));
    }
  }

  // ---------- Printing (A4 portrait, always one page) ----------
  const PX_PER_MM = 96 / 25.4;
  const PAGE_W = 190 * PX_PER_MM;      // A4 width minus 10 mm margins
  const PAGE_H = 277 * PX_PER_MM - 6;  // A4 height minus 10 mm margins, small safety gap

  function preparePrint() {
    if ($('#sheetView').hidden) return;
    const sh = $('#sheetView .sheet');
    document.body.classList.add('print-mode');
    sh.style.zoom = '';
    sh.style.width = `${PAGE_W}px`;
    // Fill the rest of the page with blank rows, like the paper form.
    const body = $('#gridBody');
    if (!body.querySelector('.print-fill')) {
      const rowH = body.lastElementChild ? body.lastElementChild.getBoundingClientRect().height : 25;
      for (let n = 0; n < 60 && sh.scrollHeight + rowH <= PAGE_H; n++) {
        const tr = el('tr', 'print-fill');
        for (let c = 0; c < 6; c++) tr.append(el('td', c === 0 ? 'idx' : ''));
        body.append(tr);
      }
    }
    const scale = Math.min(1, PAGE_H / sh.scrollHeight);
    if (scale < 1) {
      sh.style.width = `${PAGE_W / scale}px`; // widen first so it fills the page once shrunk
      sh.style.zoom = String(Math.min(1, PAGE_H / sh.scrollHeight));
    }
  }
  function endPrint() {
    document.body.classList.remove('print-mode');
    document.querySelectorAll('#gridBody .print-fill').forEach(r => r.remove());
    const sh = $('#sheetView .sheet');
    sh.style.zoom = '';
    sh.style.width = '';
  }

  // ---------- Start form ----------
  function refreshCarrierList(extra = []) {
    const list = $('#carrierList');
    list.textContent = '';
    const seen = new Set();
    for (const c of [...store.get('crs-carriers', []), ...extra]) {
      const k = c.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const opt = document.createElement('option'); opt.value = c; list.append(opt);
    }
  }
  function rememberCarrier(c) {
    const list = store.get('crs-carriers', []).filter(x => x.toLowerCase() !== c.toLowerCase());
    list.unshift(c);
    store.set('crs-carriers', list.slice(0, 30));
    refreshCarrierList();
  }

  async function openSheet(meta, knownPath) {
    const btn = $('#openBtn'), st = $('#startStatus');
    btn.disabled = true;
    st.className = 'status'; st.textContent = 'Checking for an existing sheet…';
    try {
      const path = knownPath || buildPath(meta);
      const found = await getFile(path);
      if (found) {
        sheet = { path, sha: found.sha, doc: found.doc };
        setSaveStatus(`Opened existing sheet (${found.doc.entries.length} entries)`, 'ok');
      } else {
        sheet = { path, sha: null, doc: newDoc(meta) };
        setSaveStatus('New sheet – saves when the first entry is added');
      }
      dirty = false;
      rememberCarrier(sheet.doc.meta.carrier);
      render();
      showSheet();
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
      window.scrollTo(0, 0);
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshSheet() {
    if (!sheet || saving) return;
    setSaveStatus('Refreshing…', 'busy');
    try {
      const found = await getFile(sheet.path);
      if (found) {
        sheet.doc = dirty ? merge(found.doc, sheet.doc) : found.doc;
        sheet.sha = found.sha;
      }
      render();
      if (dirty) save('Merge changes'); else setSaveStatus('✓ Up to date', 'ok');
    } catch (e) {
      setSaveStatus(`⚠ ${e.message}`, 'err');
    }
  }

  // ---------- Home dashboard ----------
  let dashSheets = [];
  let recentShown = RECENT_PAGE;
  let dashSeq = 0;

  const currentRange = () => RANGES.find(r => r.id === $('#rangeSel').value) || RANGES[0];

  function rangeStart(r) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    if (r.days) {
      d.setDate(d.getDate() - (r.days - 1));
    } else {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() - r.months);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
    }
    return ymd(d);
  }
  function monthsBetween(fromYmd, toYmd) {
    const out = [];
    let [y, m] = fromYmd.split('-').map(Number);
    const [ty, tm] = toYmd.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }

  function setDashStatus(text, kind = '') {
    const s = $('#dashStatus');
    s.textContent = text;
    s.className = `status ${kind}`;
  }

  async function loadDashboard() {
    const seq = ++dashSeq;
    const r = currentRange();
    $('#rangeLabel').textContent = r.label;
    if (!isConfigured()) {
      dashSheets = [];
      renderDashboard();
      setDashStatus('Connect to GitHub in ⚙ Settings to see recent loads.');
      return;
    }
    setDashStatus('Loading…');
    try {
      const from = rangeStart(r), to = todayLocal();
      const months = monthsBetween(from, to);
      const files = new Array(months.length);
      await pool(months.map((m, i) => [m, i]), 4, async ([m, i]) => {
        const f = await getFile(indexPath(m), { checkRepo: false });
        if (f) idxCache.set(indexPath(m), { sha: f.sha, doc: f.doc });
        files[i] = f;
      });
      if (seq !== dashSeq) return; // a newer load started
      const list = [];
      for (const f of files) {
        if (!f) continue;
        for (const s of Object.values(f.doc.sheets || {})) {
          if (s.date >= from && s.date <= to) list.push(s);
        }
      }
      list.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      dashSheets = list;
      recentShown = RECENT_PAGE;
      renderDashboard();
      refreshCarrierList(list.map(s => s.carrier));
      setDashStatus(list.length ? `${list.length} load${list.length === 1 ? '' : 's'} · ${r.label.toLowerCase()}` : '');
    } catch (e) {
      if (seq !== dashSeq) return;
      setDashStatus(e.message, 'err');
    }
  }

  function dayLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const today = todayLocal();
    const yest = new Date(); yest.setDate(yest.getDate() - 1);
    if (dateStr === today) return 'Today';
    if (dateStr === ymd(yest)) return 'Yesterday';
    return dt.toLocaleDateString('en-AU', { weekday: 'short' });
  }

  // Totals per location (loads with no location are grouped together).
  const NO_LOCATION = 'No location';
  function groupByLocation(sheets) {
    const map = new Map();
    const total = { loads: 0, counts: {}, glassKg: 0 };
    for (const s of sheets) {
      const name = (s.location || '').trim();
      const key = name.toLowerCase();
      let row = map.get(key);
      if (!row) { row = { name: name || NO_LOCATION, blank: !name, loads: 0, counts: {}, glassKg: 0 }; map.set(key, row); }
      row.loads++;
      row.glassKg += s.glassKg || 0;
      total.loads++;
      total.glassKg += s.glassKg || 0;
      for (const [mat, n] of Object.entries(s.counts || {})) {
        row.counts[mat] = (row.counts[mat] || 0) + n;
        total.counts[mat] = (total.counts[mat] || 0) + n;
      }
    }
    const rows = [...map.values()].sort((a, b) =>
      (a.blank - b.blank) || b.loads - a.loads || a.name.localeCompare(b.name));
    return { rows, total };
  }

  // ---------- Excel export (uses xlsx.js, no internet needed) ----------
  const xlDate = (d) => ({ date: d });
  const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').trim();

  function exportDashboard() {
    if (!dashSheets.length) { alert('There are no loads in this period to export.'); return; }
    try {
      const r = currentRange();
      const matHead = MATERIALS.map(m => (m.group === 'glass' ? 'Glass (IBC)' : m.id));
      const kg = (n) => Math.round((n || 0) * 10) / 10;

      // Sheet 1: totals by location
      const { rows, total } = groupByLocation(dashSheets);
      const loc = [
        [`CRS material by location – ${r.label}`],
        [`${fmtDate(rangeStart(r))} to ${fmtDate(todayLocal())}`],
        [],
        ['Location', 'Loads', ...matHead, 'Glass kg'],
        ...rows.map(x => [x.name, x.loads, ...MATERIALS.map(m => x.counts[m.id] || 0), kg(x.glassKg)]),
        ['Total', total.loads, ...MATERIALS.map(m => total.counts[m.id] || 0), kg(total.glassKg)],
      ];

      // Sheet 2: every load in the period
      const loads = [
        ['Date', 'Carrier', 'Truck Rego', 'Bin No', 'Location', ...matHead, 'Glass kg', 'Glass to weigh', 'Total items'],
        ...dashSheets.map(s => [
          xlDate(s.date), s.carrier, s.rego, s.bin || '', s.location || '',
          ...MATERIALS.map(m => (s.counts || {})[m.id] || 0),
          kg(s.glassKg), s.toWeigh || 0, s.total || 0,
        ]),
      ];

      window.downloadXlsx(safeName(`CRS summary - ${r.label} - ${todayLocal()}.xlsx`), [
        { name: 'By location', rows: loc, widths: [24, 8, ...MATERIALS.map(() => 13), 10],
          titleRows: [0], boldRows: [3, loc.length - 1] },
        { name: 'Loads', rows: loads, widths: [12, 22, 12, 8, 18, ...MATERIALS.map(() => 13), 10, 14, 11],
          boldRows: [0] },
      ]);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  }

  function exportSheet() {
    if (!sheet) return;
    try {
      const m = sheet.doc.meta;
      const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) : '');
      const order = Object.fromEntries(MATERIALS.map((x, i) => [x.id, i]));
      const entries = [...sheet.doc.entries].sort((a, b) =>
        (order[a.material] ?? 99) - (order[b.material] ?? 99) || (a.createdAt || '').localeCompare(b.createdAt || ''));
      const totals = MATERIALS.map(x => [x.id, entries.filter(e => e.material === x.id).length]).filter(r => r[1]);
      const rows = [
        ['Incoming CRS Various Material'],
        ['Date', xlDate(m.date), '', 'Truck Rego', m.rego],
        ['Carrier', m.carrier, '', 'Bin No', m.bin || ''],
        ['Location', m.location || ''],
        [],
        ['Material', 'Bag Number', 'IBC #', 'Weight (kg)', 'Added'],
        ...entries.map(e => [
          e.material, e.bag || '', e.ibc || '',
          e.weight === '' || e.weight == null ? '' : Number(e.weight),
          time(e.createdAt),
        ]),
        [],
        ['Totals'],
        ...totals,
      ];
      const totalsRow = 7 + entries.length;
      window.downloadXlsx(safeName(`${m.date} ${m.carrier} ${m.rego}.xlsx`), [
        { name: 'Sheet', rows, widths: [16, 16, 12, 12, 10], titleRows: [0], boldRows: [5, totalsRow] },
      ]);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  }

  function renderDashboard() {
    // ----- Recent loads -----
    const listEl = $('#recentList');
    listEl.textContent = '';
    if (!dashSheets.length) {
      listEl.append(el('div', 'empty', isConfigured() ? 'No loads in this period.' : ''));
    }
    for (const s of dashSheets.slice(0, recentShown)) {
      const b = el('button', 'recent-item');
      b.type = 'button';
      b.title = 'Open this sheet';

      const date = el('div', 'ri-date');
      date.append(el('b', '', fmtDate(s.date).slice(0, 5)), el('span', '', dayLabel(s.date)));

      const main = el('div', 'ri-main');
      const title = el('div', 'ri-title');
      title.append(document.createTextNode(`${s.carrier} · `), el('span', 'rego', s.rego));
      main.append(title);
      const sub = [s.bin && `Bin ${s.bin}`, s.location].filter(Boolean).join(' · ');
      if (sub) main.append(el('div', 'ri-sub', sub));

      const chips = el('div', 'ri-chips');
      for (const mat of MATERIALS) {
        const n = (s.counts || {})[mat.id];
        if (!n) continue;
        let label = `${mat.short} ${n}`;
        if (mat.group === 'glass') {
          label = `Glass ${n} IBC` + (s.glassKg ? ` · ${s.glassKg} kg` : '') + (s.toWeigh ? ` · ${s.toWeigh} to weigh` : '');
        }
        chips.append(el('span', `chip ${mat.group}`, label));
      }

      b.append(date, main, chips);
      b.addEventListener('click', () => {
        $('#fDate').value = s.date;
        $('#fCarrier').value = s.carrier;
        $('#fRego').value = s.rego;
        $('#fBin').value = s.bin || '';
        $('#fLocation').value = s.location || '';
        openSheet({ date: s.date, carrier: s.carrier, rego: s.rego, bin: s.bin || '', location: s.location || '' }, s.path);
      });
      listEl.append(b);
    }
    const more = $('#recentMore');
    more.hidden = dashSheets.length <= recentShown;
    more.textContent = `Show more (${dashSheets.length - recentShown} more)`;

    // ----- By location -----
    const { rows, total } = groupByLocation(dashSheets);

    const table = $('#companyTable');
    table.textContent = '';
    const thead = el('thead'), htr = el('tr');
    htr.append(el('th', '', 'Location'), el('th', '', 'Loads'));
    for (const mat of MATERIALS) htr.append(el('th', mat.group, mat.group === 'glass' ? 'Glass (IBC)' : mat.id));
    htr.append(el('th', 'glass', 'Glass kg'));
    thead.append(htr);

    const numCell = (n, digits = 0) => {
      const v = Math.round((n || 0) * 10 ** digits) / 10 ** digits;
      return el('td', v ? '' : 'zero', v ? v.toLocaleString('en-AU') : '–');
    };

    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      tr.append(el('td', r.blank ? 'muted' : '', r.name), numCell(r.loads));
      for (const mat of MATERIALS) tr.append(numCell(r.counts[mat.id]));
      tr.append(numCell(r.glassKg, 1));
      tbody.append(tr);
    }
    if (!rows.length) {
      const tr = el('tr'), td = el('td', 'empty', isConfigured() ? 'No loads in this period.' : '');
      td.colSpan = MATERIALS.length + 3;
      tr.append(td); tbody.append(tr);
    }
    table.append(thead, tbody);

    if (rows.length > 1) {
      const tfoot = el('tfoot'), tr = el('tr');
      tr.append(el('td', '', 'Total'), numCell(total.loads));
      for (const mat of MATERIALS) tr.append(numCell(total.counts[mat.id]));
      tr.append(numCell(total.glassKg, 1));
      tfoot.append(tr);
      table.append(tfoot);
    }
  }

  // Re-create the monthly summary files from the sheets themselves (for sheets saved
  // before the summary existed, or if a summary update was missed).
  async function rebuildIndex() {
    if (!isConfigured()) { openSettings('Set up the GitHub connection first.'); return; }
    const r = currentRange();
    if (!confirm(`Rebuild the summary for ${r.label.toLowerCase()}? This re-reads every sheet in that period and may take a minute.`)) return;
    const btn = $('#rebuildBtn');
    btn.disabled = true;
    try {
      setDashStatus('Listing sheets…');
      const res = await fetch(`${repoUrl()}/git/trees/${encodeURIComponent(settings.branch)}?recursive=1`,
        { headers: headers(), cache: 'no-store' });
      if (!res.ok) throw await apiError(res);
      const tree = await res.json();
      const months = monthsBetween(rangeStart(r), todayLocal());
      const dir = settings.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${dir}/(\\d{4}-\\d{2})-\\d{2}/[^/]+\\.json$`);
      const paths = (tree.tree || [])
        .filter(t => t.type === 'blob' && re.test(t.path) && months.includes(t.path.match(re)[1]))
        .map(t => t.path);

      const byMonth = new Map(months.map(m => [m, {}]));
      let done = 0;
      await pool(paths, 5, async (p) => {
        const f = await getFile(p, { checkRepo: false });
        if (f && f.doc && f.doc.meta && (f.doc.entries || []).length) {
          byMonth.get(p.match(re)[1])[p] = summarize(p, f.doc);
        }
        done++;
        setDashStatus(`Reading sheets ${done}/${paths.length}…`);
      });

      setDashStatus('Writing summary…');
      for (const [month, sheets] of byMonth) {
        const ipath = indexPath(month);
        const existing = await getFile(ipath, { checkRepo: false });
        if (!existing && !Object.keys(sheets).length) continue;
        const doc = { version: 1, month, sheets, updatedAt: nowIso() };
        const sha = await putFile(ipath, doc, existing && existing.sha, `Rebuild summary ${month}`);
        idxCache.set(ipath, { sha, doc });
      }
      if (tree.truncated) alert('The repository is very large, so some sheets may not have been included.');
      await loadDashboard();
    } catch (e) {
      setDashStatus(`Rebuild failed: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Entry dialog ----------
  const dlg = $('#entryDialog');
  let selMaterial = null;
  let editing = null; // entry being edited, or null when adding

  function buildMaterialButtons() {
    const grid = $('#matGrid');
    for (const m of MATERIALS) {
      const b = el('button', '', m.id);
      b.type = 'button';
      b.dataset.material = m.id;
      b.dataset.group = m.group;
      b.addEventListener('click', () => selectMaterial(m.id, true));
      grid.append(b);
    }
  }

  function selectMaterial(material, focus) {
    selMaterial = material;
    for (const b of $('#matGrid').children) b.classList.toggle('sel', b.dataset.material === material);
    const glass = groupOf(material) === 'glass';
    $('#bagFields').hidden = glass;
    $('#glassFields').hidden = !glass;
    $('#entrySubmit').disabled = false;
    $('#entryAddAnother').disabled = false;
    $('#entryError').textContent = '';
    if (focus) setTimeout(() => (glass ? $('#fIbc') : $('#fBag')).focus(), 0);
  }

  function openEntryDialog(entry = null) {
    editing = entry;
    selMaterial = null;
    $('#entryForm').reset();
    $('#entryError').textContent = '';
    for (const b of $('#matGrid').children) b.classList.remove('sel');
    $('#bagFields').hidden = true;
    $('#glassFields').hidden = true;
    $('#entrySubmit').disabled = true;
    $('#entryAddAnother').disabled = true;

    $('#entryTitle').textContent = entry ? 'Edit entry' : 'Add entry';
    $('#entrySubmit').textContent = entry ? 'Update' : 'Add';
    $('#entryDelete').hidden = !entry;
    $('#entryAddAnother').hidden = !!entry;

    if (entry) {
      selectMaterial(entry.material, false);
      $('#fBag').value = entry.bag || '';
      $('#fIbc').value = entry.ibc || '';
      $('#fWeight').value = entry.weight ?? '';
    }
    dlg.showModal();
    if (entry && groupOf(entry.material) === 'glass' && (entry.weight === '' || entry.weight == null)) {
      setTimeout(() => $('#fWeight').focus(), 0);
    }
  }

  function submitEntry(keepOpen) {
    const err = $('#entryError');
    if (!selMaterial) { err.textContent = 'Choose what it is first.'; return; }
    const glass = groupOf(selMaterial) === 'glass';
    const bag = $('#fBag').value.trim();
    const ibc = $('#fIbc').value.trim();
    const weightRaw = $('#fWeight').value.trim();

    if (glass && !ibc) { err.textContent = 'Enter the IBC number.'; $('#fIbc').focus(); return; }
    if (!glass && !bag) { err.textContent = 'Enter the bag number.'; $('#fBag').focus(); return; }
    if (glass && weightRaw !== '' && !(Number(weightRaw) >= 0)) { err.textContent = 'Weight must be a number.'; return; }

    // Duplicate check within this sheet
    const dup = sheet.doc.entries.find(e => e !== editing && e.material === selMaterial &&
      (glass ? (e.ibc || '').toLowerCase() === ibc.toLowerCase() : (e.bag || '').toLowerCase() === bag.toLowerCase()));
    if (dup && !confirm(`${selMaterial} ${glass ? 'IBC' : 'bag'} "${glass ? ibc : bag}" is already on this sheet. Add it anyway?`)) return;

    const fields = glass
      ? { material: selMaterial, ibc, weight: weightRaw === '' ? '' : Number(weightRaw), bag: undefined }
      : { material: selMaterial, bag, ibc: undefined, weight: undefined };

    let msg;
    if (editing) {
      Object.assign(editing, fields, { updatedAt: nowIso() });
      for (const k of Object.keys(editing)) if (editing[k] === undefined) delete editing[k];
      msg = `Edit ${selMaterial} ${glass ? 'IBC ' + ibc : 'bag ' + bag}`;
    } else {
      const entry = { id: uid(), ...fields, createdAt: nowIso(), updatedAt: nowIso() };
      for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
      sheet.doc.entries.push(entry);
      msg = `Add ${selMaterial} ${glass ? 'IBC ' + ibc : 'bag ' + bag}`;
    }
    const m = sheet.doc.meta;
    dirty = true;
    render();
    save(`${msg} – ${m.carrier} ${m.rego} ${m.date}`);

    if (keepOpen) {
      // Same material, clear the number for the next bag/IBC
      $('#fBag').value = ''; $('#fIbc').value = ''; $('#fWeight').value = '';
      err.textContent = '';
      (glass ? $('#fIbc') : $('#fBag')).focus();
    } else {
      dlg.close();
    }
  }

  function deleteEntry() {
    if (!editing) return;
    const label = editing.ibc ? `IBC ${editing.ibc}` : `bag ${editing.bag}`;
    if (!confirm(`Delete ${editing.material} ${label}?`)) return;
    sheet.doc.entries = sheet.doc.entries.filter(e => e !== editing);
    sheet.doc.deleted = [...(sheet.doc.deleted || []), editing.id];
    const m = sheet.doc.meta;
    dirty = true;
    dlg.close();
    render();
    save(`Delete ${editing.material} ${label} – ${m.carrier} ${m.rego} ${m.date}`);
  }

  // ---------- Settings dialog ----------
  const sdlg = $('#settingsDialog');
  function openSettings(message) {
    $('#sOwner').value = settings.owner === 'your-github-username' ? '' : settings.owner;
    $('#sRepo').value = settings.repo;
    $('#sBranch').value = settings.branch;
    $('#sDir').value = settings.dataDir;
    $('#sToken').value = settings.token;
    const st = $('#settingsStatus');
    st.className = 'status'; st.textContent = message || '';
    sdlg.showModal();
  }
  function readSettingsForm() {
    return {
      owner: $('#sOwner').value.trim(),
      repo: $('#sRepo').value.trim(),
      branch: $('#sBranch').value.trim() || 'main',
      dataDir: ($('#sDir').value.trim() || 'data').replace(/^\/+|\/+$/g, ''),
      token: $('#sToken').value.trim(),
    };
  }
  async function testSettings() {
    const s = readSettingsForm(), st = $('#settingsStatus');
    st.className = 'status'; st.textContent = 'Testing…';
    try {
      const res = await fetch(repoUrl(s), { headers: headers(s), cache: 'no-store' });
      if (!res.ok) throw await apiError(res);
      const j = await res.json();
      if (j.permissions && !j.permissions.push) throw new Error('Connected, but this token cannot write to the repo.');
      st.className = 'status ok'; st.textContent = `✓ Connected to ${j.full_name}`;
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
    }
  }

  // ---------- Wire up ----------
  function init() {
    $('#fDate').value = todayLocal();
    refreshCarrierList();
    buildMaterialButtons();

    // Period dropdown (remembers the last choice on this device)
    const rangeSel = $('#rangeSel');
    for (const r of RANGES) {
      const o = el('option', '', r.label); o.value = r.id; rangeSel.append(o);
    }
    rangeSel.value = store.get('crs-range', '7d');
    if (!rangeSel.value) rangeSel.value = '7d';
    rangeSel.addEventListener('change', () => { store.set('crs-range', rangeSel.value); loadDashboard(); });
    $('#dashRefresh').addEventListener('click', loadDashboard);
    $('#recentMore').addEventListener('click', () => { recentShown += RECENT_PAGE; renderDashboard(); });
    $('#rebuildBtn').addEventListener('click', rebuildIndex);
    $('#exportDash').addEventListener('click', exportDashboard);
    $('#exportSheet').addEventListener('click', exportSheet);

    $('#fRego').addEventListener('input', (e) => {
      const p = e.target.selectionStart;
      e.target.value = e.target.value.toUpperCase();
      e.target.setSelectionRange(p, p);
    });

    $('#startForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!isConfigured()) { openSettings('Set up the GitHub connection first.'); return; }
      const meta = {
        date: $('#fDate').value,
        carrier: $('#fCarrier').value.trim(),
        rego: $('#fRego').value.trim().toUpperCase().replace(/\s+/g, ''),
        bin: $('#fBin').value.trim(),
        location: $('#fLocation').value.trim(),
      };
      if (!meta.date || !meta.carrier || !meta.rego) return;
      openSheet(meta);
    });

    $('#backBtn').addEventListener('click', () => {
      if ((dirty || saving) && !confirm('Changes are still saving or failed to save. Leave anyway?')) return;
      sheet = null; dirty = false;
      // Clear the lookup so the next truck starts fresh
      $('#startForm').reset();
      $('#fDate').value = todayLocal();
      showStart();
    });
    $('#refreshBtn').addEventListener('click', refreshSheet);
    $('#printBtn').addEventListener('click', () => { preparePrint(); window.print(); });
    window.addEventListener('beforeprint', preparePrint);
    window.addEventListener('afterprint', endPrint);
    $('#saveStatus').addEventListener('click', () => { if (dirty && !saving) save(); });

    $('#addBtn').addEventListener('click', () => openEntryDialog());
    $('#gridBody').addEventListener('click', (e) => {
      const td = e.target.closest('td[data-id]');
      if (!td) return;
      const entry = sheet.doc.entries.find(x => x.id === td.dataset.id);
      if (entry) openEntryDialog(entry);
    });

    $('#entryForm').addEventListener('submit', (e) => { e.preventDefault(); submitEntry(false); });
    $('#entryAddAnother').addEventListener('click', () => submitEntry(true));
    $('#entryCancel').addEventListener('click', () => dlg.close());
    $('#entryDelete').addEventListener('click', deleteEntry);

    $('#settingsBtn').addEventListener('click', () => openSettings());
    $('#sTest').addEventListener('click', testSettings);
    $('#sCancel').addEventListener('click', () => sdlg.close());
    $('#settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      settings = readSettingsForm();
      store.set('crs-settings', settings);
      idxCache.clear();
      sdlg.close();
      loadDashboard();
    });

    window.addEventListener('beforeunload', (e) => {
      if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
    });

    loadDashboard();
    if (!isConfigured()) openSettings('Welcome! Connect this device to GitHub to get started.');
  }

  init();
})();
