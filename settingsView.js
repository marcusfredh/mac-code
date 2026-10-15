// App settings: the renderer side of settings.js.
//
// Loaded before every other renderer script, so they can all read settings at load
// time. Owns window.appSettings (the current, validated object), getAppSetting(),
// setAppSetting() and onAppSettingsChanged(); the main process holds the file and
// validates every write, and broadcasts each change back here.
//
// Also builds the settings modal (Ctrl+, / the gear in the titlebar) and two small
// in-app dialogs, appConfirm() and appAlert(), so nothing uses window.confirm/alert.
// All DOM is built with createElement/textContent: setting values and file paths
// never go through innerHTML.

(() => {
  'use strict';

  const api = window.settingsApi || null;

  // Only used when the snapshot is missing (it never is in the main window). Mirrors
  // DEFAULTS in settings.js, which stays the source of truth.
  const FALLBACK = {
    v: 1,
    general: { restoreTabs: true, shell: 'pwsh', startDir: '', confirmClose: false },
    terminal: { fontFamily: 'Cascadia Code', fontSize: 13, theme: 'windowsTerminal', cursorStyle: 'bar',
      scrollback: 5000, copyOnSelect: false, rightClickPaste: false },
    claude: { hybridInput: false, autosaveChats: 'off', autoClearDays: 0, model: null, oneM: false,
      permissionDefault: null, notify: true, showUsage: true, cliPath: '' },
    github: { links: 'app', ctrlFlips: true, worktreeTemplate: '', draftPr: false, pollSeconds: 60 },
    editor: { autosave: 'off', wordWrap: false, minimap: false, tabSize: 2 },
    explorer: { showHidden: true }
  };

  let current = (api && api.initial && api.initial.settings) || FALLBACK;
  const listeners = new Set();

  // ---------- legacy migration ----------
  // Before settings.json existed three choices lived in localStorage. On the first run
  // with the new store they are folded in with one synchronous write, before any other
  // script reads them, and the old keys are dropped only once that write landed.
  const LEGACY_PERM_MODES = new Set(['default', 'auto', 'acceptEdits', 'bypassPermissions']);
  function migrateLegacy() {
    if (!api || !api.initial || !api.initial.fresh || typeof api.setSync !== 'function') return;
    const patch = {};
    const keys = [];
    let raw;
    try { raw = localStorage.getItem('termHybridInput'); } catch (_) { raw = null; }
    if (raw != null) { keys.push('termHybridInput'); (patch.claude = patch.claude || {}).hybridInput = raw === '1'; }
    try { raw = localStorage.getItem('chatPermissionDefault'); } catch (_) { raw = null; }
    if (raw != null) {
      keys.push('chatPermissionDefault');
      if (LEGACY_PERM_MODES.has(raw)) (patch.claude = patch.claude || {}).permissionDefault = raw;
    }
    try { raw = localStorage.getItem('ghLinksInApp'); } catch (_) { raw = null; }
    if (raw != null) {
      keys.push('ghLinksInApp');
      let v = null;
      try { v = JSON.parse(raw); } catch (_) {}
      if (typeof v === 'boolean') patch.github = { links: v ? 'app' : 'browser' };
    }
    if (!keys.length) return;
    let res = null;
    try { res = api.setSync(patch); } catch (_) { res = null; }
    if (!res) return;
    current = res;
    for (const k of keys) { try { localStorage.removeItem(k); } catch (_) {} }
  }
  migrateLegacy();
  window.appSettings = current;

  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // Take a settings object from main (a set result or a broadcast). Both arrive for our
  // own writes, so an unchanged object is not announced twice.
  function adopt(next) {
    if (!next || typeof next !== 'object' || same(next, current)) return;
    const prev = current;
    current = next;
    window.appSettings = next;
    for (const cb of [...listeners]) {
      try { cb(next, prev); } catch (err) { console.error('settings listener', err); }
    }
  }
  if (api && typeof api.onChanged === 'function') api.onChanged(adopt);

  function getAppSetting(section, key) {
    const sec = current[section];
    if (sec && Object.prototype.hasOwnProperty.call(sec, key)) return sec[key];
    const fb = FALLBACK[section];
    return fb ? fb[key] : undefined;
  }
  function onAppSettingsChanged(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  // -> the settings after the write (null when it failed). An invalid value leaves the
  // key as it was, so callers compare what they sent with what came back.
  async function writePatch(patch) {
    if (!api) return null;
    let res = null;
    try { res = await api.set(patch); } catch (_) { res = null; }
    if (res) adopt(res);
    return res;
  }
  async function setAppSetting(section, key, value) {
    const res = await writePatch({ [section]: { [key]: value } });
    return !!res && same(res[section] && res[section][key], value);
  }

  window.getAppSetting = getAppSetting;
  window.setAppSetting = setAppSetting;
  window.onAppSettingsChanged = onAppSettingsChanged;

  // ---------- small DOM helpers ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgIcon(paths, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 14));
    s.setAttribute('height', String(size || 14));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('aria-hidden', 'true');
    for (const p of paths) {
      const node = document.createElementNS(NS, p.tag || 'path');
      for (const [k, v] of Object.entries(p)) if (k !== 'tag') node.setAttribute(k, v);
      s.appendChild(node);
    }
    return s;
  }
  function focusables(root) {
    return [...root.querySelectorAll('button, input, select, textarea, [tabindex]')]
      .filter((n) => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null);
  }
  // Tab / Shift+Tab stay inside a dialog.
  function trapTab(e, root) {
    if (e.key !== 'Tab') return;
    const list = focusables(root);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }
  function restoreFocus(prev) {
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
      try { prev.focus(); } catch (_) {}
      if (document.activeElement === prev) return;
    }
    if (typeof window.macFocusActive === 'function') window.macFocusActive();
  }

  // ---------- in-app confirm / alert ----------
  // -> Promise<boolean>. Esc and the backdrop cancel; focus goes back where it was.
  function appConfirm({ title, message, okLabel = 'OK', cancelLabel = 'Avbryt', danger = false, alertOnly = false } = {}) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const overlay = el('div', 'set-overlay set-overlay-top show');
      const box = el('div', 'set-confirm');
      box.setAttribute('role', alertOnly ? 'alertdialog' : 'dialog');
      box.setAttribute('aria-modal', 'true');
      const titleEl = el('div', 'set-confirm-title', title || '');
      titleEl.id = 'set-confirm-title-' + Date.now();
      box.setAttribute('aria-labelledby', titleEl.id);
      box.appendChild(titleEl);
      if (message) box.appendChild(el('div', 'set-confirm-text', message));
      const foot = el('div', 'set-confirm-foot');
      const cancel = alertOnly ? null : el('button', 'set-btn', cancelLabel);
      const ok = el('button', 'set-btn ' + (danger ? 'danger' : 'primary'), okLabel);
      if (cancel) { cancel.type = 'button'; foot.appendChild(cancel); }
      ok.type = 'button';
      foot.appendChild(ok);
      box.appendChild(foot);
      overlay.appendChild(box);

      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        overlay.remove();
        restoreFocus(prev);
        resolve(v);
      };
      ok.addEventListener('click', () => finish(true));
      if (cancel) cancel.addEventListener('click', () => finish(false));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(alertOnly); });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(alertOnly); }
        else trapTab(e, box);
        e.stopPropagation();
      });
      document.body.appendChild(overlay);
      // A destructive choice starts on Cancel, so a stray Enter doesn't take it.
      (cancel && danger ? cancel : ok).focus();
    });
  }
  function appAlert({ title, message, okLabel = 'OK' } = {}) {
    return appConfirm({ title, message, okLabel, alertOnly: true }).then(() => undefined);
  }
  window.appConfirm = appConfirm;
  window.appAlert = appAlert;

  // ---------- the settings modal: what it shows ----------
  // Each row: label + description + one or more controls bound to section.key.
  // kinds: toggle | segmented | select | number | text. Paths and the worktree
  // template are sent on change/blur, never per keystroke.
  const opt = (value, label) => ({ value, label });
  const SECTIONS = [
    { id: 'general', label: 'Allmänt', rows: [
      { label: 'Återställ flikar vid start',
        desc: 'Öppnar terminal- och chattflikar från förra gången, med sina mappar. Av = börja med en tom terminal; sparade sessioner finns kvar.',
        controls: [{ kind: 'toggle', sec: 'general', key: 'restoreTabs' }] },
      { label: 'Standardshell',
        desc: 'Vad nya terminalflikar startar. Saknas pwsh används Windows PowerShell.',
        controls: [{ kind: 'select', sec: 'general', key: 'shell', options: [
          opt('pwsh', 'PowerShell 7 (pwsh)'), opt('powershell', 'Windows PowerShell')] }] },
      { label: 'Startmapp för nya flikar',
        desc: 'När en ny flik inte får någon annan mapp. Måste vara en mapp som finns, med fullständig sökväg på en enhet (inte en nätverkssökväg). Tomt = C:\\dev om den finns, annars hemmappen.',
        controls: [{ kind: 'text', sec: 'general', key: 'startDir', placeholder: 'Automatisk', check: 'startDir', mono: true }] },
      { label: 'Fråga innan flik med körande Claude stängs',
        desc: 'När en Claude-tur pågår i en chatt- eller terminalflik. Gäller inte när appen avslutas.',
        controls: [{ kind: 'toggle', sec: 'general', key: 'confirmClose' }] }
    ] },
    { id: 'terminal', label: 'Terminal', rows: [
      { label: 'Typsnitt',
        desc: 'Typsnitt och storlek (8–32) i terminaler. Gäller direkt.',
        controls: [
          { kind: 'select', sec: 'terminal', key: 'fontFamily', aria: 'Typsnitt', width: 200, options: [
            opt('Cascadia Code', 'Cascadia Code'), opt('Consolas', 'Consolas'), opt('JetBrains Mono', 'JetBrains Mono (om installerat)')] },
          { kind: 'number', sec: 'terminal', key: 'fontSize', aria: 'Storlek', min: 8, max: 32, width: 64 }] },
      { label: 'Färgschema',
        controls: [{ kind: 'select', sec: 'terminal', key: 'theme', options: [
          opt('windowsTerminal', 'Windows Terminal'), opt('oneHalfDark', 'One Half Dark'), opt('solarizedDark', 'Solarized Dark')] }] },
      { label: 'Markör',
        controls: [{ kind: 'segmented', sec: 'terminal', key: 'cursorStyle', options: [
          opt('block', 'Block'), opt('bar', 'Streck'), opt('underline', 'Understreck')] }] },
      { label: 'Scrollback',
        desc: 'Rader som sparas bakåt per terminal (0–100 000). Högst 5 000 följer med mellan omstarter.',
        controls: [{ kind: 'number', sec: 'terminal', key: 'scrollback', min: 0, max: 100000, width: 100 }] },
      { label: 'Kopiera vid markering',
        desc: 'Markerad text i terminalen hamnar direkt i urklipp.',
        controls: [{ kind: 'toggle', sec: 'terminal', key: 'copyOnSelect' }] },
      { label: 'Högerklick klistrar in',
        desc: 'Shift+högerklick öppnar menyn. Av = högerklick öppnar menyn.',
        controls: [{ kind: 'toggle', sec: 'terminal', key: 'rightClickPaste' }] }
    ] },
    { id: 'claude', label: 'Claude', rows: [
      { label: 'Hybrid input',
        desc: 'Egen inmatningsruta under Claude i terminalflikar. Raw-knappen tar tillbaka terminalen i en enskild flik.',
        controls: [{ kind: 'toggle', sec: 'claude', key: 'hybridInput' }] },
      { label: 'Autospara chattar',
        desc: 'Lägg chattsessioner i biblioteket utan att trycka Spara. Löpande = efter varje avslutad tur.',
        controls: [{ kind: 'segmented', sec: 'claude', key: 'autosaveChats', options: [
          opt('off', 'Av'), opt('onClose', 'När fliken stängs'), opt('continuous', 'Löpande')] }] },
      { label: 'Rensa sparade sessioner automatiskt',
        desc: 'Samma regel som Clear old, en gång vid start.',
        controls: [{ kind: 'select', sec: 'claude', key: 'autoClearDays', options: [
          opt(0, 'Aldrig'), opt(7, 'Äldre än 1 vecka'), opt(30, 'Äldre än 1 månad')] }] },
      { label: 'Standardmodell för nya chattar',
        desc: 'Följ CLI = det Claudes egna inställningar säger. 1M gäller inte Haiku.',
        controls: [
          { kind: 'select', sec: 'claude', key: 'model', aria: 'Standardmodell', width: 150, options: [
            opt(null, 'Följ CLI'), opt('opus', 'Opus'), opt('sonnet', 'Sonnet'), opt('haiku', 'Haiku'), opt('fable', 'Fable')] },
          { kind: 'toggle', sec: 'claude', key: 'oneM', aria: '1M kontext', prefix: '1M',
            enabledIf: (s) => !!s.claude.model && s.claude.model !== 'haiku' }] },
      { label: 'Behörighetsläge för nya chattar',
        desc: 'Samma som "Use <mode> for new panes" i lägesmenyn.',
        controls: [{ kind: 'select', sec: 'claude', key: 'permissionDefault', options: [
          opt(null, 'Följ CLI (defaultMode)'), opt('default', 'Ask'), opt('auto', 'Auto (lokala regler)'),
          opt('acceptEdits', 'Accept edits'), opt('bypassPermissions', 'Bypass')] }] },
      { label: 'Notis när Claude är klar eller väntar',
        desc: 'Windows-notis, bara när fönstret saknar fokus. Gäller även Copilot-paneler.',
        controls: [{ kind: 'toggle', sec: 'claude', key: 'notify' }] },
      { label: 'Visa planförbrukning',
        desc: '5-timmars- och veckofönstret i statusraden och i chattarnas sidfot.',
        controls: [{ kind: 'toggle', sec: 'claude', key: 'showUsage' }] },
      { label: 'Sökväg till claude',
        desc: 'Gäller chattpaneler och appens egna claude-kommandon (t.ex. MCP), inte terminalflikar. Fullständig sökväg till claude.exe, .cmd eller .bat. Tomt = PATH, sedan ~\\.local\\bin\\claude.exe.',
        controls: [{ kind: 'text', sec: 'claude', key: 'cliPath', placeholder: 'Automatisk', check: 'cliPath', mono: true }] }
    ] },
    { id: 'github', label: 'GitHub', rows: [
      { label: 'Öppna GitHub-länkar',
        desc: 'PR, issues och repon från chattar och terminaler. Andra länkar öppnas alltid i webbläsaren.',
        controls: [{ kind: 'segmented', sec: 'github', key: 'links', options: [
          opt('app', 'I appen'), opt('browser', 'I webbläsaren'), opt('ask', 'Fråga')] }] },
      { label: 'Ctrl+klick gör tvärtom',
        desc: 'Snabb väg till webbläsaren när standard är appen, och omvänt. Av = Ctrl+klick gör samma som klick.',
        controls: [{ kind: 'toggle', sec: 'github', key: 'ctrlFlips' }] },
      { label: 'Mapp för worktrees',
        desc: '{repo} och {branch} fylls i; / i branchnamn blir -. Måste vara en fullständig sökväg på en enhet (C:\\…, inte en nätverkssökväg) med {branch} och en mapp som heter worktrees med fler mappar under. Tomt = <klonens föräldermapp>\\worktrees\\<klon>\\<branch>.',
        controls: [{ kind: 'text', sec: 'github', key: 'worktreeTemplate', placeholder: 'C:\\dev\\worktrees\\{repo}\\{branch}', mono: true, width: 260,
          invalid: 'Ogiltig mall: behöver en fullständig sökväg på en enhet med {branch} och en mapp som heter worktrees med fler mappar under. Den gamla behålls.' }] },
      { label: 'Skapa PR som utkast',
        desc: '"Create PR with Claude" kör gh pr create --draft.',
        controls: [{ kind: 'toggle', sec: 'github', key: 'draftPr' }] },
      { label: 'Uppdatera PR- och CI-status',
        desc: 'Hur ofta GitHub-fliken frågar gh medan den visas.',
        controls: [{ kind: 'select', sec: 'github', key: 'pollSeconds', options: [
          opt(60, 'Var 60:e sekund'), opt(300, 'Var 5:e minut'), opt(0, 'Bara när fliken öppnas')] }] }
    ] },
    { id: 'editor', label: 'Editor och Explorer', rows: [
      { label: 'Autospara filer',
        desc: 'Ctrl+S sparar alltid.',
        controls: [{ kind: 'segmented', sec: 'editor', key: 'autosave', options: [
          opt('off', 'Av'), opt('blur', 'Vid fokusbyte'), opt('delay', 'Efter 1 s')] }] },
      { label: 'Radbrytning', controls: [{ kind: 'toggle', sec: 'editor', key: 'wordWrap' }] },
      { label: 'Minimap', controls: [{ kind: 'toggle', sec: 'editor', key: 'minimap' }] },
      { label: 'Tabbstorlek',
        controls: [{ kind: 'select', sec: 'editor', key: 'tabSize', width: 120, options: [opt(2, '2'), opt(4, '4'), opt(8, '8')] }] },
      { label: 'Visa dolda filer i Explorer',
        desc: 'Filer och mappar vars namn börjar med punkt (.git, .env …).',
        controls: [{ kind: 'toggle', sec: 'explorer', key: 'showHidden' }] }
    ] },
    { id: 'keys', label: 'Kortkommandon', note: 'Kortkommandona går inte att ändra.', keys: [
      ['Ny terminalflik', 'Ctrl+T'],
      ['Ny Claude-chatt', 'Ctrl+Shift+L'],
      ['Stäng panel, eller fliken om det är den sista', 'Ctrl+Shift+W'],
      ['Dela höger / ned', 'Ctrl+Shift+R / D'],
      ['Byt flik', 'Ctrl+Tab / Ctrl+Shift+Tab'],
      ['Byt namn på flik', 'F2'],
      ['Visa Explorer / agentpanelen', 'Ctrl+B / Ctrl+Shift+B'],
      ['Repo-anteckningar', 'Ctrl+Shift+N'],
      ['GitHub-fliken', 'Ctrl+Shift+G'],
      ['Terminallåda i chatt', 'Ctrl+`'],
      ['Godkänn senaste förfrågan', 'Ctrl+Enter'],
      ['Öppna inställningar', 'Ctrl+,']
    ] },
    { id: 'about', label: 'Om', about: true }
  ];

  const INVALID_DEFAULT = 'Ogiltigt värde. Det gamla behålls.';
  const NOT_FOUND = 'hittades inte, standard används';

  // ---------- the settings modal: DOM ----------
  let ui = null;          // built on first open
  let prevFocus = null;
  let activeSection = 'general';

  function isOpen() { return !!(ui && ui.overlay.classList.contains('show')); }

  function setNote(row, text, kind) {
    if (!row.note) return;
    row.note.textContent = text || '';
    row.note.className = 'set-row-note' + (kind ? ' ' + kind : '');
    row.note.hidden = !text;
  }

  // Write one control's value; flag the row when main kept the old value instead.
  async function commit(row, c, value) {
    const res = await writePatch({ [c.sec]: { [c.key]: value } });
    if (!res) { setNote(row, 'Kunde inte spara.', 'err'); syncAll(); return; }
    const got = res[c.sec][c.key];
    const sent = typeof value === 'string' ? value.trim() : value;
    // Numbers come back clamped to their range; that is a fix-up, not an error.
    if (c.kind !== 'number' && !same(got, sent)) {
      setNote(row, c.invalid || INVALID_DEFAULT, 'err');
      row.noteSticky = true;
    } else {
      row.noteSticky = false;
      setNote(row, '', null);
    }
    syncAll();
    if (c.check) refreshChecks();
  }

  function buildToggle(row, c) {
    const wrap = el('div', 'set-toggle-wrap');
    if (c.prefix) wrap.appendChild(el('span', 'set-toggle-prefix', c.prefix));
    const b = el('button', 'set-switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', c.aria || row.def.label);
    b.appendChild(el('span', 'set-switch-knob'));
    b.addEventListener('click', () => {
      const next = !getAppSetting(c.sec, c.key);
      b.setAttribute('aria-checked', String(next));
      commit(row, c, next);
    });
    wrap.appendChild(b);
    c.sync = (s) => {
      b.setAttribute('aria-checked', String(!!s[c.sec][c.key]));
      const on = c.enabledIf ? c.enabledIf(s) : true;
      b.disabled = !on;
      wrap.classList.toggle('disabled', !on);
    };
    return wrap;
  }

  function buildSegmented(row, c) {
    const g = el('div', 'set-seg');
    g.setAttribute('role', 'radiogroup');
    g.setAttribute('aria-label', c.aria || row.def.label);
    const btns = c.options.map((o) => {
      const b = el('button', 'set-seg-btn', o.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        if (same(getAppSetting(c.sec, c.key), o.value)) return;
        for (const x of btns) x.setAttribute('aria-checked', String(x === b));
        commit(row, c, o.value);
      });
      g.appendChild(b);
      return b;
    });
    // Arrow keys move the choice, as in a native radio group.
    g.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const i = btns.indexOf(document.activeElement);
      const n = btns[((i < 0 ? 0 : i) + dir + btns.length) % btns.length];
      n.focus();
      n.click();
    });
    c.sync = (s) => {
      const v = s[c.sec][c.key];
      c.options.forEach((o, i) => {
        const on = same(o.value, v);
        btns[i].setAttribute('aria-checked', String(on));
        btns[i].tabIndex = on ? 0 : -1;
      });
      if (!btns.some((b) => b.tabIndex === 0)) btns[0].tabIndex = 0;
    };
    return g;
  }

  function buildSelect(row, c) {
    const s = el('select', 'set-select');
    s.setAttribute('aria-label', c.aria || row.def.label);
    if (c.width) s.style.width = c.width + 'px';
    // Option values are JSON so null and numbers survive the round trip.
    for (const o of c.options) {
      const op = el('option', null, o.label);
      op.value = JSON.stringify(o.value);
      s.appendChild(op);
    }
    s.addEventListener('change', () => {
      let v;
      try { v = JSON.parse(s.value); } catch (_) { return; }
      commit(row, c, v);
    });
    c.sync = (st) => { s.value = JSON.stringify(st[c.sec][c.key]); };
    return s;
  }

  function buildNumber(row, c) {
    const i = el('input', 'set-input');
    i.type = 'number';
    i.min = String(c.min); i.max = String(c.max); i.step = '1';
    i.setAttribute('aria-label', c.aria || row.def.label);
    if (c.width) i.style.width = c.width + 'px';
    i.addEventListener('change', () => {
      const n = Number(i.value);
      if (i.value.trim() === '' || !Number.isFinite(n)) { i.value = String(getAppSetting(c.sec, c.key)); return; }
      // Show the stored (clamped) value even while the field keeps focus.
      commit(row, c, Math.round(n)).then(() => { i.value = String(getAppSetting(c.sec, c.key)); });
    });
    c.sync = (s) => { if (document.activeElement !== i) i.value = String(s[c.sec][c.key]); };
    return i;
  }

  function buildText(row, c) {
    const i = el('input', 'set-input' + (c.mono ? ' mono' : ''));
    i.type = 'text';
    i.spellcheck = false;
    i.autocomplete = 'off';
    i.placeholder = c.placeholder || '';
    i.setAttribute('aria-label', c.aria || row.def.label);
    if (c.width) i.style.width = c.width + 'px';
    // 'change' fires on blur and on Enter, so a half-typed path is never written.
    i.addEventListener('change', () => commit(row, c, i.value));
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); i.blur(); }
    });
    c.sync = (s) => { if (document.activeElement !== i) i.value = s[c.sec][c.key]; };
    c.input = i;
    return i;
  }

  function buildRow(def, sectionId) {
    const row = { def, sectionId, controls: def.controls || [], note: null, noteSticky: false };
    const rowEl = el('div', 'set-row');
    const text = el('div', 'set-row-text');
    const lab = el('div', 'set-row-label', def.label);
    text.appendChild(lab);
    if (def.desc) text.appendChild(el('div', 'set-row-desc', def.desc));
    row.note = el('div', 'set-row-note');
    row.note.hidden = true;
    row.note.setAttribute('role', 'status');
    text.appendChild(row.note);
    rowEl.appendChild(text);
    const ctl = el('div', 'set-row-ctl');
    for (const c of row.controls) {
      const build = { toggle: buildToggle, segmented: buildSegmented, select: buildSelect, number: buildNumber, text: buildText }[c.kind];
      if (build) ctl.appendChild(build(row, c));
    }
    rowEl.appendChild(ctl);
    row.el = rowEl;
    row.search = (def.label + ' ' + (def.desc || '')).toLowerCase();
    return row;
  }

  function buildKeysRows(sec) {
    return sec.keys.map(([label, key]) => {
      const rowEl = el('div', 'set-row compact');
      rowEl.appendChild(el('div', 'set-row-label grow', label));
      rowEl.appendChild(el('kbd', 'set-kbd', key));
      return { def: { label }, sectionId: sec.id, controls: [], el: rowEl, search: (label + ' ' + key).toLowerCase() };
    });
  }

  function smallBtn(label, onClick) {
    const b = el('button', 'set-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function buildAboutRows(sec) {
    const rows = [];
    // Version
    const vRow = el('div', 'set-row');
    const vText = el('div', 'set-row-text');
    const vLabel = el('div', 'set-row-label', 'Mac Code');
    vText.appendChild(vLabel);
    vText.appendChild(el('div', 'set-row-desc', 'Terminal, Claude-chattar och GitHub i ett fönster.'));
    vRow.appendChild(vText);
    rows.push({ def: { label: 'Mac Code version' }, sectionId: sec.id, controls: [], el: vRow, search: 'mac code version om' });

    // Settings file
    const fRow = el('div', 'set-row');
    const fText = el('div', 'set-row-text');
    fText.appendChild(el('div', 'set-row-label', 'Inställningsfil'));
    fText.appendChild(el('div', 'set-row-desc', 'Allt här sparas som JSON, så det går att flytta mellan datorer. Sparar du filen i editorn läses den in direkt.'));
    const pathEl = el('div', 'set-path');
    fText.appendChild(pathEl);
    const status = el('div', 'set-row-note');
    status.hidden = true;
    status.setAttribute('role', 'status');
    fText.appendChild(status);
    fRow.appendChild(fText);
    const say = (text, kind) => {
      status.textContent = text || '';
      status.className = 'set-row-note' + (kind ? ' ' + kind : '');
      status.hidden = !text;
    };
    const ctl = el('div', 'set-row-ctl');
    ctl.appendChild(smallBtn('Öppna i editorn', async () => {
      const p = api ? await api.path() : null;
      if (!p || typeof window.macOpenInEditor !== 'function') { say('Kunde inte öppna filen.', 'err'); return; }
      close();
      window.macOpenInEditor(p);
    }));
    ctl.appendChild(smallBtn('Exportera…', async () => {
      say('', null);
      const r = api ? await api.exportFile() : null;
      if (!r) say('Kunde inte exportera.', 'err');
      else if (r.ok) say('Exporterat till ' + r.path, 'ok');
      else if (!r.canceled) say('Kunde inte exportera: ' + (r.error || 'okänt fel'), 'err');
    }));
    ctl.appendChild(smallBtn('Importera…', async () => {
      say('', null);
      const r = api ? await api.importFile() : null;
      if (!r) say('Kunde inte importera.', 'err');
      else if (r.ok) {
        adopt(r.settings);
        // Main never takes these from a file (they pick what runs and where); it names
        // the ones the file tried to change.
        const skipped = Array.isArray(r.skipped) ? r.skipped.filter((k) => typeof k === 'string') : [];
        say('Importerat. Ogiltiga värden hoppades över.' +
          (skipped.length ? ' Nuvarande värde behölls för ' + skipped.join(', ') + '.' : ''), 'ok');
        refreshChecks();
      } else if (!r.canceled) say('Kunde inte importera: ' + (r.error || 'okänt fel'), 'err');
    }));
    fRow.appendChild(ctl);
    rows.push({ def: { label: 'Inställningsfil' }, sectionId: sec.id, controls: [], el: fRow,
      search: 'inställningsfil json exportera importera editorn' });

    ui.about = { vLabel, pathEl, say };
    return rows;
  }

  function build() {
    ui = { rows: [], sections: new Map(), nav: new Map() };
    const overlay = el('div', 'set-overlay');
    const dlg = el('div', 'set-dialog');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'set-title');

    // header
    const hdr = el('div', 'set-hdr');
    const title = el('div', 'set-title', 'Inställningar');
    title.id = 'set-title';
    hdr.appendChild(title);
    const searchWrap = el('label', 'set-search');
    searchWrap.appendChild(svgIcon([{ tag: 'circle', cx: '11', cy: '11', r: '7' }, { d: 'M20 20l-3.5-3.5' }]));
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Sök inställning…';
    search.setAttribute('aria-label', 'Sök inställning');
    search.spellcheck = false;
    searchWrap.appendChild(search);
    hdr.appendChild(searchWrap);
    const x = el('button', 'set-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Stäng');
    x.title = 'Stäng (Esc)';
    x.appendChild(svgIcon([{ d: 'M5 5l14 14M19 5L5 19' }]));
    x.addEventListener('click', () => close());
    hdr.appendChild(x);
    dlg.appendChild(hdr);

    // body: nav + content
    const body = el('div', 'set-body');
    const nav = el('nav', 'set-nav');
    nav.setAttribute('aria-label', 'Kategorier');
    const content = el('div', 'set-content scroll');
    content.tabIndex = -1;
    body.appendChild(nav);
    body.appendChild(content);
    dlg.appendChild(body);

    for (const sec of SECTIONS) {
      const b = el('button', 'set-nav-btn', sec.label);
      b.type = 'button';
      b.addEventListener('click', () => { search.value = ''; showSection(sec.id); });
      nav.appendChild(b);
      ui.nav.set(sec.id, b);

      const box = el('section', 'set-section');
      box.setAttribute('aria-label', sec.label);
      box.appendChild(el('h2', 'set-h2', sec.label));
      if (sec.note) box.appendChild(el('div', 'set-section-note', sec.note));
      const rows = sec.keys ? buildKeysRows(sec) : sec.about ? buildAboutRows(sec) : sec.rows.map((r) => buildRow(r, sec.id));
      for (const r of rows) { box.appendChild(r.el); ui.rows.push(r); }
      content.appendChild(box);
      ui.sections.set(sec.id, { box, rows });
    }
    // Up/Down walk the category list.
    nav.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const btns = [...ui.nav.values()];
      const i = btns.indexOf(document.activeElement);
      const n = btns[((i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
      n.focus();
      n.click();
    });
    const empty = el('div', 'set-empty');
    empty.hidden = true;
    content.appendChild(empty);

    // footer
    const foot = el('div', 'set-foot');
    foot.appendChild(el('div', 'set-foot-note', 'Ändringar sparas direkt. Vissa gäller först i nya flikar.'));
    const reset = el('button', 'set-btn ghost', 'Återställ standard');
    reset.type = 'button';
    reset.addEventListener('click', async () => {
      const ok = await appConfirm({
        title: 'Återställ alla inställningar?',
        message: 'Alla inställningar får sina standardvärden igen. Det går inte att ångra.',
        okLabel: 'Återställ', danger: true
      });
      if (!ok || !api) return;
      const res = await api.reset();
      if (res) adopt(res);
      for (const r of ui.rows) { r.noteSticky = false; if (r.note) setNote(r, '', null); }
      syncAll();
      refreshChecks();
    });
    const done = el('button', 'set-btn primary', 'Klar');
    done.type = 'button';
    done.addEventListener('click', () => close());
    foot.appendChild(reset);
    foot.appendChild(done);
    dlg.appendChild(foot);

    overlay.appendChild(dlg);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Esc in a search box with text clears it first.
        if (document.activeElement === search && search.value) { e.preventDefault(); search.value = ''; applySearch(); }
        else { e.preventDefault(); close(); }
      } else trapTab(e, dlg);
      // The app's own shortcuts (Ctrl+T, Ctrl+Shift+W …) must not act behind the modal.
      e.stopPropagation();
    });
    search.addEventListener('input', applySearch);

    Object.assign(ui, { overlay, dlg, search, content, empty });
    document.body.appendChild(overlay);
  }

  function showSection(id) {
    activeSection = ui.sections.has(id) ? id : 'general';
    applySearch();
    ui.content.scrollTop = 0;
  }

  function applySearch() {
    const q = ui.search.value.trim().toLowerCase();
    let hits = 0;
    for (const [id, { box, rows }] of ui.sections) {
      if (!q) {
        box.hidden = id !== activeSection;
        for (const r of rows) r.el.hidden = false;
        continue;
      }
      let any = false;
      for (const r of rows) {
        const m = r.search.includes(q);
        r.el.hidden = !m;
        if (m) { any = true; hits++; }
      }
      box.hidden = !any;
    }
    for (const [id, b] of ui.nav) {
      const on = !q && id === activeSection;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    ui.empty.hidden = !q || hits > 0;
    ui.empty.textContent = q && !hits ? `Inga inställningar matchar "${ui.search.value.trim()}".` : '';
  }

  function syncAll() {
    if (!ui) return;
    for (const r of ui.rows) for (const c of r.controls) if (c.sync) c.sync(current);
  }

  // Path rows say when the folder / binary is not there (main then uses its default).
  async function refreshChecks() {
    if (!ui || !api || typeof api.check !== 'function') return;
    let res = null;
    try { res = await api.check(); } catch (_) { res = null; }
    if (!res) return;
    for (const r of ui.rows) {
      for (const c of r.controls) {
        if (!c.check || r.noteSticky) continue;
        setNote(r, res[c.check] === false ? NOT_FOUND : '', res[c.check] === false ? 'warn' : null);
      }
    }
  }

  async function refreshAbout() {
    if (!ui.about || !api) return;
    try {
      const v = await api.version();
      ui.about.vLabel.textContent = 'Mac Code ' + (v || '');
    } catch (_) {}
    try {
      const p = await api.path();
      ui.about.pathEl.textContent = p || '';
      ui.about.pathEl.title = p || '';
    } catch (_) {}
  }

  function open(opts = {}) {
    if (!ui) build();
    if (isOpen()) return;
    prevFocus = document.activeElement;
    if (opts.section) activeSection = opts.section;
    ui.search.value = '';
    ui.about && ui.about.say('', null);
    syncAll();
    showSection(activeSection);
    ui.overlay.classList.add('show');
    ui.search.focus();
    refreshChecks();
    refreshAbout();
  }

  function close() {
    if (!isOpen()) return;
    // A text field with an unsent edit: commit it the way a blur would.
    const a = document.activeElement;
    if (a && ui.dlg.contains(a) && a.tagName === 'INPUT' && a.type === 'text') a.blur();
    ui.overlay.classList.remove('show');
    const p = prevFocus;
    prevFocus = null;
    restoreFocus(p);
  }

  onAppSettingsChanged(() => { if (isOpen()) syncAll(); });

  window.openAppSettings = open;
  window.closeAppSettings = close;
  window.isAppSettingsOpen = isOpen;
})();
