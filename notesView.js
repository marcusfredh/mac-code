// Repo notes: a personal, local notepad per repository.
//
// Each repo gets a free-form scratchpad plus a list of items (ideas, todos, changes)
// that can be ticked off and marked per stage — "in dev", "in prod" — so it's clear
// where a change currently is. Notes are keyed by the GitHub repo (owner/name) when
// there is one, so every worktree and clone of the same repo shares them; otherwise
// by the main clone's folder.
//
// Storage is Mac Code's own data folder (repo-notes.json via window.notesApi). Nothing
// is ever written inside the repository, so notes can't end up in a commit.

(() => {
  'use strict';

  const DEFAULT_STAGES = ['dev', 'prod'];
  const SAVE_DELAY_MS = 400;
  const COPY_ICON = '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="4" y="4" width="6.5" height="6.5" rx="1.2" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M8 2.5V2.2c0-.6-.5-1-1-1H2.5c-.6 0-1 .4-1 1V7c0 .6.4 1 1 1h.3" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round"/></svg>';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24); if (d < 30) return d + 'd ago';
    return new Date(ts).toLocaleDateString();
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function cleanStage(s) { return String(s || '').trim().replace(/\s+/g, '-').slice(0, 20); }
  // A notesApi method, or null when the bridge (or that method) is missing — tests have none.
  const api = (fn) => window.notesApi && typeof window.notesApi[fn] === 'function' ? window.notesApi[fn].bind(window.notesApi) : null;

  // ---------- images ----------
  // Items may carry images: [{ id, ext, name }]. The files live in Mac Code's data folder
  // (noteImages.js in main), never in the repo. Thumbnails drag out as IMG_MIME so a chat
  // composer can attach them; Copy only ever puts their paths on the clipboard.
  const IMG_MIME = 'application/x-maccode-note-image';
  const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const IMG_EXTS = ['png', 'jpg', 'gif', 'webp'];
  const IMG_MAX = 10 * 1024 * 1024;
  // 'id.ext' → small thumbnail data URL | in-flight Promise | false (unreadable). Only the
  // ≤96px thumbnails are kept; the preview reads the full image on demand.
  const imgCache = new Map();
  const THUMB_MAX = 96;
  const unattached = new Set(); // saved but not in an item yet — kept out of the startup prune
  let imageDir = '';
  const imgKey = (im) => im.id + '.' + im.ext;
  const imagesOf = (it) => (it && Array.isArray(it.images) ? it.images : [])
    .filter((im) => im && typeof im.id === 'string' && typeof im.ext === 'string');
  function imgPath(dir, im) {
    const d = String(dir).replace(/[\\/]+$/, '');
    return d + (d.includes('\\') ? '\\' : '/') + imgKey(im);
  }
  // '![name](path)' per image; none without a dir.
  const imageLines = (it, dir) => dir ? imagesOf(it).map((im) => '![' + (im.name || im.id) + '](<' + imgPath(dir, im) + '>)') : [];
  const dtTypes = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []);
  const isNoteImgDrag = (e) => dtTypes(e).includes(IMG_MIME);
  const hasFiles = (e) => { const t = dtTypes(e); return t.includes('Files') && !t.includes(IMG_MIME); };
  const clipImages = (cd) => Array.from((cd && cd.items) || [])
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  function imgError(f) {
    if (!f.type.startsWith('image/')) return 'Not an image: ' + (f.name || 'file');
    if (!IMG_TYPES.includes(f.type)) return 'Only PNG, JPEG, GIF or WebP images';
    if (f.size > IMG_MAX) return 'Image is over 10 MB';
    return '';
  }
  async function saveImageFile(f) {
    const saveImage = api('saveImage');
    if (!saveImage) throw new Error('Images are not available');
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const base64 = btoa(bin);
    const res = await saveImage({ base64, mediaType: f.type });
    if (!res || !res.ok || !res.image) throw new Error((res && res.error) || 'Could not save image');
    const im = { id: res.image.id, ext: res.image.ext };
    const name = String(f.name || '').trim().slice(0, 100);
    if (name) im.name = name;
    cacheThumb(imgKey(im), () => {
      const u = URL.createObjectURL(f);
      return thumbFromSrc(u).finally(() => URL.revokeObjectURL(u));
    });
    return im;
  }
  // Decode src and scale it so the longest side is at most THUMB_MAX (never upscaled).
  // -> small PNG data URL, or null when it does not decode. GIFs keep only their first frame.
  function thumbFromSrc(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return resolve(null);
          const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        } catch (_) { resolve(null); } finally { img.src = ''; }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  // Cache make()'s thumbnail under k (false when it fails). A key deleted meanwhile stays deleted.
  function cacheThumb(k, make) {
    const p = Promise.resolve().then(make).then((url) => url || null, () => null).then((url) => {
      if (imgCache.get(k) === p) imgCache.set(k, url || false);
      return url;
    });
    imgCache.set(k, p);
    return p;
  }
  function deleteImg(im) {
    imgCache.delete(imgKey(im));
    unattached.delete(imgKey(im));
    try { const d = api('deleteImage'); if (d) Promise.resolve(d({ id: im.id, ext: im.ext })).catch(() => {}); } catch (_) {}
  }
  function loadThumb(im) {
    const k = imgKey(im), hit = imgCache.get(k);
    if (typeof hit === 'string') return Promise.resolve(hit);
    if (hit === false) return Promise.resolve(null);
    if (hit) return hit;
    const read = api('readImage');
    if (!read) return Promise.resolve(null);
    return cacheThumb(k, () => read({ id: im.id, ext: im.ext }).then((res) =>
      res && res.ok && res.base64 ? thumbFromSrc('data:' + (res.mediaType || 'image/png') + ';base64,' + res.base64) : null));
  }
  // The full-size image as a data URL (for the preview; never cached), or null.
  function readFull(im) {
    const read = api('readImage');
    if (!read) return Promise.resolve(null);
    return Promise.resolve().then(() => read({ id: im.id, ext: im.ext })).then((res) =>
      res && res.ok && res.base64 ? 'data:' + (res.mediaType || 'image/png') + ';base64,' + res.base64 : null, () => null);
  }
  // The JSON a thumbnail drag carries, validated; null when it isn't one of ours.
  function parseNoteImage(raw) {
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^[a-z0-9-]{8,40}$/.test(v.id)) return null;
      if (!IMG_EXTS.includes(v.ext) || (v.name !== undefined && typeof v.name !== 'string')) return null;
      return { id: v.id, ext: v.ext, name: v.name };
    } catch (_) { return null; }
  }
  // For the chat composers' drop handlers: a dragged note image as a File, or { error }.
  async function noteImageFile(raw) {
    const im = parseNoteImage(raw);
    if (!im) return { error: 'not a note image' };
    const read = api('readImage');
    if (!read) return { error: 'note images are not available' };
    try {
      const res = await read({ id: im.id, ext: im.ext });
      if (!res || !res.ok || typeof res.base64 !== 'string') return { error: 'could not read note image' };
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { file: new File([bytes], im.name || im.id + '.' + im.ext, { type: res.mediaType }) };
    } catch (_) { return { error: 'could not read note image' }; }
  }

  // ---------- store ----------
  let data = { version: 1, repos: {} };
  let loaded = false;
  let saveTimer = null;
  let loadOk = false;          // the notes file was read (a missing file is not a failure)
  const listeners = new Set();
  const ready = (window.notesApi ? window.notesApi.load() : Promise.resolve(null)).then((d) => {
    if (d && typeof d === 'object' && d.repos && typeof d.repos === 'object') { data = d; loadOk = true; }
    loaded = true;
    emit();
  }).catch(() => { loaded = true; });

  // Image files no item refers to (a crash mid-add, an item deleted elsewhere) are pruned
  // once the notes file has really been read — never after a failed load.
  try { const d = api('imageDir'); if (d) Promise.resolve(d()).then((v) => { if (typeof v === 'string') imageDir = v; }, () => {}); } catch (_) {}
  ready.then(() => {
    const prune = api('pruneImages');
    if (!loadOk || !prune) return;
    const keep = Array.from(unattached);
    for (const r of Object.values(data.repos)) for (const it of (r && Array.isArray(r.items) ? r.items : [])) for (const im of imagesOf(it)) keep.push(imgKey(im));
    return prune(keep);
  }).catch(() => {});

  // ---------- Mac Code's own errors become notes (errorNotes.js, errorHook.js) ----------
  // Records wait here until the store has loaded. If the notes file exists but could not
  // be read, nothing is saved over it: errors then only live in errors.log (main keeps its
  // own pending queue and is never asked to hand it over).
  const errQueue = [];
  const errSession = { added: 0 };
  let errReady = false, errCanWrite = false, appVersion = '';

  // rec: a raw renderer record (errorHook) or a formatted one from main.
  function addErrorNote(rec) {
    try {
      if (!errReady) { if (errQueue.length < 100) errQueue.push(rec); return; }
      const en = window.errorNotes;
      if (!en || !errCanWrite || !rec || typeof rec !== 'object' || en.shouldIgnore(rec)) return;
      const formatted = rec.text && rec.fingerprint ? rec
        : en.formatError(Object.assign({}, rec, { version: appVersion, now: Number.isFinite(rec.at) ? rec.at : Date.now() }));
      const res = en.addErrorToNotes(data, formatted, { newId, now: Date.now(), session: errSession });
      if (res.changed) save();
    } catch (_) {}
  }

  const errorsReady = ready.then(async () => {
    try {
      let exists = false;
      try { const st = window.notesApi && window.notesApi.status ? await window.notesApi.status() : null; exists = !!(st && st.exists); } catch (_) {}
      errCanWrite = loadOk || !exists;
      try { appVersion = String(await window.settingsApi.version()); } catch (_) {}
      errReady = true;
      const early = (window.__macErrorQueue || []).splice(0).concat(errQueue.splice(0));
      for (const r of early) addErrorNote(r);
      window.__macErrorSink = addErrorNote;
      const api = window.errorsApi;
      if (api && errCanWrite) {
        api.onNote(addErrorNote);                       // before takePending: that call switches live delivery on
        const pending = await api.takePending();
        if (Array.isArray(pending)) for (const r of pending) addErrorNote(r);
      }
    } catch (_) {}
  });

  function emit() { for (const fn of listeners) { try { fn(); } catch (_) {} } }
  function save() {
    if (!loaded) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    emit();
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (loaded && window.notesApi) window.notesApi.save(data);
  }
  window.addEventListener('beforeunload', () => { if (saveTimer) flush(); });

  function repoData(key, name) {
    if (!data.repos[key]) data.repos[key] = { name: name || key, scratch: '', stages: DEFAULT_STAGES.slice(), items: [] };
    const r = data.repos[key];
    if (name && r.name !== name) r.name = name;
    if (!Array.isArray(r.stages) || !r.stages.length) r.stages = DEFAULT_STAGES.slice();
    if (!Array.isArray(r.items)) r.items = [];
    return r;
  }
  // Open items for a repo — what the status bar badge shows.
  function openCount(key) {
    const r = key && data.repos[key];
    return r ? r.items.filter((i) => !i.done).length : 0;
  }

  // Markdown export of one repo's notes (all items, whatever the panel filter says).
  // Pure: takes the stored repo record, so it can be tested without a DOM.
  // Images become indented '![name](path)' lines under their item, only when imageDir is known.
  function notesToMarkdown(repo, name, imageDir) {
    const r = repo || {};
    const stages = Array.isArray(r.stages) ? r.stages : [];
    const items = Array.isArray(r.items) ? r.items : [];
    const line = (it, mark) => {
      const marks = stages.filter((s) => it.stages && it.stages[s]).map((s) => s + ' ✓');
      let t = String(it.text || '').replace(/\r\n?/g, '\n').split('\n').join('\n  ');
      if (marks.length) t += ' (' + marks.join(', ') + ')';
      if (it.branch) t += ' [' + it.branch + ']';
      return ['- [' + mark + '] ' + t, ...imageLines(it, imageDir).map((l) => '  ' + l)].join('\n');
    };
    const out = ['# Notes — ' + (name || r.name || '')];
    const open = items.filter((i) => !i.done), done = items.filter((i) => i.done);
    if (open.length) out.push('', '## Open', ...open.map((i) => line(i, ' ')));
    if (done.length) out.push('', '## Done', ...done.map((i) => line(i, 'x')));
    if (r.scratch && r.scratch.trim()) out.push('', '## Scratchpad', '', r.scratch);
    return out.join('\n') + '\n';
  }

  // ---------- panel ----------
  function createNotesPanel(opts = {}) {
    let ctx = null;              // { key, name, branch }
    let filter = 'open';         // all | open | notlast
    let editingId = null;
    let scratchOpen = true;

    const root = el('div', 'notes-panel');
    root.tabIndex = -1;
    const hdr = el('div', 'notes-hdr');
    const titleWrap = el('div', 'notes-title-wrap');
    const title = el('div', 'notes-title', 'Notes');
    const sub = el('div', 'notes-sub');
    titleWrap.append(title, sub);
    const filterEl = el('select', 'notes-filter');
    const copyBtn = el('button', 'notes-icon-btn notes-copy', 'Copy');
    copyBtn.title = 'Copy notes as Markdown';
    const closeBtn = el('button', 'notes-icon-btn', '▾');
    closeBtn.title = 'Hide notes (Ctrl+Shift+N)';
    closeBtn.setAttribute('aria-label', 'Hide notes');
    hdr.append(titleWrap, filterEl, copyBtn, closeBtn);

    const add = el('div', 'notes-add');
    const addInput = el('textarea', 'notes-add-input');
    addInput.rows = 1;
    addInput.placeholder = 'Add an idea, todo or change…  (Enter adds)';
    addInput.title = 'Enter adds · Shift+Enter new line';
    addInput.spellcheck = true;
    const addMeta = el('div', 'notes-add-meta');
    const branchToggle = el('label', 'notes-branch-toggle');
    const branchCb = el('input'); branchCb.type = 'checkbox'; branchCb.checked = true;
    const branchLabel = el('span');
    branchToggle.append(branchCb, branchLabel);
    const addStatus = el('span', 'notes-add-status');
    addStatus.setAttribute('role', 'status');
    addMeta.append(branchToggle, addStatus);
    const addImgs = el('div', 'notes-imgs notes-add-imgs');
    addImgs.style.display = 'none';
    add.append(addInput, addImgs, addMeta);
    const preview = el('div', 'notes-preview');
    preview.tabIndex = -1;
    preview.title = 'Click or Esc to close';

    const body = el('div', 'notes-body scroll');
    const listEl = el('div', 'notes-list');
    const doneEl = el('details', 'notes-done');
    const scratch = el('div', 'notes-scratch');
    body.append(listEl, doneEl, scratch);

    const foot = el('div', 'notes-foot');
    root.append(hdr, add, body, foot, preview);

    closeBtn.addEventListener('click', () => close());
    let copyTimer = null;
    const copyLabel = (text) => {
      copyBtn.textContent = text;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    };
    copyBtn.addEventListener('click', () => {
      if (!ctx) return;
      const md = notesToMarkdown(repoData(ctx.key, ctx.name), ctx.name, imageDir);
      let p;
      try { p = navigator.clipboard.writeText(md); } catch (err) { p = Promise.reject(err); }
      p.then(() => copyLabel('Copied'), () => copyLabel('Failed'));
    });
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && preview.classList.contains('open')) { e.preventDefault(); closePreview(); return; }
      if (e.key === 'Escape' && !editingId) { e.preventDefault(); close(); }
    });
    filterEl.addEventListener('change', () => { filter = filterEl.value; render(); });
    // Our own thumbnails are never dropped back in (not even as path text in a textarea).
    root.addEventListener('dragover', (e) => { if (isNoteImgDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } }, true);
    root.addEventListener('drop', (e) => { if (isNoteImgDrag(e)) { e.preventDefault(); e.stopPropagation(); } }, true);

    let statusTimer = null;
    const setStatus = (t, sticky) => {
      addStatus.textContent = t || '';
      clearTimeout(statusTimer);
      if (t && !sticky) statusTimer = setTimeout(() => { addStatus.textContent = ''; }, 3000);
    };

    // Image preview: natural size, capped to the panel; a click or Esc closes it. The full
    // image is read each time it opens; only the open preview's URL is held, until it closes.
    let previewSeq = 0, previewUrl = null, previewImg = null;
    function openPreview(im) {
      const seq = ++previewSeq;
      releasePreview();
      const msg = el('span', 'notes-hint', 'Loading image…');
      msg.setAttribute('role', 'status');
      preview.appendChild(msg);
      preview.style.top = root.scrollTop + 'px';
      preview.style.height = root.clientHeight + 'px';
      preview.classList.add('open');
      preview.focus();
      readFull(im).then((url) => {
        if (seq !== previewSeq || !preview.classList.contains('open')) return;
        if (!url) { msg.textContent = 'Image could not be read'; return; }
        previewUrl = url;
        previewImg = el('img'); previewImg.src = url; previewImg.alt = im.name || 'Image';
        preview.innerHTML = '';
        preview.appendChild(previewImg);
      });
    }
    function releasePreview() {
      if (previewImg) previewImg.src = '';
      previewImg = null; previewUrl = null;
      preview.innerHTML = '';
    }
    function closePreview() {
      previewSeq++;
      if (!preview.classList.contains('open')) return;
      const hadFocus = preview.contains(document.activeElement);
      preview.classList.remove('open');
      releasePreview();
      if (hadFocus && root.classList.contains('open')) root.focus();
    }
    preview.addEventListener('click', closePreview);

    // One 48px thumbnail. onRemove: the hover × (deletes the file).
    function thumbEl(im, onRemove) {
      const tile = el('div', 'notes-img');
      const img = el('img'); img.alt = im.name || 'Image'; img.draggable = false;
      tile.appendChild(img);
      tile.title = (im.name || 'Image') + ' — click to preview, drag into a Claude chat';
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      const hit = imgCache.get(imgKey(im));
      if (typeof hit === 'string') img.src = hit;
      else {
        tile.classList.add('pending');
        loadThumb(im).then((url) => {
          tile.classList.remove('pending');
          if (url) img.src = url; else { tile.classList.add('broken'); tile.title = 'Image could not be read'; }
        });
      }
      tile.addEventListener('click', () => { if (!tile.classList.contains('broken')) openPreview(im); });
      tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click(); } });
      tile.draggable = true;
      tile.addEventListener('dragstart', (e) => {
        const dt = e.dataTransfer;
        dt.setData(IMG_MIME, JSON.stringify({ id: im.id, ext: im.ext, name: im.name }));
        if (imageDir) dt.setData('text/plain', imgPath(imageDir, im));
        dt.effectAllowed = 'copy';
        try { dt.setDragImage(tile, 24, 24); } catch (_) {}
      });
      const x = el('button', 'notes-img-x', '×');
      x.title = 'Remove image'; x.setAttribute('aria-label', 'Remove image');
      x.draggable = false;
      x.addEventListener('mousedown', (e) => e.preventDefault());   // keep an edit textarea focused
      x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
      tile.appendChild(x);
      return tile;
    }

    // ---- add box: pasted/dropped images wait here (saving right away) until Enter ----
    let pending = [];            // { key, el, promise, image, done, gone }
    let committing = false;
    const syncAddImgs = () => { addImgs.style.display = pending.length ? '' : 'none'; };
    function addPending(files) {
      if (!ctx) return;
      for (const f of files) {
        const err = imgError(f);
        if (err) { setStatus(err); continue; }
        const p = { key: ctx.key, image: null, done: false, gone: false };
        p.el = el('div', 'notes-img pending');
        p.el.title = f.name || 'Image';
        const x = el('button', 'notes-img-x', '×');
        x.title = 'Remove image'; x.setAttribute('aria-label', 'Remove image');
        x.addEventListener('click', (e) => { e.stopPropagation(); dropPending(p); });
        p.el.appendChild(x);
        p.promise = saveImageFile(f).then((im) => {
          p.done = true;
          if (p.gone) { deleteImg(im); return; }
          p.image = im;
          unattached.add(imgKey(im));
          const img = el('img'); img.alt = im.name || 'Image'; img.draggable = false;
          p.el.prepend(img);
          loadThumb(im).then((url) => {
            p.el.classList.remove('pending');
            if (url) img.src = url; else p.el.classList.add('broken');
          });
        }, (err) => {
          p.done = true;
          if (!p.gone) { setStatus(err && err.message ? err.message : 'Could not save image'); dropPending(p); }
        });
        pending.push(p);
        addImgs.appendChild(p.el);
      }
      syncAddImgs();
    }
    function dropPending(p) {
      p.gone = true;
      pending = pending.filter((x) => x !== p);
      p.el.remove();
      if (p.image) deleteImg(p.image);
      syncAddImgs();
    }
    const discardPending = () => { for (const p of pending.slice()) dropPending(p); };

    async function commitAdd() {
      const key = ctx.key;
      const batch = pending.slice();
      if (batch.some((p) => !p.done)) {
        committing = true;
        setStatus('Saving image…', true);
        await Promise.allSettled(batch.map((p) => p.promise));
        committing = false;
        if (addStatus.textContent === 'Saving image…') setStatus('');   // keep a save error visible
      }
      if (!ctx || ctx.key !== key) { discardPending(); return; }
      const saved = batch.filter((p) => !p.gone && p.image && p.key === key);
      const text = addInput.value.trim();
      if (!text && !saved.length) return;
      const r = repoData(ctx.key, ctx.name);
      const now = Date.now();
      const item = { id: newId(), text, branch: branchCb.checked && ctx.branch ? ctx.branch : null,
        done: false, stages: {}, created: now, updated: now };
      if (saved.length) item.images = saved.map((p) => p.image);
      r.items.unshift(item);
      for (const p of saved) { unattached.delete(imgKey(p.image)); p.el.remove(); }
      pending = pending.filter((p) => !saved.includes(p));
      syncAddImgs();
      addInput.value = '';
      autosize(addInput);
      save();
      render();
    }

    // Save files and append them to an existing item; refresh redraws its thumbnails.
    function appendImages(r, it, files, refresh) {
      for (const f of files) {
        const err = imgError(f);
        if (err) { setStatus(err); continue; }
        saveImageFile(f).then((im) => {
          if (!r.items.includes(it)) { deleteImg(im); return; }   // deleted while saving
          it.images = imagesOf(it).concat(im);
          it.updated = Date.now();
          save();
          refresh();
        }, (e) => setStatus(e && e.message ? e.message : 'Could not save image'));
      }
    }
    function removeImage(it, im, refresh) {
      deleteImg(im);
      it.images = imagesOf(it).filter((x) => !(x.id === im.id && x.ext === im.ext));
      if (!it.images.length) delete it.images;
      it.updated = Date.now();
      save();
      refresh();
    }
    // Drop highlight + file drop for the add box and item rows (ignores our own thumbnails).
    function fileDropTarget(target, onFiles) {
      target.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        target.classList.add('drop-hot');
      });
      target.addEventListener('dragleave', (e) => { if (!target.contains(e.relatedTarget)) target.classList.remove('drop-hot'); });
      target.addEventListener('drop', (e) => {
        target.classList.remove('drop-hot');
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        onFiles(Array.from(e.dataTransfer.files));
      });
    }

    // Grow the add box with its content.
    const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
    addInput.addEventListener('input', () => autosize(addInput));
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (committing || !ctx) return;
        commitAdd();
      }
    });
    // Text on the clipboard wins (Excel/Word also put a bitmap there); an image alone attaches.
    addInput.addEventListener('paste', (e) => {
      if (e.clipboardData && e.clipboardData.getData('text/plain').trim()) return;
      const files = clipImages(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      addPending(files);
    });
    fileDropTarget(add, addPending);

    function render() {
      if (!ctx) {
        sub.textContent = '';
        listEl.innerHTML = '';
        listEl.appendChild(el('div', 'notes-empty', 'Open a tab in a folder or repository to see its notes.'));
        doneEl.style.display = 'none';
        scratch.innerHTML = '';
        foot.innerHTML = '';
        add.style.display = 'none';
        copyBtn.disabled = true;
        return;
      }
      add.style.display = '';
      copyBtn.disabled = false;
      const r = repoData(ctx.key, ctx.name);
      title.textContent = 'Notes';
      sub.textContent = ctx.name;
      sub.title = ctx.key.startsWith('gh:') ? 'Shared by every clone and worktree of ' + ctx.name : ctx.key.slice(4);
      branchLabel.textContent = ctx.branch ? 'tag with ' + ctx.branch : 'no branch';
      branchToggle.style.display = ctx.branch ? '' : 'none';

      const last = r.stages[r.stages.length - 1];
      filterEl.innerHTML = '';
      for (const [v, l] of [['open', 'Open'], ['notlast', 'Not in ' + last + ' yet'], ['all', 'All']]) {
        const o = el('option', null, l); o.value = v; filterEl.appendChild(o);
      }
      filterEl.value = filter;

      // Open items in the list; done ones fold into "Done" (except in the "All" view).
      const open = [], done = [];
      for (const it of r.items) {
        if (filter === 'notlast' && it.stages && it.stages[last]) continue;
        if (it.done && filter !== 'all') done.push(it); else open.push(it);
      }
      listEl.innerHTML = '';
      if (!open.length) listEl.appendChild(el('div', 'notes-empty', r.items.length ? 'Nothing here.' : 'No notes yet for ' + ctx.name + '.'));
      for (const it of open) listEl.appendChild(itemEl(r, it));

      doneEl.innerHTML = '';
      doneEl.style.display = done.length && filter === 'open' ? '' : 'none';
      if (done.length && filter === 'open') {
        doneEl.appendChild(el('summary', 'notes-sec', 'Done (' + done.length + ')'));
        for (const it of done) doneEl.appendChild(itemEl(r, it));
      }

      renderScratch(r);
      renderFoot(r);
    }

    function itemEl(r, it) {
      const row = el('div', 'notes-item' + (it.done ? ' done' : ''));
      const cb = el('input', 'notes-done-cb'); cb.type = 'checkbox'; cb.checked = !!it.done;
      cb.title = it.done ? 'Mark as not done' : 'Mark as done';
      cb.addEventListener('change', () => { it.done = cb.checked; it.updated = Date.now(); save(); render(); });
      row.appendChild(cb);

      const main = el('div', 'notes-item-main');
      // Thumbnails redraw in place (also mid-edit); a row replaced meanwhile gets a full render.
      const imgs = el('div', 'notes-imgs');
      const refresh = () => { if (imgs.isConnected) fill(); else if (!editingId) render(); };
      const fill = () => {
        imgs.innerHTML = '';
        const list = imagesOf(it);
        imgs.style.display = list.length ? '' : 'none';
        for (const im of list) imgs.appendChild(thumbEl(im, () => removeImage(it, im, refresh)));
      };
      fileDropTarget(row, (files) => appendImages(r, it, files, refresh));
      if (editingId === it.id) {
        const ta = el('textarea', 'notes-edit');
        ta.value = it.text;
        const finish = (keep) => {
          if (editingId !== it.id) return;
          editingId = null;
          const v = ta.value.trim();
          if (keep && v && v !== it.text) { it.text = v; it.updated = Date.now(); save(); }
          render();
        };
        ta.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        ta.addEventListener('blur', () => finish(true));
        ta.addEventListener('input', () => autosize(ta));
        ta.addEventListener('paste', (e) => {
          if (e.clipboardData && e.clipboardData.getData('text/plain').trim()) return;
          const files = clipImages(e.clipboardData);
          if (!files.length) return;
          e.preventDefault();
          appendImages(r, it, files, refresh);
        });
        main.appendChild(ta);
        requestAnimationFrame(() => { autosize(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
      } else {
        const text = el('div', 'notes-text', it.text);
        text.title = 'Double-click to edit';
        text.addEventListener('dblclick', () => { editingId = it.id; render(); });
        main.appendChild(text);
      }
      main.appendChild(imgs);

      const meta = el('div', 'notes-meta');
      for (const s of r.stages) {
        const on = !!(it.stages && it.stages[s]);
        const chip = el('button', 'notes-stage' + (on ? ' on' : ''), (on ? '✓ ' : '') + s);
        chip.title = on ? `In ${s} since ${ago(it.stages[s])} — click to unmark` : `Mark as in ${s}`;
        chip.addEventListener('click', () => {
          it.stages = it.stages || {};
          if (on) delete it.stages[s]; else it.stages[s] = Date.now();
          it.updated = Date.now();
          save(); render();
        });
        meta.appendChild(chip);
      }
      if (it.branch) {
        const b = el('span', 'notes-branch', it.branch);
        b.title = 'Branch this was noted on';
        meta.appendChild(b);
      }
      if (it.auto === 'error') {
        const t = el('span', 'notes-time', '×' + (it.count || 1) + ' · senast ' + ago(it.lastSeen || it.updated || it.created));
        t.title = 'Automatically noted Mac Code error';
        meta.appendChild(t);
      } else {
        meta.appendChild(el('span', 'notes-time', ago(it.updated || it.created)));
      }
      main.appendChild(meta);
      row.appendChild(main);
      fill();

      // Copy just this item's text; the icon flips to a check (or ! on failure) briefly.
      const cp = el('button', 'notes-icon-btn notes-item-copy');
      cp.title = 'Copy this note';
      cp.innerHTML = COPY_ICON;
      if (editingId === it.id) cp.style.visibility = 'hidden';
      let cpTimer = null;
      cp.addEventListener('click', () => {
        let p;
        const txt = [it.text, ...imageLines(it, imageDir)].filter(Boolean).join('\n');
        try { p = navigator.clipboard.writeText(txt); } catch (err) { p = Promise.reject(err); }
        p.then(() => true, () => false).then((ok) => {
          if (!cp.isConnected) return;
          cp.classList.add(ok ? 'ok' : 'fail');
          cp.textContent = ok ? '✓' : '!';
          cp.title = ok ? 'Copied' : 'Copy failed';
          clearTimeout(cpTimer);
          cpTimer = setTimeout(() => {
            if (!cp.isConnected) return;
            cp.classList.remove('ok', 'fail'); cp.innerHTML = COPY_ICON; cp.title = 'Copy this note';
          }, 1200);
        });
      });
      row.appendChild(cp);

      const del = el('button', 'notes-icon-btn notes-del', '×');
      del.title = 'Delete';
      del.addEventListener('click', () => {
        // Two-step delete: first click arms, second confirms. No native dialogs.
        if (!del.classList.contains('armed')) {
          del.classList.add('armed'); del.textContent = 'Delete?';
          setTimeout(() => { if (del.isConnected) { del.classList.remove('armed'); del.textContent = '×'; } }, 2500);
          return;
        }
        for (const im of imagesOf(it)) deleteImg(im);
        r.items = r.items.filter((x) => x.id !== it.id);
        save(); render();
      });
      row.appendChild(del);
      return row;
    }

    function renderScratch(r) {
      scratch.innerHTML = '';
      const h = el('div', 'notes-sec clickable', (scratchOpen ? '▾ ' : '▸ ') + 'Scratchpad');
      h.addEventListener('click', () => { scratchOpen = !scratchOpen; renderScratch(r); });
      scratch.appendChild(h);
      if (!scratchOpen) return;
      const ta = el('textarea', 'notes-scratch-input');
      ta.placeholder = 'Free-form notes for ' + ctx.name + '…';
      ta.value = r.scratch || '';
      ta.addEventListener('input', () => { r.scratch = ta.value; save(); });
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      scratch.appendChild(ta);
    }

    function renderFoot(r) {
      foot.innerHTML = '';
      const stages = el('div', 'notes-stages');
      stages.appendChild(el('span', 'notes-foot-label', 'Stages:'));
      for (const s of r.stages) {
        const chip = el('span', 'notes-stage-def', s);
        if (r.stages.length > 1) {
          const x = el('span', 'notes-stage-x', '×');
          x.title = 'Remove stage ' + s;
          x.addEventListener('click', () => {
            r.stages = r.stages.filter((v) => v !== s);
            for (const it of r.items) if (it.stages) delete it.stages[s];
            save(); render();
          });
          chip.appendChild(x);
        }
        stages.appendChild(chip);
      }
      const addStage = el('input', 'notes-stage-add');
      addStage.placeholder = '+ stage';
      addStage.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key !== 'Enter') return;
        const v = cleanStage(addStage.value);
        if (v && !r.stages.includes(v) && r.stages.length < 6) { r.stages.push(v); save(); render(); }
        addStage.value = '';
      });
      stages.appendChild(addStage);
      foot.appendChild(stages);
      foot.appendChild(el('div', 'notes-hint', 'Stored only on this machine — never in the repo.'));
    }

    function open() {
      root.classList.add('open');
      render();
      requestAnimationFrame(() => addInput.focus());
      if (opts.onToggle) opts.onToggle(true);
    }
    function close() {
      root.classList.remove('open');
      closePreview();
      editingId = null;
      if (opts.onToggle) opts.onToggle(false);
      if (opts.onClose) opts.onClose();
    }

    listeners.add(() => { if (root.classList.contains('open') && !editingId && !root.contains(document.activeElement)) render(); });

    return {
      el: root,
      setContext(next) {
        const same = ctx && next && ctx.key === next.key && ctx.branch === next.branch && ctx.name === next.name;
        if (same || (!ctx && !next)) return;
        const keyChanged = !ctx || !next || ctx.key !== next.key;
        ctx = next ? { ...next } : null;
        if (keyChanged) { editingId = null; discardPending(); closePreview(); }
        if (root.classList.contains('open')) {
          // Keep an in-progress edit or draft where it is if only the branch changed.
          if (keyChanged || !root.contains(document.activeElement)) render();
          else { branchLabel.textContent = ctx && ctx.branch ? 'tag with ' + ctx.branch : 'no branch'; }
        }
      },
      open, close,
      toggle() { root.classList.contains('open') ? close() : open(); },
      isOpen() { return root.classList.contains('open'); }
    };
  }

  window.repoNotes = {
    createNotesPanel,
    notesToMarkdown,
    noteImageFile,
    parseNoteImage,
    IMG_MIME,
    openCount,
    ready,
    errorsReady,
    addErrorNote,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
