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
  function notesToMarkdown(repo, name) {
    const r = repo || {};
    const stages = Array.isArray(r.stages) ? r.stages : [];
    const items = Array.isArray(r.items) ? r.items : [];
    const line = (it, mark) => {
      const marks = stages.filter((s) => it.stages && it.stages[s]).map((s) => s + ' ✓');
      let t = String(it.text || '').replace(/\r\n?/g, '\n').split('\n').join('\n  ');
      if (marks.length) t += ' (' + marks.join(', ') + ')';
      if (it.branch) t += ' [' + it.branch + ']';
      return '- [' + mark + '] ' + t;
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
    addMeta.appendChild(branchToggle);
    add.append(addInput, addMeta);

    const body = el('div', 'notes-body scroll');
    const listEl = el('div', 'notes-list');
    const doneEl = el('details', 'notes-done');
    const scratch = el('div', 'notes-scratch');
    body.append(listEl, doneEl, scratch);

    const foot = el('div', 'notes-foot');
    root.append(hdr, add, body, foot);

    closeBtn.addEventListener('click', () => close());
    let copyTimer = null;
    const copyLabel = (text) => {
      copyBtn.textContent = text;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    };
    copyBtn.addEventListener('click', () => {
      if (!ctx) return;
      const md = notesToMarkdown(repoData(ctx.key, ctx.name), ctx.name);
      let p;
      try { p = navigator.clipboard.writeText(md); } catch (err) { p = Promise.reject(err); }
      p.then(() => copyLabel('Copied'), () => copyLabel('Failed'));
    });
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !editingId) { e.preventDefault(); close(); }
    });
    filterEl.addEventListener('change', () => { filter = filterEl.value; render(); });

    // Grow the add box with its content.
    const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
    addInput.addEventListener('input', () => autosize(addInput));
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = addInput.value.trim();
        if (!text || !ctx) return;
        const r = repoData(ctx.key, ctx.name);
        const now = Date.now();
        r.items.unshift({ id: newId(), text, branch: branchCb.checked && ctx.branch ? ctx.branch : null,
          done: false, stages: {}, created: now, updated: now });
        addInput.value = '';
        autosize(addInput);
        save();
        render();
      }
    });

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
        main.appendChild(ta);
        requestAnimationFrame(() => { autosize(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
      } else {
        const text = el('div', 'notes-text', it.text);
        text.title = 'Double-click to edit';
        text.addEventListener('dblclick', () => { editingId = it.id; render(); });
        main.appendChild(text);
      }

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

      // Copy just this item's text; the icon flips to a check (or ! on failure) briefly.
      const cp = el('button', 'notes-icon-btn notes-item-copy');
      cp.title = 'Copy this note';
      cp.innerHTML = COPY_ICON;
      if (editingId === it.id) cp.style.visibility = 'hidden';
      let cpTimer = null;
      cp.addEventListener('click', () => {
        let p;
        try { p = navigator.clipboard.writeText(it.text); } catch (err) { p = Promise.reject(err); }
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
        if (keyChanged) editingId = null;
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
    openCount,
    ready,
    errorsReady,
    addErrorNote,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
