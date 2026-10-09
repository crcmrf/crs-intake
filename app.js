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
  // Dropdown choices – can be changed in config.js (carriers: [...], locations: [...]).
  const CARRIERS = (window.CRS_CONFIG && window.CRS_CONFIG.carriers) || ['Hawkins', 'MAMS'];
  const LOCATIONS = (window.CRS_CONFIG && window.CRS_CONFIG.locations) || ['Normanton', 'Badu Island', 'Thursday Island'];
  const OTHER = '__other__';
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
  // When a sheet's details change it moves to a new file and leaves a small
  // { movedTo } marker behind – follow those so old links/lookups still work.
  async function getSheet(path) {
    for (let hop = 0; hop < 5; hop++) {
      const f = await getFile(path);
      if (f && f.doc && f.doc.movedTo) { path = f.doc.movedTo; continue; }
      return { path, found: f, moved: hop > 0 };
    }
    return { path, found: null, moved: true };
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
    const localMetaNewer = (local.metaUpdatedAt || '') > (remote.metaUpdatedAt || '');
    return {
      ...remote,
      meta: localMetaNewer ? local.meta : remote.meta,
      metaUpdatedAt: localMetaNewer ? local.metaUpdatedAt : remote.metaUpdatedAt,
      entries, deleted: [...deleted],
    };
  }

  // ---------- Summary index ----------
  // One small file per month (data/_index/2026-10.json) listing every sheet with its
  // material counts, so the home page loads with a handful of requests.
  const indexPath = (month) => `${settings.dataDir}/_index/${month}.json`;
  const idxCache = new Map(); // index path -> { sha, doc }

  function summarize(path, doc) {
    const counts = {};
    let glassKg = 0, toWeigh = 0, done = 0;
    for (const e of doc.entries) {
      counts[e.material] = (counts[e.material] || 0) + 1;
      if (e.done) done++;
      if (groupOf(e.material) === 'glass') {
        if (e.weight === '' || e.weight == null) toWeigh++;
        else glassKg += Number(e.weight) || 0;
      }
    }
    const m = doc.meta;
    return {
      path, date: m.date, carrier: m.carrier, rego: m.rego, bin: m.bin || '', location: m.location || '',
      manifest: m.manifest || '', done,
      counts, glassKg: Math.round(glassKg * 10) / 10, toWeigh, total: doc.entries.length,
      updatedAt: doc.updatedAt || nowIso(),
      // [material, bag or IBC number, ticked] – used by the search box
      items: doc.entries.map(e => [e.material, String((groupOf(e.material) === 'glass' ? e.ibc : e.bag) || ''), e.done ? 1 : 0]),
    };
  }

  async function writeIndexEntry(sheetPath, doc, oldPath) {
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
      let changed = false;
      if (oldPath && oldPath !== sheetPath && oldPath in next.sheets) { delete next.sheets[oldPath]; changed = true; }
      if (sum) { next.sheets[sheetPath] = sum; changed = true; }
      else if (sheetPath in next.sheets) { delete next.sheets[sheetPath]; changed = true; }
      if (!changed) { idxCache.set(ipath, cur); return; } // nothing to change
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
          let remote = await getFile(s.path);
          if (remote && remote.doc.movedTo) {
            // Another device changed this sheet's details – follow it to its new file.
            const r = await getSheet(remote.doc.movedTo);
            s.path = r.path; remote = r.found;
          }
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

  let highlight = null; // { material, number } from a search result
  const normNum = (v) => String(v || '').toLowerCase().replace(/\s+/g, '');
  function isHit(e) {
    if (!highlight) return false;
    if (highlight.material && e.material !== highlight.material) return false;
    const n = normNum(groupOf(e.material) === 'glass' ? e.ibc : e.bag);
    return !!highlight.number && n === highlight.number;
  }

  function cell(text, cls, entry, withTick) {
    const td = el('td', cls);
    if (entry) {
      td.dataset.id = entry.id;
      td.classList.add('filled');
      if (entry.done) td.classList.add('done');
      if (isHit(entry)) td.classList.add('hit');
      td.title = 'Tap to edit';
      if (withTick) {
        const wrap = el('label', 'tick-wrap');
        const cb = el('input', 'tick');
        cb.type = 'checkbox';
        cb.checked = !!entry.done;
        cb.dataset.tick = entry.id;
        cb.title = entry.done ? 'Completed – tap to undo' : 'Tick off when complete';
        cb.setAttribute('aria-label', 'Completed');
        wrap.append(cb);
        td.append(wrap);
      }
    }
    if (text !== '' && text !== undefined && text !== null) td.append(el('span', 'txt', text));
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
    const man = $('#mManifest');
    man.textContent = m.manifest || 'tap to add';
    man.classList.toggle('placeholder', !m.manifest);

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
        cell(a ? i + 1 : '', 'idx', a, true),
        cell(a ? a.bag : '', '', a),
        cell(o ? o.material : '', '', o, true),
        cell(o ? o.bag : '', '', o),
        cell(g ? g.ibc : '', '', g, true),
        g && (g.weight === '' || g.weight == null)
          ? cell('to weigh', 'pending', g)
          : cell(g ? g.weight : '', '', g),
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
    if (entries.length) {
      const done = entries.filter(e => e.done).length;
      summary.append(el('span', `chip ${done === entries.length ? 'chip-done' : ''}`,
        done === entries.length ? `✓ All ${done} ticked off` : `✓ ${done} of ${entries.length} ticked off`));
    }
  }

  function toggleDone(id, done) {
    const e = sheet && sheet.doc.entries.find(x => x.id === id);
    if (!e) return;
    e.done = done;
    if (done) e.doneAt = nowIso(); else delete e.doneAt;
    e.updatedAt = nowIso();
    dirty = true;
    render();
    const m = sheet.doc.meta;
    save(`${done ? 'Tick off' : 'Untick'} ${e.material} ${e.ibc ? 'IBC ' + e.ibc : 'bag ' + e.bag} – ${m.carrier} ${m.rego} ${m.date}`);
  }

  // ---------- Edit sheet details (everything except the date) ----------
  const ddlg = $('#detailsDialog');
  const DETAIL_LABELS = { carrier: 'carrier', rego: 'rego', bin: 'bin no', location: 'location', manifest: 'manifest no' };

  function openDetails(focusId) {
    if (!sheet) return;
    const m = sheet.doc.meta;
    $('#dDate').textContent = fmtDate(m.date);
    setCombo('#dCarrier', m.carrier || '');
    $('#dRego').value = m.rego || '';
    $('#dBin').value = m.bin || '';
    setCombo('#dLocation', m.location || '');
    $('#dManifest').value = m.manifest || '';
    $('#detailsError').textContent = '';
    ddlg.showModal();
    if (focusId) setTimeout(() => $(focusId).focus(), 0);
  }

  async function saveDetails() {
    const err = $('#detailsError');
    err.textContent = '';
    if (!sheet) return;
    if (saving) { err.textContent = 'Still saving the last change – try again in a moment.'; return; }
    const s = sheet;
    const old = s.doc.meta;
    const meta = {
      ...old,
      carrier: $('#dCarrier').value.trim(),
      rego: $('#dRego').value.trim().toUpperCase().replace(/\s+/g, ''),
      bin: $('#dBin').value.trim(),
      location: $('#dLocation').value.trim(),
      manifest: $('#dManifest').value.trim(),
    };
    if (!meta.carrier || !meta.rego) { err.textContent = 'Carrier and truck rego are required.'; return; }
    const changed = Object.keys(DETAIL_LABELS).filter(k => (old[k] || '') !== meta[k]);
    if (!changed.length) { ddlg.close(); return; }
    if (!meta.manifest) delete meta.manifest;

    const msg = `Change ${changed.map(k => DETAIL_LABELS[k]).join(', ')} – ${meta.carrier} ${meta.rego} ${meta.date}`;
    const newPath = buildPath(meta);

    // Only the manifest (or capital letters) changed – same file, normal save.
    if (newPath === s.path) {
      s.doc.meta = meta;
      s.doc.metaUpdatedAt = nowIso();
      dirty = true;
      ddlg.close();
      render();
      rememberCarrier(meta.carrier);
      save(msg);
      return;
    }

    // Carrier / rego / bin / location changed – the sheet moves to a new file.
    const btn = $('#dSave');
    btn.disabled = true;
    saving = true;
    setSaveStatus('Saving…', 'busy');
    try {
      const existing = await getFile(newPath);
      if (existing && !existing.doc.movedTo) {
        err.textContent = `There's already a sheet for ${meta.carrier} ${meta.rego} on ${fmtDate(meta.date)} with those details. Open that one from the home page instead.`;
        setSaveStatus('');
        return;
      }
      const oldPath = s.path;
      let doc = { ...s.doc, meta, metaUpdatedAt: nowIso(), updatedAt: nowIso() };
      let newSha = await putFile(newPath, doc, existing ? existing.sha : null, msg);

      if (s.sha) {
        const stub = { version: 1, movedTo: newPath, movedAt: nowIso() };
        try {
          await putFile(oldPath, stub, s.sha, `Details changed – moved to ${newPath}`);
        } catch (e) {
          if (!e.conflict) throw e;
          // Someone saved the old sheet at the same moment – fold their entries in, then mark it moved.
          const latest = await getFile(oldPath);
          if (latest && !latest.doc.movedTo) {
            doc = merge(latest.doc, doc);
            newSha = await putFile(newPath, doc, newSha, msg);
            await putFile(oldPath, stub, latest.sha, `Details changed – moved to ${newPath}`);
          }
        }
      }

      s.path = newPath;
      s.sha = newSha;
      s.doc = doc;
      dirty = false;
      rememberCarrier(meta.carrier);
      try { await writeIndexEntry(newPath, doc, oldPath); } catch { /* summary catches up on next save */ }
      setSaveStatus('✓ Details updated', 'ok');
      ddlg.close();
      render();
    } catch (e) {
      err.textContent = e.message;
      setSaveStatus(`⚠ Details not saved (${e.message})`, 'err');
    } finally {
      saving = false;
      btn.disabled = false;
      if (saveAgain) { saveAgain = false; save(); }
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
      const { path, found, moved } = await getSheet(knownPath || buildPath(meta));
      if (found) {
        sheet = { path, sha: found.sha, doc: found.doc };
        setSaveStatus(moved
          ? `This sheet's details were changed – opened the updated sheet (${found.doc.entries.length} entries)`
          : `Opened existing sheet (${found.doc.entries.length} entries)`, 'ok');
      } else {
        sheet = { path, sha: null, doc: newDoc(meta) };
        setSaveStatus('New sheet – saves when the first entry is added');
      }
      dirty = false;
      rememberCarrier(sheet.doc.meta.carrier);
      render();
      showSheet();
      const hit = document.querySelector('#gridBody td.hit');
      if (hit) setTimeout(() => hit.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
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
      const r = await getSheet(sheet.path);
      const found = r.found;
      sheet.path = r.path;
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
  // Recent loads, By location and the search box each have their own period.
  // Monthly summary files are fetched once per visit to the home page and shared.
  const ALL_RANGE = { id: 'all', label: 'All entries' };
  const PANELS = {
    recent: { sel: '#rangeSel', key: 'crs-range',        def: '7d',  all: false, sheets: [], seq: 0 },
    loc:    { sel: '#locRange', key: 'crs-range-loc',    def: '1m',  all: false, sheets: [], seq: 0 },
    search: { sel: '#qRange',   key: 'crs-range-search', def: 'all', all: true,  sheets: [], seq: 0 },
  };
  let recentShown = RECENT_PAGE;

  function panelRange(name) {
    const v = $(PANELS[name].sel).value;
    return v === 'all' ? ALL_RANGE : (RANGES.find(r => r.id === v) || RANGES[0]);
  }
  const rangeText = (r) => (r.id === 'all' ? 'all entries' : r.label.toLowerCase());

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

  let monthCache = new Map();   // 'YYYY-MM' -> Promise<index doc | null>
  let allMonthsPromise = null;  // Promise<['YYYY-MM', ...]> – every month that has a summary file
  function resetDashCache() { monthCache = new Map(); allMonthsPromise = null; }

  function fetchMonth(m) {
    if (!monthCache.has(m)) {
      const p = getFile(indexPath(m), { checkRepo: false }).then(f => {
        if (f) idxCache.set(indexPath(m), { sha: f.sha, doc: f.doc });
        return f ? f.doc : null;
      });
      p.catch(() => monthCache.delete(m));
      monthCache.set(m, p);
    }
    return monthCache.get(m);
  }
  function listAllMonths() {
    if (!allMonthsPromise) {
      allMonthsPromise = (async () => {
        const res = await fetch(`${contentsUrl(`${settings.dataDir}/_index`)}?ref=${encodeURIComponent(settings.branch)}`,
          { headers: headers(), cache: 'no-store' });
        if (res.status === 404) return [];
        if (!res.ok) throw await apiError(res);
        return (await res.json())
          .map(f => (f.name.match(/^(\d{4}-\d{2})\.json$/) || [])[1])
          .filter(Boolean).sort();
      })();
      allMonthsPromise.catch(() => { allMonthsPromise = null; });
    }
    return allMonthsPromise;
  }

  async function loadSheetsFor(r) {
    const all = r.id === 'all';
    const from = all ? '0000-01-01' : rangeStart(r);
    const to = all ? '9999-12-31' : todayLocal();
    const months = all ? await listAllMonths() : monthsBetween(from, todayLocal());
    const docs = [];
    await pool(months, 4, async (m) => { docs.push(await fetchMonth(m)); });
    const list = [];
    for (const d of docs) {
      if (!d) continue;
      for (const s of Object.values(d.sheets || {})) {
        if (s.date >= from && s.date <= to) list.push(s);
      }
    }
    list.sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return list;
  }

  function setStatus(sel, text, kind = '') {
    const s = $(sel);
    s.textContent = text;
    s.className = `${sel === '#searchStatus' ? 'hint' : 'status'} ${kind}`;
  }
  const countText = (n, r) => (n ? `${n} load${n === 1 ? '' : 's'} · ${rangeText(r)}` : '');

  const PANEL_VIEW = {
    recent: {
      render: () => renderRecent(),
      status: (t, k) => setStatus('#dashStatus', t, k),
      done: (list, r) => { setStatus('#dashStatus', countText(list.length, r)); refreshCarrierList(list.map(x => x.carrier)); },
    },
    loc: {
      render: () => renderLocation(),
      status: (t, k) => setStatus('#locStatus', t, k),
      done: (list, r) => setStatus('#locStatus', countText(list.length, r)),
    },
    search: {
      render: () => runSearch(),
      status: (t, k) => setStatus('#searchStatus', t, k),
      done: () => {},
    },
  };

  async function loadPanel(name) {
    const P = PANELS[name], V = PANEL_VIEW[name];
    const seq = ++P.seq;
    const r = panelRange(name);
    if (!isConfigured()) {
      P.sheets = [];
      V.render();
      V.status(name === 'recent' ? 'Connect to GitHub in ⚙ Settings to see recent loads.' : '');
      return;
    }
    V.status(r.id === 'all' ? 'Loading all entries…' : 'Loading…');
    try {
      const list = await loadSheetsFor(r);
      if (seq !== P.seq) return; // a newer load started
      P.sheets = list;
      if (name === 'recent') recentShown = RECENT_PAGE;
      V.render();
      V.done(list, r);
    } catch (e) {
      if (seq !== P.seq) return;
      V.status(e.message, 'err');
    }
  }

  let firstDashLoad = true;
  function loadDashboard() {
    resetDashCache(); // fresh data each time the home page is shown
    if (firstDashLoad || !$('#reportList').childElementCount) loadReports();
    firstDashLoad = false;
    loadPanel('recent');
    loadPanel('loc');
    loadPanel('search');
  }

  // ---------- Monthly reports (made by the GitHub job in the data repo) ----------
  const reportsDir = () => (cfg.reportsDir || 'reports').replace(/^\/+|\/+$/g, '');
  let reportsShowAll = false;

  async function loadReports() {
    const list = $('#reportList'), st = $('#reportStatus');
    list.textContent = '';
    st.className = 'status';
    if (!isConfigured()) { st.textContent = ''; return; }
    st.textContent = 'Loading…';
    try {
      const res = await fetch(`${contentsUrl(reportsDir())}?ref=${encodeURIComponent(settings.branch)}`,
        { headers: headers(), cache: 'no-store' });
      if (res.status === 404) {
        st.textContent = 'No monthly reports yet. They appear here after the first automatic run on the 1st of the month.';
        return;
      }
      if (!res.ok) throw await apiError(res);
      const files = (await res.json())
        .filter(f => f.type === 'file' && /\.xlsx$/i.test(f.name))
        .map(f => ({ ...f, month: (f.name.match(/(\d{4})-(\d{2})/) || [])[0] || '' }))
        .sort((a, b) => b.month.localeCompare(a.month) || b.name.localeCompare(a.name));
      st.textContent = files.length ? '' : 'No monthly reports yet.';
      const shown = reportsShowAll ? files : files.slice(0, 6);
      for (const f of shown) {
        let label = f.name;
        if (f.month) {
          const [y, m] = f.month.split('-').map(Number);
          label = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
        }
        const b = el('button', 'report-item');
        b.type = 'button';
        b.title = f.name;
        b.append(el('span', 'report-icon', 'XLSX'), el('span', 'report-name', label), el('span', 'report-dl', '⬇'));
        b.addEventListener('click', () => downloadReport(f, b));
        list.append(b);
      }
      if (files.length > shown.length) {
        const more = el('button', 'more', `Show all ${files.length} reports`);
        more.type = 'button';
        more.addEventListener('click', () => { reportsShowAll = true; loadReports(); });
        list.append(more);
      }
    } catch (e) {
      st.className = 'status err';
      st.textContent = e.message;
    }
  }

  async function downloadReport(f, btn) {
    btn.disabled = true;
    try {
      const res = await fetch(`${contentsUrl(f.path)}?ref=${encodeURIComponent(settings.branch)}`,
        { headers: headers(settings, { Accept: 'application/vnd.github.raw' }), cache: 'no-store' });
      if (!res.ok) throw await apiError(res);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = f.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function openFromSummary(s, hl = null) {
    highlight = hl;
    $('#fDate').value = s.date;
    setCombo('#fCarrier', s.carrier);
    $('#fRego').value = s.rego;
    $('#fBin').value = s.bin || '';
    setCombo('#fLocation', s.location || '');
    openSheet({ date: s.date, carrier: s.carrier, rego: s.rego, bin: s.bin || '', location: s.location || '' }, s.path);
  }

  // ---------- Search bags / IBCs ----------
  const SEARCH_LIMIT = 100;
  function runSearch() {
    const mat = $('#qMat').value;
    const raw = $('#qNum').value.trim();
    const q = normNum(raw);
    const out = $('#searchResults'), st = $('#searchStatus');
    out.textContent = '';
    st.className = 'hint';
    if (!q) {
      st.textContent = mat
        ? `Type a ${groupOf(mat) === 'glass' ? 'IBC' : 'bag'} number to search ${mat} only.`
        : 'Type a bag or IBC number. Leave the product as "Any product" to search everything.';
      return;
    }
    const sr = panelRange('search');
    const range = rangeText(sr);
    const results = [];
    let missing = 0;
    for (const s of PANELS.search.sheets) {
      if (!Array.isArray(s.items)) { if (s.total) missing++; continue; }
      for (const [m, num, done] of s.items) {
        if (mat && m !== mat) continue;
        const n = normNum(num);
        if (!n.includes(q)) continue;
        results.push({ s, material: m, number: num, done, exact: n === q });
      }
    }
    results.sort((a, b) => (b.exact - a.exact) || b.s.date.localeCompare(a.s.date) || a.number.localeCompare(b.number, undefined, { numeric: true }));
    const exact = results.filter(r => r.exact).length;
    const what = mat ? `${mat} ` : '';
    st.textContent = results.length
      ? `${exact} exact match${exact === 1 ? '' : 'es'}${results.length > exact ? `, ${results.length - exact} containing "${raw}"` : ''} for ${what}"${raw}" · ${range}`
      : `No ${mat ? `${mat} ${groupOf(mat) === 'glass' ? 'IBCs' : 'bags'}` : 'bags or IBCs'} matching "${raw}" · ${range}.` +
        (sr.id === 'all' ? '' : ' Try a longer period, or "All entries".');
    if (missing) {
      const note = el('div', 'search-note');
      note.append(el('span', '', `${missing} load${missing === 1 ? ' was' : 's were'} saved before search was added and can't be searched yet.`));
      const fix = el('button', 'excel-btn', 'Make them searchable');
      fix.type = 'button';
      fix.addEventListener('click', () => rebuildIndex(sr, (t, k) => setStatus('#searchStatus', t, k), fix));
      note.append(fix);
      out.append(note);
    }

    for (const r of results.slice(0, SEARCH_LIMIT)) {
      const g = groupOf(r.material);
      const b = el('button', `search-item${r.exact ? ' exact' : ''}`);
      b.type = 'button';
      b.title = 'Open this sheet';

      const left = el('div', 'si-left');
      left.append(el('span', `chip ${g}`, r.material));
      const num = el('span', `si-num${r.done ? ' done' : ''}`);
      const i = r.number.toLowerCase().indexOf(raw.toLowerCase());
      if (i >= 0) {
        num.append(document.createTextNode(r.number.slice(0, i)), el('mark', '', r.number.slice(i, i + raw.length)),
          document.createTextNode(r.number.slice(i + raw.length)));
      } else {
        num.textContent = r.number;
      }
      left.append(el('span', 'si-kind', g === 'glass' ? 'IBC' : 'Bag'), num);
      if (r.done) left.append(el('span', 'chip chip-done', '✓ Ticked'));

      const right = el('div', 'si-right');
      right.append(el('div', 'si-load', `${fmtDate(r.s.date)} · ${r.s.carrier} · ${r.s.rego}`));
      const sub = [r.s.location, r.s.bin && `Bin ${r.s.bin}`, r.s.manifest && `Manifest ${r.s.manifest}`].filter(Boolean).join(' · ');
      if (sub) right.append(el('div', 'si-sub', sub));

      b.append(left, right);
      b.addEventListener('click', () => openFromSummary(r.s, { material: r.material, number: normNum(r.number) }));
      out.append(b);
    }
    if (results.length > SEARCH_LIMIT) {
      out.append(el('p', 'hint', `Showing the first ${SEARCH_LIMIT} of ${results.length}. Type more of the number to narrow it down.`));
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
    const locSheets = PANELS.loc.sheets;
    if (!locSheets.length) { alert('There are no loads in this period to export.'); return; }
    try {
      const r = panelRange('loc');
      const matHead = MATERIALS.map(m => (m.group === 'glass' ? 'Glass (IBC)' : m.id));
      const kg = (n) => Math.round((n || 0) * 10) / 10;

      // Sheet 1: totals by location
      const { rows, total } = groupByLocation(locSheets);
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
        ['Date', 'Carrier', 'Truck Rego', 'Bin No', 'Location', 'Manifest No', ...matHead, 'Glass kg', 'Glass to weigh', 'Total items', 'Ticked off'],
        ...locSheets.map(s => [
          xlDate(s.date), s.carrier, s.rego, s.bin || '', s.location || '', s.manifest || '',
          ...MATERIALS.map(m => (s.counts || {})[m.id] || 0),
          kg(s.glassKg), s.toWeigh || 0, s.total || 0, s.done || 0,
        ]),
      ];

      window.downloadXlsx(safeName(`CRS summary - ${r.label} - ${todayLocal()}.xlsx`), [
        { name: 'By location', rows: loc, widths: [24, 8, ...MATERIALS.map(() => 13), 10],
          titleRows: [0], boldRows: [3, loc.length - 1] },
        { name: 'Loads', rows: loads, widths: [12, 22, 12, 8, 18, 14, ...MATERIALS.map(() => 13), 10, 14, 11, 11],
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
        ['Manifest No', m.manifest || ''],
        [],
        ['Material', 'Bag Number', 'IBC #', 'Weight (kg)', 'Added', 'Ticked off'],
        ...entries.map(e => [
          e.material, e.bag || '', e.ibc || '',
          e.weight === '' || e.weight == null ? '' : Number(e.weight),
          time(e.createdAt),
          e.done ? `Yes ${time(e.doneAt)}`.trim() : '',
        ]),
        [],
        ['Totals'],
        ...totals,
      ];
      const totalsRow = 8 + entries.length;
      window.downloadXlsx(safeName(`${m.date} ${m.carrier} ${m.rego}.xlsx`), [
        { name: 'Sheet', rows, widths: [16, 16, 12, 12, 10, 14], titleRows: [0], boldRows: [6, totalsRow] },
      ]);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  }

  function renderRecent() {
    const recentSheets = PANELS.recent.sheets;
    const listEl = $('#recentList');
    listEl.textContent = '';
    if (!recentSheets.length) {
      listEl.append(el('div', 'empty', isConfigured() ? 'No loads in this period.' : ''));
    }
    for (const s of recentSheets.slice(0, recentShown)) {
      const b = el('button', 'recent-item');
      b.type = 'button';
      b.title = 'Open this sheet';

      const date = el('div', 'ri-date');
      date.append(el('b', '', fmtDate(s.date).slice(0, 5)), el('span', '', dayLabel(s.date)));

      const main = el('div', 'ri-main');
      const title = el('div', 'ri-title');
      title.append(document.createTextNode(`${s.carrier} · `), el('span', 'rego', s.rego));
      main.append(title);
      const sub = [s.bin && `Bin ${s.bin}`, s.location, s.manifest && `Manifest ${s.manifest}`].filter(Boolean).join(' · ');
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

      if (s.total) {
        const all = (s.done || 0) >= s.total;
        chips.append(el('span', `chip ${all ? 'chip-done' : 'chip-todo'}`, all ? '✓ All ticked' : `✓ ${s.done || 0}/${s.total}`));
      }
      b.append(date, main, chips);
      b.addEventListener('click', () => openFromSummary(s));
      listEl.append(b);
    }
    const more = $('#recentMore');
    more.hidden = recentSheets.length <= recentShown;
    more.textContent = `Show more (${recentSheets.length - recentShown} more)`;
  }

  function renderLocation() {
    const { rows, total } = groupByLocation(PANELS.loc.sheets);

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
  async function rebuildIndex(r, status, btn) {
    if (!isConfigured()) { openSettings('Set up the GitHub connection first.'); return; }
    if (!confirm(`Rebuild the summary for ${rangeText(r)}? This re-reads every sheet in that period and may take a minute.`)) return;
    if (btn) btn.disabled = true;
    try {
      status('Listing sheets…');
      const res = await fetch(`${repoUrl()}/git/trees/${encodeURIComponent(settings.branch)}?recursive=1`,
        { headers: headers(), cache: 'no-store' });
      if (!res.ok) throw await apiError(res);
      const tree = await res.json();
      const dir = settings.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${dir}/(\\d{4}-\\d{2})-\\d{2}/[^/]+\\.json$`);
      const allPaths = (tree.tree || []).filter(t => t.type === 'blob' && re.test(t.path)).map(t => t.path);
      const months = r.id === 'all'
        ? [...new Set(allPaths.map(p => p.match(re)[1]))].sort()
        : monthsBetween(rangeStart(r), todayLocal());
      const paths = allPaths.filter(p => months.includes(p.match(re)[1]));

      const byMonth = new Map(months.map(m => [m, {}]));
      let done = 0;
      await pool(paths, 5, async (p) => {
        const f = await getFile(p, { checkRepo: false });
        if (f && f.doc && f.doc.meta && (f.doc.entries || []).length) {
          byMonth.get(p.match(re)[1])[p] = summarize(p, f.doc);
        }
        done++;
        status(`Reading sheets ${done}/${paths.length}…`);
      });

      status('Writing summary…');
      for (const [month, sheets] of byMonth) {
        const ipath = indexPath(month);
        const existing = await getFile(ipath, { checkRepo: false });
        if (!existing && !Object.keys(sheets).length) continue;
        const doc = { version: 1, month, sheets, updatedAt: nowIso() };
        const sha = await putFile(ipath, doc, existing && existing.sha, `Rebuild summary ${month}`);
        idxCache.set(ipath, { sha, doc });
      }
      if (tree.truncated) alert('The repository is very large, so some sheets may not have been included.');
      loadDashboard();
    } catch (e) {
      status(`Rebuild failed: ${e.message}`, 'err');
    } finally {
      if (btn) btn.disabled = false;
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

  // ---------- Dropdown with an "Other (type it in)" option ----------
  // The original text box stays the real value; the dropdown fills it in.
  function setupCombo(inputSel, options, blankLabel) {
    const input = $(inputSel);
    const required = input.required;
    const sel = el('select', 'combo');
    sel.id = `${input.id}Sel`;
    sel.required = required;
    sel.append(new Option(blankLabel, ''));
    for (const o of options) sel.append(new Option(o, o));
    sel.append(new Option('Other (type it in)…', OTHER));
    input.before(sel);
    input.placeholder = 'Type it in';
    input.classList.add('combo-other');
    const apply = (focus) => {
      const other = sel.value === OTHER;
      input.hidden = !other;
      input.required = other && required;
      if (!other) input.value = sel.value;
      else if (focus) { input.value = ''; input.focus(); }
    };
    sel.addEventListener('change', () => apply(true));
    input._combo = { sel, apply, options };
    apply(false);
  }
  function setCombo(inputSel, value) {
    const input = $(inputSel), c = input._combo;
    const v = String(value || '').trim();
    if (!c) { input.value = v; return; }
    const match = c.options.find(o => o.toLowerCase() === v.toLowerCase());
    c.sel.value = !v ? '' : match || OTHER;
    c.apply(false);
    if (c.sel.value === OTHER) input.value = v;
  }

  // ---------- Wire up ----------
  function init() {
    $('#fDate').value = todayLocal();
    refreshCarrierList();
    // Search box
    const qMat = $('#qMat');
    qMat.append(new Option('Any product', ''));
    for (const m of MATERIALS) qMat.append(new Option(m.id, m.id));
    let searchTimer;
    $('#qNum').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
    qMat.addEventListener('change', runSearch);
    $('#qClear').addEventListener('click', () => { $('#qNum').value = ''; qMat.value = ''; runSearch(); $('#qNum').focus(); });
    runSearch();

    setupCombo('#fCarrier', CARRIERS, 'Choose carrier…');
    setupCombo('#fLocation', LOCATIONS, '— None —');
    setupCombo('#dCarrier', CARRIERS, 'Choose carrier…');
    setupCombo('#dLocation', LOCATIONS, '— None —');
    buildMaterialButtons();

    // Period dropdown (remembers the last choice on this device)
    // A period dropdown for each home-page panel (each remembers its own choice)
    for (const [name, P] of Object.entries(PANELS)) {
      const sel = $(P.sel);
      for (const r of RANGES) sel.append(new Option(r.label, r.id));
      if (P.all) sel.append(new Option(ALL_RANGE.label, ALL_RANGE.id));
      sel.value = store.get(P.key, P.def);
      if (!sel.value) sel.value = P.def;
      sel.addEventListener('change', () => { store.set(P.key, sel.value); loadPanel(name); });
    }
    $('#dashRefresh').addEventListener('click', () => { loadDashboard(); loadReports(); });
    $('#recentMore').addEventListener('click', () => { recentShown += RECENT_PAGE; renderRecent(); });
    $('#rebuildBtn').addEventListener('click', (e) =>
      rebuildIndex(panelRange('loc'), (t, k) => setStatus('#locStatus', t, k), e.currentTarget));
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
      sheet = null; dirty = false; highlight = null;
      // Clear the lookup so the next truck starts fresh
      $('#startForm').reset();
      $('#fDate').value = todayLocal();
      setCombo('#fCarrier', '');
      setCombo('#fLocation', '');
      showStart();
    });
    $('#refreshBtn').addEventListener('click', refreshSheet);
    $('#printBtn').addEventListener('click', () => { preparePrint(); window.print(); });
    window.addEventListener('beforeprint', preparePrint);
    window.addEventListener('afterprint', endPrint);
    $('#saveStatus').addEventListener('click', () => { if (dirty && !saving) save(); });

    $('#addBtn').addEventListener('click', () => openEntryDialog());
    $('#gridBody').addEventListener('change', (e) => {
      if (e.target.matches('input.tick')) toggleDone(e.target.dataset.tick, e.target.checked);
    });
    $('#gridBody').addEventListener('click', (e) => {
      if (e.target.closest('.tick-wrap')) return; // tick box handles itself
      const td = e.target.closest('td[data-id]');
      if (!td) return;
      const entry = sheet.doc.entries.find(x => x.id === td.dataset.id);
      if (entry) openEntryDialog(entry);
    });

    $('#editDetailsBtn').addEventListener('click', () => openDetails());
    $('#metaTable').addEventListener('click', (e) => {
      openDetails(e.target.closest('#mManifest, .manifest-row') ? '#dManifest' : null);
    });
    $('#detailsForm').addEventListener('submit', (e) => { e.preventDefault(); saveDetails(); });
    $('#dCancel').addEventListener('click', () => ddlg.close());
    $('#dRego').addEventListener('input', (e) => {
      const p = e.target.selectionStart;
      e.target.value = e.target.value.toUpperCase();
      e.target.setSelectionRange(p, p);
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
      loadReports();
    });

    window.addEventListener('beforeunload', (e) => {
      if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
    });

    loadDashboard();
    if (!isConfigured()) openSettings('Welcome! Connect this device to GitHub to get started.');
  }

  init();
})();
