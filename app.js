(() => {
  'use strict';

  // ---------- Constants ----------
  const MATERIALS = [
    { id: 'Aluminium',    group: 'alu' },
    { id: 'PET - Clear',  group: 'other' },
    { id: 'PET - Colour', group: 'other' },
    { id: 'HDPE',         group: 'other' },
    { id: 'LPB',          group: 'other' },
    { id: 'Steel',        group: 'other' },
    { id: 'Glass',        group: 'glass' },
  ];
  const groupOf = (material) => (MATERIALS.find(m => m.id === material) || { group: 'other' }).group;
  const MIN_ROWS = 20;
  const cfg = window.CRS_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const nowIso = () => new Date().toISOString();
  const todayLocal = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

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
  function headers(s = settings, json = false) {
    const h = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${s.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
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

  async function getFile(path) {
    const res = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(settings.branch)}`,
      { headers: headers(), cache: 'no-store' });
    if (res.status === 404) {
      // Could be "file missing" or "repo missing" – check the repo so we report the right thing.
      const repo = await fetch(repoUrl(), { headers: headers(), cache: 'no-store' });
      if (!repo.ok) throw await apiError(repo);
      return null;
    }
    if (!res.ok) throw await apiError(res);
    const j = await res.json();
    return { doc: JSON.parse(b64decode(j.content)), sha: j.sha };
  }

  async function putFile(path, doc, sha, message) {
    const body = {
      message,
      content: b64encode(JSON.stringify(doc, null, 2) + '\n'),
      branch: settings.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(contentsUrl(path), { method: 'PUT', headers: headers(settings, true), body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) {
      const e = await apiError(res); e.conflict = true; throw e;
    }
    if (!res.ok) throw await apiError(res);
    return (await res.json()).content.sha;
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

  // ---------- State ----------
  let sheet = null;       // { path, sha, doc }
  let saving = false, saveAgain = false, dirty = false, lastMsg = 'Update sheet';

  // ---------- Save ----------
  function setSaveStatus(text, kind = '') {
    const el = $('#saveStatus');
    el.textContent = text;
    el.className = `status-btn ${kind}`;
  }

  async function save(message) {
    if (message) lastMsg = message;
    if (!sheet) return;
    if (saving) { saveAgain = true; return; }
    saving = true;
    setSaveStatus('Saving…', 'busy');
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          sheet.doc.updatedAt = nowIso();
          sheet.sha = await putFile(sheet.path, sheet.doc, sheet.sha, lastMsg);
          break;
        } catch (e) {
          if (!e.conflict || attempt >= 2) throw e;
          // Someone else saved first – pull their version, merge, try again.
          const remote = await getFile(sheet.path);
          if (remote) { sheet.doc = merge(remote.doc, sheet.doc); sheet.sha = remote.sha; }
          else sheet.sha = null;
          render();
        }
      }
      dirty = false;
      setSaveStatus(`✓ Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'ok');
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
  }
  function showSheet() {
    $('#startView').hidden = true;
    $('#sheetView').hidden = false;
    window.scrollTo(0, 0);
  }

  function cell(text, cls, entryId) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (text !== undefined && text !== null) td.textContent = text;
    if (entryId) { td.dataset.id = entryId; td.classList.add('filled'); td.title = 'Tap to edit'; }
    return td;
  }

  function render() {
    if (!sheet) return;
    const m = sheet.doc.meta;
    $('#mDate').textContent = m.date ? m.date.split('-').reverse().join('/') : '';
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
      if (!n) continue;
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${mat.id}: ${n}`;
      summary.append(chip);
    }
  }

  // ---------- Start form ----------
  function refreshCarrierList() {
    const list = $('#carrierList');
    list.textContent = '';
    for (const c of store.get('crs-carriers', [])) {
      const opt = document.createElement('option'); opt.value = c; list.append(opt);
    }
  }
  function rememberCarrier(c) {
    const list = store.get('crs-carriers', []).filter(x => x.toLowerCase() !== c.toLowerCase());
    list.unshift(c);
    store.set('crs-carriers', list.slice(0, 30));
    refreshCarrierList();
  }

  async function openSheet(meta) {
    const btn = $('#openBtn'), st = $('#startStatus');
    btn.disabled = true;
    st.className = 'status'; st.textContent = 'Checking for an existing sheet…';
    try {
      const path = buildPath(meta);
      const found = await getFile(path);
      if (found) {
        sheet = { path, sha: found.sha, doc: found.doc };
        setSaveStatus(`Opened existing sheet (${found.doc.entries.length} entries)`, 'ok');
      } else {
        sheet = { path, sha: null, doc: newDoc(meta) };
        setSaveStatus('New sheet – saves when the first entry is added');
      }
      dirty = false;
      rememberCarrier(meta.carrier);
      render();
      showSheet();
    } catch (e) {
      st.className = 'status err'; st.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshSheet() {
    if (!sheet) return;
    if (saving) return;
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

  // ---------- Entry dialog ----------
  const dlg = $('#entryDialog');
  let selMaterial = null;
  let editing = null; // entry being edited, or null when adding

  function buildMaterialButtons() {
    const grid = $('#matGrid');
    for (const m of MATERIALS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.id;
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
      showStart();
    });
    $('#refreshBtn').addEventListener('click', refreshSheet);
    $('#printBtn').addEventListener('click', () => window.print());
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
      sdlg.close();
    });

    window.addEventListener('beforeunload', (e) => {
      if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
    });

    if (!isConfigured()) openSettings('Welcome! Connect this device to GitHub to get started.');
  }

  init();
})();
