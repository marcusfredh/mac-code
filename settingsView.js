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
    general: { restoreTabs: true, shell: 'pwsh', startDir: '', confirmClose: false, appTheme: 'default' },
    terminal: { fontFamily: 'Cascadia Code', fontSize: 13, theme: 'windowsTerminal', cursorStyle: 'bar',
      scrollback: 5000, copyOnSelect: false, rightClickPaste: false },
    claude: { hybridInput: false, autosaveChats: 'off', autoClearDays: 0, model: null, oneM: false,
      permissionDefault: null, notify: true, showUsage: true, cliPath: '' },
    github: { links: 'app', ctrlFlips: true, worktreeTemplate: '', draftPr: false, pollSeconds: 60,
      openAs: 'overlay', mergeMethod: 'merge', deleteBranchOnMerge: false },
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
  // Before first paint: the saved app theme (colors, radius, titlebar icon).
  if (typeof window.applyAppTheme === 'function') {
    try { window.applyAppTheme(current.general && current.general.appTheme); } catch (_) {}
  }

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
        controls: [{ kind: 'toggle', sec: 'general', key: 'confirmClose' }] },
      { label: 'Apptema',
        desc: 'Färger, hörn och ikon i hela appen. Terminalen följer med om Terminal → Färgschema är "Följ apptema".',
        controls: [{ kind: 'select', sec: 'general', key: 'appTheme', options: [
          opt('default', 'Nuvarande'), opt('fjord', 'Fjord'), opt('heather', 'Ljung'), opt('deep', 'Djuphav'),
          opt('graphite', 'Grafit'), opt('contrast', 'Kontrast'), opt('cobalt', 'Kobolt')] }] }
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
          opt('app', 'Följ apptema'), opt('windowsTerminal', 'Windows Terminal'), opt('oneHalfDark', 'One Half Dark'), opt('solarizedDark', 'Solarized Dark')] }] },
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
      { label: 'Notis när ett flöde är klart eller behöver dig',
        desc: 'Windows-notis från orchestrate-flödet, och när en chatt väntar på godkännande. Bara när fönstret saknar fokus.',
        controls: [{ kind: 'toggle', sec: 'claude', key: 'notify' }] },
      { label: 'Visa planförbrukning',
        desc: '5-timmars- och veckofönstret i statusraden och i chattarnas sidfot.',
        controls: [{ kind: 'toggle', sec: 'claude', key: 'showUsage' }] },
      { label: 'Sökväg till claude',
        desc: 'Gäller chattpaneler och appens egna claude-kommandon (t.ex. MCP), inte terminalflikar. Fullständig sökväg till claude.exe, .cmd eller .bat. Tomt = PATH, sedan ~\\.local\\bin\\claude.exe.',
        controls: [{ kind: 'text', sec: 'claude', key: 'cliPath', placeholder: 'Automatisk', check: 'cliPath', mono: true }] }
    ] },
    { id: 'claudecfg', label: 'Claude-konfiguration', claudecfg: true },
    { id: 'claudeflows', label: 'Flöden', claudeflows: true },
    { id: 'github', label: 'GitHub', rows: [
      { label: 'Öppna GitHub som',
        desc: 'Popup lägger GitHub över appen (Esc eller Ctrl+Shift+G stänger). Egen flik öppnar den som en vanlig flik. En redan öppen GitHub-flik ligger kvar tills du stänger den.',
        controls: [{ kind: 'segmented', sec: 'github', key: 'openAs', options: [
          opt('overlay', 'Popup'), opt('tab', 'Egen flik')] }] },
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
          opt(60, 'Var 60:e sekund'), opt(300, 'Var 5:e minut'), opt(0, 'Bara när fliken öppnas')] }] },
      { label: 'Förvalt merge-sätt',
        desc: 'Förvalt i Merge-dialogen. Tillåter repot inte valet förväljs det första som repot tillåter.',
        controls: [{ kind: 'segmented', sec: 'github', key: 'mergeMethod', options: [
          opt('merge', 'Merge commit'), opt('squash', 'Squash'), opt('rebase', 'Rebase')] }] },
      { label: 'Ta bort branchen efter merge',
        desc: 'Förvalt läge för "Delete branch" i Merge-dialogen.',
        controls: [{ kind: 'toggle', sec: 'github', key: 'deleteBranchOnMerge' }] }
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

  // ---------- Claude-konfiguration: global agents, skills and hooks in ~/.claude ----------
  // Main owns every path and every write (window.claudeCfgApi). This section renders from
  // `cfg` into its own container and is rebuilt on show, on "Läs om" and after each op;
  // each rebuild replaces the section's entries in ui.rows / ui.sections so search keeps
  // working. Every write carries the rev / settingsRev from the last list.
  const CFG_ID = 'claudecfg';
  const CFG_MODELS = [opt('inherit', 'Ärv'), opt('opus', 'opus'), opt('sonnet', 'sonnet'), opt('haiku', 'haiku'), opt('fable', 'fable')];
  const CFG_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
  const CFG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const CFG_NAME_ERR = 'Namnet får bara ha A–Z, 0–9, - och _, börja med en bokstav eller siffra och vara högst 64 tecken.';
  const CFG_CONFLICT = 'Filen har ändrats utanför Mac Code. Läser om…';
  const CFG_BACKUP = 'En säkerhetskopia sparas i ~/.claude/backups/mac-code.';
  // form: { kind: agentNew|skillNew|hookNew|hookEdit, id?, event?, values, initial, error, back }
  const cfg = { data: null, loading: false, loadErr: null, token: 0, busy: false, msg: null, form: null };

  function cfgApi() {
    const a = window.claudeCfgApi;
    return a && typeof a === 'object' ? a : null;
  }
  async function cfgCall(method, args) {
    const a = cfgApi();
    if (!a || typeof a[method] !== 'function') return { ok: false, error: 'saknas i den här versionen av Mac Code' };
    try {
      const r = await a[method](args);
      return r && typeof r === 'object' ? r : { ok: false, error: 'inget svar' };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }
  // agentPath / skillPath / hookScriptPath -> a path string, or null.
  async function cfgPath(method, args) {
    const a = cfgApi();
    if (!a || typeof a[method] !== 'function') return null;
    try {
      const r = await a[method](args);
      if (typeof r === 'string') return r || null;
      if (r && r.ok !== false && typeof r.path === 'string') return r.path || null;
    } catch (_) {}
    return null;
  }
  const cfgList = (k) => (cfg.data && Array.isArray(cfg.data[k]) ? cfg.data[k] : []);
  const cfgStr = (v) => (v == null ? '' : String(v));
  const cfgMatcher = (m) => (m == null || m === '' ? 'alla' : String(m));
  function fk(node, key) { node.dataset.cfgFocus = key; return node; }
  function cfgBtn(label, key, onClick, extra) {
    const b = el('button', 'set-btn sm' + (extra ? ' ' + extra : ''), label);
    b.type = 'button';
    if (key) fk(b, key);
    b.addEventListener('click', onClick);
    return b;
  }
  function cfgRowObj(node, search) {
    return { def: { label: '' }, sectionId: CFG_ID, controls: [], el: node, search: String(search || '').toLowerCase() };
  }

  function cfgDirty() {
    const f = cfg.form;
    if (!f) return false;
    return Object.keys(f.values).some((k) => cfgStr(f.values[k]) !== cfgStr(f.initial[k]));
  }
  function cfgFocusKey(key) {
    if (!key || !ui || !ui.cfg) return false;
    const n = ui.cfg.root.querySelector('[data-cfg-focus="' + CSS.escape(key) + '"]');
    if (n && !n.disabled) { n.focus(); return true; }
    return false;
  }
  // -> true when there is no unsaved form, or the user chose to throw it away.
  async function cfgConfirmDiscard() {
    if (!cfgDirty()) return true;
    const ok = await appConfirm({
      title: 'Släng formuläret?',
      message: 'Det du har skrivit under Claude-konfiguration är inte sparat.',
      okLabel: 'Släng', danger: true
    });
    if (ok) { cfg.form = null; cfgRender(); }
    return ok;
  }
  async function cfgOpenForm(form) {
    if (cfg.form && !(await cfgConfirmDiscard())) return;
    form.initial = Object.assign({}, form.values);
    form.error = null;
    cfg.form = form;
    cfgRender();
    cfgFocusKey('form:first');
  }
  // The section is on screen: it is the active one, or a search is showing it.
  function cfgVisible() {
    const sec = ui && ui.sections.get(CFG_ID);
    return !!sec && !sec.box.hidden;
  }
  // Esc closes an open form before it closes the dialog. -> true when it did.
  function cfgCancelForm() {
    if (!cfg.form) return false;
    const back = cfg.form.back;
    cfg.form = null;
    cfgRender();
    if (!cfgFocusKey(back)) ui.content.focus();
    return true;
  }

  function cfgSetMsg(msg) {
    cfg.msg = msg;
    cfgPaintMsg();
  }
  function cfgPaintMsg() {
    const n = ui && ui.cfg && ui.cfg.msgEl;
    if (!n) return;
    let m = cfg.msg;
    if (!m && !cfgApi()) m = { text: 'Claude-konfigurationen är inte tillgänglig i den här versionen av Mac Code.', kind: 'warn' };
    else if (!m && cfg.loadErr) m = { text: 'Kunde inte läsa in: ' + cfg.loadErr, kind: 'err' };
    else if (!m && cfg.loading && !cfg.data) m = { text: 'Läser in…', kind: null };
    n.textContent = m ? m.text : '';
    n.className = 'set-row-note' + (m && m.kind ? ' ' + m.kind : '');
    n.hidden = !m;
  }

  async function cfgReload() {
    if (!ui || !ui.cfg) return;
    const t = ++cfg.token;
    if (!cfgApi()) { cfg.loading = false; cfg.data = null; cfgRender(); return; }
    cfg.loading = true;
    cfgPaintMsg();
    const res = await cfgCall('list');
    if (t !== cfg.token) return;
    cfg.loading = false;
    if (res.ok) {
      cfg.data = res;
      cfg.loadErr = null;
      // An edit form whose hook is gone has nothing left to edit.
      if (cfg.form && cfg.form.kind === 'hookEdit' && !cfgList('hooks').some((h) => h.id === cfg.form.id)) cfg.form = null;
      // Unreadable settings.json: no hook form can be saved, so none stays open.
      if (cfg.form && res.settingsError && (cfg.form.kind === 'hookEdit' || cfg.form.kind === 'hookNew')) cfg.form = null;
    } else {
      cfg.data = null;
      cfg.loadErr = res.error || 'okänt fel';
    }
    cfgRender();
  }

  // One row op (model, delete, on/off). Success, conflict and error all end in a fresh list;
  // Avbryt in main's native confirm (canceled) just puts the rows back as they were.
  async function cfgRun(failLabel, method, args) {
    if (cfg.busy) { cfgRender(); return null; }
    cfg.busy = true;
    cfgSetMsg(null);
    const res = await cfgCall(method, args);
    cfg.busy = false;
    if (res.ok) { await cfgReload(); return res; }
    if (res.canceled) { cfgRender(); return res; }
    cfgSetMsg(res.conflict ? { text: CFG_CONFLICT, kind: 'warn' } : { text: failLabel + ': ' + (res.error || 'okänt fel'), kind: 'err' });
    await cfgReload();
    return res;
  }

  async function cfgOpenInEditor(method, args) {
    if (!(await cfgConfirmDiscard())) return;
    const p = await cfgPath(method, args);
    if (!p || typeof window.macOpenInEditor !== 'function') { cfgSetMsg({ text: 'Kunde inte öppna filen.', kind: 'err' }); return; }
    close();
    window.macOpenInEditor(p);
  }

  function cfgTimeout(v) {
    const s = cfgStr(v).trim();
    if (!s) return { value: null };
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) return { err: 'Timeout är hela sekunder (1 eller mer), eller tomt.' };
    return { value: n };
  }

  async function cfgSubmitForm() {
    const f = cfg.form;
    if (!f || cfg.busy) return;
    const v = f.values;
    const rev = cfg.data ? cfg.data.settingsRev : undefined;
    let method, args, err = null, editorPath = null;
    if (f.kind === 'agentNew' || f.kind === 'skillNew') {
      const isAgent = f.kind === 'agentNew';
      const name = cfgStr(v.name).trim();
      const description = cfgStr(v.description).trim();
      const taken = cfgList(isAgent ? 'agents' : 'skills').some((x) => cfgStr(x.id).toLowerCase() === name.toLowerCase());
      if (!CFG_NAME_RE.test(name)) err = CFG_NAME_ERR;
      else if (taken) err = 'Det finns redan en ' + (isAgent ? 'agent' : 'skill') + ' som heter ' + name + '.';
      else if (!description) err = 'Skriv en beskrivning. Claude använder den för att välja ' + (isAgent ? 'agenten.' : 'skillen.');
      if (isAgent) { method = 'agentCreate'; args = { name, description, model: cfgStr(v.model) || 'inherit' }; editorPath = ['agentPath', { name }]; }
      else { method = 'skillCreate'; args = { name, description }; editorPath = ['skillPath', { name }]; }
    } else {
      const command = cfgStr(v.command).trim();
      const matcher = cfgStr(v.matcher).trim();
      const t = cfgTimeout(v.timeout);
      if (f.kind === 'hookNew' && !/^[A-Za-z]{1,40}$/.test(cfgStr(v.event))) err = 'Välj en händelse.';
      else if (!command) err = 'Skriv ett kommando.';
      else if (t.err) err = t.err;
      if (f.kind === 'hookNew') { method = 'hookAdd'; args = { event: cfgStr(v.event), matcher, command, timeout: t.value, settingsRev: rev }; }
      else { method = 'hookUpdate'; args = { id: f.id, matcher, command, timeout: t.value, settingsRev: rev }; }
    }
    if (err) { f.error = err; cfgRender(); cfgFocusKey('form:submit'); return; }

    cfg.busy = true;
    f.error = null;
    cfgSetMsg(null);
    const res = await cfgCall(method, args);
    cfg.busy = false;
    if (res.ok) {
      if (cfg.form === f) cfg.form = null;
      if (editorPath) {
        const p = await cfgPath(editorPath[0], editorPath[1]);
        if (p && typeof window.macOpenInEditor === 'function') { close(); window.macOpenInEditor(p); return; }
        cfgSetMsg({ text: 'Skapad, men filen kunde inte öppnas i editorn.', kind: 'warn' });
      }
      await cfgReload();
      return;
    }
    // Avbryt in main's own confirm: nothing happened, the form stays as it was.
    if (res.canceled) { cfgRender(); return; }
    if (res.conflict) { cfgSetMsg({ text: CFG_CONFLICT, kind: 'warn' }); await cfgReload(); return; }
    if (cfg.form === f) f.error = 'Kunde inte spara: ' + (res.error || 'okänt fel');
    cfgRender();
    cfgFocusKey('form:submit');
  }

  // ----- rows -----
  function cfgToolbarRow() {
    const rowEl = el('div', 'set-row');
    const text = el('div', 'set-row-text');
    text.appendChild(el('div', 'set-row-label', 'Globala agenter, skills och hooks'));
    text.appendChild(el('div', 'set-row-desc',
      'Från ~/.claude och gäller alla Claude-sessioner. Före varje ändring sparas en säkerhetskopia i ~/.claude/backups/mac-code. Nya sessioner läser in ändringarna.'));
    const root = cfg.data && cfg.data.paths && typeof cfg.data.paths.root === 'string' ? cfg.data.paths.root : '';
    if (root) { const p = el('div', 'set-path', root); p.title = root; text.appendChild(p); }
    const note = el('div', 'set-row-note');
    note.setAttribute('role', 'status');
    note.hidden = true;
    text.appendChild(note);
    ui.cfg.msgEl = note;
    rowEl.appendChild(text);
    const ctl = el('div', 'set-row-ctl');
    if (cfgApi()) ctl.appendChild(cfgBtn('Läs om', 'reload', () => { cfgSetMsg(null); cfgReload(); }));
    rowEl.appendChild(ctl);
    return cfgRowObj(rowEl, 'claude konfiguration globala agenter skills hooks läs om säkerhetskopia');
  }

  function cfgGroupHeader(title, desc, newLabel, onNew, key) {
    const h = el('div', 'cfg-group');
    const text = el('div', 'set-row-text');
    text.appendChild(el('h3', 'cfg-h3', title));
    if (desc) text.appendChild(el('div', 'set-row-desc', desc));
    h.appendChild(text);
    const c = el('div', 'set-row-ctl');
    if (newLabel) c.appendChild(cfgBtn(newLabel, key, onNew));
    h.appendChild(c);
    return h;
  }
  function cfgEmptyRow(text) {
    const r = el('div', 'set-row compact');
    r.appendChild(el('div', 'set-row-desc', text));
    return r;
  }
  // Header + items as rows; the header matches whatever any of its items matches.
  function cfgAddGroup(add, headerEl, title, items) {
    add(cfgRowObj(headerEl, title + ' ' + items.map((r) => r.search).join(' ')));
    for (const r of items) add(r);
  }

  function cfgAgentRow(a) {
    const id = cfgStr(a.id);
    const name = cfgStr(a.name) || id;
    const rowEl = el('div', 'set-row cfg-item');
    const text = el('div', 'set-row-text');
    const lab = el('div', 'set-row-label cfg-ellipsis', name);
    if (id && name !== id) lab.appendChild(el('span', 'cfg-badge', id + '.md'));
    text.appendChild(lab);
    const desc = cfgStr(a.description);
    if (desc) { const d = el('div', 'set-row-desc cfg-ellipsis', desc); d.title = desc; text.appendChild(d); }
    if (a.readonly) text.appendChild(el('div', 'set-row-note warn', 'Filnamnet är inget giltigt namn, så agenten kan inte ändras här.'));
    rowEl.appendChild(text);
    const ctl = el('div', 'set-row-ctl');
    if (!a.readonly) {
      const s = fk(el('select', 'set-select cfg-model'), 'agent-model:' + id);
      s.setAttribute('aria-label', 'Modell för ' + name);
      const cur = cfgStr(a.model).trim() || 'inherit';
      const opts = CFG_MODELS.slice();
      if (!opts.some((o) => o.value === cur)) opts.push(opt(cur, cur));
      for (const o of opts) { const op = el('option', null, o.label); op.value = o.value; s.appendChild(op); }
      s.value = cur;
      s.addEventListener('change', () => {
        if (s.value === cur) return;
        cfgRun('Kunde inte byta modell', 'agentSetModel', { name: id, model: s.value, rev: a.rev });
      });
      ctl.appendChild(s);
      ctl.appendChild(cfgBtn('Redigera', 'agent-edit:' + id, () => cfgOpenInEditor('agentPath', { name: id })));
      ctl.appendChild(cfgBtn('Ta bort', 'agent-del:' + id, async () => {
        const ok = await appConfirm({
          title: 'Ta bort agenten ' + name + '?',
          message: 'Filen ' + id + '.md tas bort ur ~/.claude/agents. ' + CFG_BACKUP,
          okLabel: 'Ta bort', danger: true
        });
        if (ok) cfgRun('Kunde inte ta bort agenten', 'agentDelete', { name: id, rev: a.rev });
      }));
    }
    rowEl.appendChild(ctl);
    return cfgRowObj(rowEl, 'agent ' + name + ' ' + id + ' ' + desc + ' ' + cfgStr(a.model));
  }

  function cfgSkillRow(s) {
    const id = cfgStr(s.id);
    const name = cfgStr(s.name) || id;
    const target = cfgStr(s.target);
    const rowEl = el('div', 'set-row cfg-item');
    const text = el('div', 'set-row-text');
    const lab = el('div', 'set-row-label cfg-ellipsis', name);
    if (id && name !== id) lab.appendChild(el('span', 'cfg-badge', id));
    if (s.linked) { const b = el('span', 'cfg-badge', 'länkad'); if (target) b.title = target; lab.appendChild(b); }
    text.appendChild(lab);
    const desc = cfgStr(s.description);
    if (desc) { const d = el('div', 'set-row-desc cfg-ellipsis', desc); d.title = desc; text.appendChild(d); }
    if (s.linked && target) { const p = el('div', 'set-path', '→ ' + target); p.title = target; text.appendChild(p); }
    if (s.readonly) text.appendChild(el('div', 'set-row-note warn', 'Mappnamnet är inget giltigt namn, så skillen kan inte ändras här.'));
    rowEl.appendChild(text);
    const ctl = el('div', 'set-row-ctl');
    if (!s.readonly) {
      ctl.appendChild(cfgBtn('Redigera', 'skill-edit:' + id, () => cfgOpenInEditor('skillPath', { name: id })));
      ctl.appendChild(cfgBtn('Ta bort', 'skill-del:' + id, async () => {
        let message;
        if (s.linked) {
          message = 'Tar bort länken till ' + (target || 'målmappen') + '; innehållet ligger kvar.';
        } else {
          const p = await cfgPath('skillPath', { name: id });
          const dir = p ? p.replace(/[\\/][^\\/]*$/, '') : '~/.claude/skills/' + id;
          const n = typeof s.files === 'number' ? s.files : Array.isArray(s.files) ? s.files.length : null;
          message = 'Hela mappen tas bort:\n' + dir +
            (n == null ? '' : '\n' + n + (n === 1 ? ' fil.' : ' filer.')) + '\n\n' + CFG_BACKUP;
        }
        const ok = await appConfirm({ title: 'Ta bort skillen ' + name + '?', message, okLabel: 'Ta bort', danger: true });
        if (ok) cfgRun('Kunde inte ta bort skillen', 'skillDelete', { name: id, rev: s.rev, linked: !!s.linked });
      }));
    }
    rowEl.appendChild(ctl);
    return cfgRowObj(rowEl, 'skill ' + name + ' ' + id + ' ' + desc + (s.linked ? ' länkad ' + target : ''));
  }

  // lock.settings: settings.json is unreadable, so nothing may write it (edit, delete, on/off).
  // lock.disabled: Mac Code's list of turned-off hooks is unreadable, so on/off is out too.
  function cfgHookRow(h, off, lock) {
    const type = cfgStr(h.type) || 'command';
    const isCmd = type === 'command';
    const canWrite = !lock.settings;
    const canToggle = canWrite && !lock.disabled;
    const editable = canWrite && !off && isCmd && h.editable !== false;
    const event = cfgStr(h.event);
    const matcher = cfgMatcher(h.matcher);
    const command = cfgStr(h.command);
    // Ids change when a hook is turned off/on; focus follows the hook by its content.
    const stable = event + '\u0001' + cfgStr(h.matcher) + '\u0001' + command;
    const rev = cfg.data ? cfg.data.settingsRev : undefined;

    const rowEl = el('div', 'set-row cfg-item' + (off ? ' cfg-off' : ''));
    const text = el('div', 'set-row-text');
    const lab = el('div', 'set-row-label cfg-ellipsis');
    lab.appendChild(el('span', 'cfg-k', 'matcher '));
    lab.appendChild(document.createTextNode(matcher));
    lab.title = matcher;
    if (!isCmd) lab.appendChild(el('span', 'cfg-badge', type));
    if (off) lab.appendChild(el('span', 'cfg-badge', 'av'));
    text.appendChild(lab);
    const shown = command || cfgStr(h.statusMessage);
    if (shown) { const c = el('div', 'cfg-cmd cfg-ellipsis', shown); c.title = shown; text.appendChild(c); }
    const meta = [];
    if (h.timeout != null && h.timeout !== '') meta.push('timeout ' + cfgStr(h.timeout) + ' s');
    if (command && h.statusMessage) meta.push('status: ' + cfgStr(h.statusMessage));
    if (!isCmd) meta.push('typ ' + type + ', kan inte redigeras här');
    if (off) meta.push('avstängd, sparas i Mac Code tills den slås på');
    if (meta.length) text.appendChild(el('div', 'set-row-desc', meta.join(' · ')));
    rowEl.appendChild(text);

    const ctl = el('div', 'set-row-ctl');
    if (editable) {
      ctl.appendChild(cfgBtn('Redigera', 'hook-edit:' + stable, () => cfgOpenForm({
        kind: 'hookEdit', id: h.id, event, back: 'hook-edit:' + stable,
        values: { matcher: cfgStr(h.matcher), command, timeout: h.timeout == null ? '' : cfgStr(h.timeout) }
      })));
    }
    if (!off && h.script) ctl.appendChild(cfgBtn('Öppna script', 'hook-script:' + stable, () => cfgOpenInEditor('hookScriptPath', { id: h.id })));
    if (!off && canWrite) {
      ctl.appendChild(cfgBtn('Ta bort', 'hook-del:' + stable, async () => {
        const ok = await appConfirm({
          title: 'Ta bort hooken?',
          message: event + ' · matcher ' + matcher + '\n' + (command || type) + '\n\nTas bort ur ~/.claude/settings.json. ' + CFG_BACKUP,
          okLabel: 'Ta bort', danger: true
        });
        if (ok) cfgRun('Kunde inte ta bort hooken', 'hookRemove', { id: h.id, settingsRev: rev });
      }));
    }
    const sw = fk(el('button', 'set-switch'), 'hook-sw:' + stable);
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!off));
    sw.setAttribute('aria-label', 'Hook ' + event + ', matcher ' + matcher + ', på');
    sw.title = !canToggle ? 'Går inte att ändra just nu' : off ? 'Slå på' : 'Stäng av';
    sw.disabled = !canToggle;
    sw.appendChild(el('span', 'set-switch-knob'));
    sw.addEventListener('click', () => {
      if (cfg.busy || !canToggle) return;
      sw.setAttribute('aria-checked', String(off));
      if (off) cfgRun('Kunde inte slå på hooken', 'hookEnable', { disabledId: h.id, settingsRev: rev });
      else cfgRun('Kunde inte stänga av hooken', 'hookDisable', { id: h.id, settingsRev: rev });
    });
    ctl.appendChild(sw);
    rowEl.appendChild(ctl);
    return cfgRowObj(rowEl, 'hook ' + event + ' ' + matcher + ' ' + command + ' ' + type + (off ? ' av avstängd' : ''));
  }

  // The open inline form, as a row. `search` = its group's, so it shows with the group.
  function cfgFormRow(search) {
    const f = cfg.form;
    const titles = { agentNew: 'Ny agent', skillNew: 'Ny skill', hookNew: 'Ny hook', hookEdit: 'Redigera hook · ' + cfgStr(f.event) };
    const box = el('div', 'cfg-form');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', titles[f.kind]);
    box.appendChild(el('div', 'cfg-form-title', titles[f.kind]));
    const grid = el('div', 'cfg-form-grid');
    let first = true;
    const field = (label, key, o = {}) => {
      const wrap = el('label', 'cfg-field' + (o.wide ? ' wide' : ''));
      wrap.appendChild(el('span', 'cfg-field-label', label));
      let input;
      if (o.options) {
        input = el('select', 'set-select');
        for (const op of o.options) { const n = el('option', null, op.label); n.value = op.value; input.appendChild(n); }
        input.value = cfgStr(f.values[key]);
        input.addEventListener('change', () => { f.values[key] = input.value; });
      } else {
        input = el('input', 'set-input' + (o.mono ? ' mono' : ''));
        input.type = o.number ? 'number' : 'text';
        if (o.number) { input.min = '1'; input.step = '1'; }
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = o.placeholder || '';
        input.value = cfgStr(f.values[key]);
        input.addEventListener('input', () => { f.values[key] = input.value; });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cfgSubmitForm(); } });
      }
      fk(input, first ? 'form:first' : 'form:' + key);
      first = false;
      wrap.appendChild(input);
      grid.appendChild(wrap);
    };
    if (f.kind === 'agentNew' || f.kind === 'skillNew') {
      field('Namn', 'name', { placeholder: f.kind === 'agentNew' ? 'code-reviewer' : 'min-skill', mono: true });
      if (f.kind === 'agentNew') field('Modell', 'model', { options: CFG_MODELS });
      field('Beskrivning', 'description', { wide: true, placeholder: 'När Claude ska använda den' });
    } else {
      if (f.kind === 'hookNew') {
        const evs = CFG_EVENTS.slice();
        for (const h of cfgList('hooks')) if (h.event && !evs.includes(cfgStr(h.event))) evs.push(cfgStr(h.event));
        field('Händelse', 'event', { options: evs.map((e) => opt(e, e)) });
      }
      field('Matcher', 'matcher', { mono: true, placeholder: 'Tomt = alla, t.ex. Bash|Edit' });
      field('Timeout (s)', 'timeout', { number: true, placeholder: 'Standard' });
      field('Kommando', 'command', { wide: true, mono: true, placeholder: 'node "C:\\Users\\…\\.claude\\hooks\\script.js"' });
    }
    box.appendChild(grid);
    box.appendChild(el('div', 'set-row-desc', f.kind === 'hookNew' || f.kind === 'hookEdit'
      ? 'Kommandot körs i varje Claude-session. Mac Code visar det och frågar en gång till innan det sparas.'
      : 'Filen skapas från en mall och öppnas i editorn.'));
    if (f.error) { const n = el('div', 'set-row-note err', f.error); n.setAttribute('role', 'alert'); box.appendChild(n); }
    const foot = el('div', 'cfg-form-foot');
    foot.appendChild(cfgBtn('Avbryt', 'form:cancel', () => cfgCancelForm(), 'ghost'));
    foot.appendChild(cfgBtn(f.kind === 'hookEdit' ? 'Spara' : 'Skapa', 'form:submit', () => cfgSubmitForm(), 'primary'));
    box.appendChild(foot);
    return cfgRowObj(box, search);
  }

  function cfgRender() {
    if (!ui || !ui.cfg) return;
    const root = ui.cfg.root;
    const a = document.activeElement;
    const focusKey = a && root.contains(a) ? a.dataset.cfgFocus : null;
    root.textContent = '';
    ui.cfg.msgEl = null;
    const rows = [];
    const add = (r) => { root.appendChild(r.el); rows.push(r); return r; };
    add(cfgToolbarRow());
    const f = cfg.form;

    if (cfgApi() && cfg.data) {
      // Agenter
      const agents = cfgList('agents').map(cfgAgentRow);
      if (!agents.length) agents.push(cfgRowObj(cfgEmptyRow('Inga agenter i ~/.claude/agents.'), 'agenter'));
      if (f && f.kind === 'agentNew') agents.push(cfgFormRow('agenter ny agent'));
      cfgAddGroup(add, cfgGroupHeader('Agenter', 'Underagenter i ~/.claude/agents. Ärv = samma modell som sessionen.', 'Ny agent',
        () => cfgOpenForm({ kind: 'agentNew', back: 'agent-new', values: { name: '', description: '', model: 'inherit' } }), 'agent-new'),
        'agenter ny agent', agents);

      // Skills
      const skills = cfgList('skills').map(cfgSkillRow);
      if (!skills.length) skills.push(cfgRowObj(cfgEmptyRow('Inga skills i ~/.claude/skills.'), 'skills'));
      if (f && f.kind === 'skillNew') skills.push(cfgFormRow('skills ny skill'));
      cfgAddGroup(add, cfgGroupHeader('Skills', 'Mappar med SKILL.md i ~/.claude/skills. Skills från plugins visas inte.', 'Ny skill',
        () => cfgOpenForm({ kind: 'skillNew', back: 'skill-new', values: { name: '', description: '' } }), 'skill-new'),
        'skills ny skill', skills);

      // Hooks, grouped by the event keys actually in settings.json, plus the turned-off ones.
      const settingsError = cfgStr(cfg.data.settingsError);
      const disabledError = cfgStr(cfg.data.disabledError);
      const lock = { settings: !!settingsError, disabled: !!disabledError };
      const byEvent = new Map();
      const put = (h, off) => {
        const ev = cfgStr(h.event) || '?';
        if (!byEvent.has(ev)) byEvent.set(ev, []);
        byEvent.get(ev).push(cfgHookRow(h, off, lock));
        if (!off && !lock.settings && f && f.kind === 'hookEdit' && f.id === h.id) byEvent.get(ev).push(null); // the edit form goes here
      };
      for (const h of cfgList('hooks')) put(h, false);
      for (const h of cfgList('disabled')) put(h, true);
      const hookItems = [];
      const errRow = (text) => {
        const r = el('div', 'set-row compact');
        const n = el('div', 'set-row-note err', text);
        n.setAttribute('role', 'alert');
        r.appendChild(n);
        hookItems.push(cfgRowObj(r, 'hooks fel ' + text));
      };
      if (settingsError) errRow('settings.json kunde inte läsas: ' + settingsError + '. Hooks kan inte ändras förrän filen är giltig JSON.');
      if (disabledError) errRow('Listan med avstängda hooks kunde inte läsas: ' + disabledError + '. Hooks kan inte slås av eller på förrän det är löst.');
      for (const [ev, list] of byEvent) {
        const evSearch = 'hooks ' + ev + ' ' + list.filter(Boolean).map((r) => r.search).join(' ');
        hookItems.push(cfgRowObj(el('div', 'cfg-event', ev), evSearch));
        for (const r of list) hookItems.push(r || cfgFormRow(evSearch));
      }
      if (!byEvent.size && !settingsError) hookItems.push(cfgRowObj(cfgEmptyRow('Inga hooks i ~/.claude/settings.json.'), 'hooks'));
      if (f && f.kind === 'hookNew' && !lock.settings) hookItems.push(cfgFormRow('hooks ny hook'));
      cfgAddGroup(add, cfgGroupHeader('Hooks',
        'Från hooks i ~/.claude/settings.json. Av = hooken flyttas ur settings.json till Mac Codes egen lista och kan slås på igen.',
        lock.settings ? null : 'Ny hook', () => cfgOpenForm({ kind: 'hookNew', back: 'hook-new', values: { event: 'PreToolUse', matcher: '', command: '', timeout: '' } }), 'hook-new'),
        'hooks ny hook', hookItems);
    }

    ui.rows = ui.rows.filter((r) => r.sectionId !== CFG_ID).concat(rows);
    const sec = ui.sections.get(CFG_ID);
    if (sec) sec.rows = rows;
    cfgPaintMsg();
    if (ui.search) applySearch();
    if (focusKey) cfgFocusKey(focusKey);
  }

  // Section builder (like buildAboutRows): just the container; cfgRender fills it.
  function buildClaudeCfgRows(sec, box) {
    const root = el('div', 'cfg-root');
    box.appendChild(root);
    ui.cfg = { root, msgEl: null };
    return [];
  }

  // ---------- Flöden: the canvas editor (flowEditor.js) ----------
  // The section holds one search row (shown only while searching) and the editor's host.
  // Shown on its own, the dialog goes wide and the content stops scrolling (the canvas
  // fills it). The editor keeps its state across closes, so an edit that could not be
  // saved is still there when the dialog opens again.
  const FLOW_ID = 'claudeflows';
  const flowUi = { host: null, mounted: false, shown: false };
  function flowEditor() {
    const f = window.FlowEditor;
    return f && typeof f.mount === 'function' ? f : null;
  }
  function flowFlush() {
    const f = flowEditor();
    if (!f || !flowUi.mounted || typeof f.flush !== 'function') return Promise.resolve({ ok: true });
    try { return Promise.resolve(f.flush()).catch((e) => ({ ok: false, error: (e && e.message) || String(e) })); }
    catch (e) { return Promise.resolve({ ok: false, error: (e && e.message) || String(e) }); }
  }
  function flowMount() {
    if (!flowUi.host) return;
    const f = flowEditor();
    if (!f) {
      if (!flowUi.host.firstChild) {
        const n = el('div', 'set-row-note warn', 'Flödesredigeraren saknas i den här versionen av Mac Code.');
        n.setAttribute('role', 'status');
        flowUi.host.appendChild(n);
      }
      return;
    }
    f.mount(flowUi.host, {
      flowApi: window.flowCfgApi || null,
      claudeCfgApi: cfgApi(),
      openInEditor: (p) => {
        if (typeof window.macOpenInEditor !== 'function') return;
        close();
        window.macOpenInEditor(p);
      },
      confirm: appConfirm
    });
    flowUi.mounted = true;
  }
  // Esc inside the editor (drawer, menu, form, big mode) closes that first. -> true when it did.
  function flowConsumesEsc() {
    const f = flowEditor();
    if (!f || !flowUi.mounted || !flowUi.shown || typeof f.consumesEsc !== 'function') return false;
    try { return !!f.consumesEsc(); } catch (_) { return false; }
  }
  // Wide layout + mount when the section is the one on screen (no search).
  function flowLayout(q) {
    const on = !q && activeSection === FLOW_ID && isOpen();
    const was = flowUi.shown;
    flowUi.shown = on;
    ui.dlg.classList.toggle('wide', on);
    ui.content.classList.toggle('flows', on);
    if (!on) ui.dlg.classList.remove('flow-big');
    if (flowUi.host) flowUi.host.hidden = !on;
    if (on && !was) flowMount();
    if (!on && was) flowFlush();
  }
  // Before the dialog closes: the last edit must be saved, or the user says close anyway.
  async function flowSettleBeforeClose() {
    if (!flowUi.mounted) return true;
    const r = await Promise.race([flowFlush(), new Promise((res) => setTimeout(() => res({ timeout: true }), 1500))]);
    // Still saving after 1.5 s: it carries on in the background.
    if (!r || r.ok || r.timeout) return true;
    return appConfirm({
      title: 'Flödet är inte sparat',
      message: r.conflict
        ? 'Flödesfilen ändrades utanför Mac Code. Dina ändringar finns kvar under Flöden tills Mac Code stängs. Stäng ändå?'
        : 'Ändringen kunde inte sparas: ' + (r.error || 'okänt fel') + '. Stäng ändå?',
      okLabel: 'Stäng ändå', cancelLabel: 'Stanna'
    });
  }
  function buildFlowRows(sec, box) {
    const rowEl = el('div', 'set-row');
    const text = el('div', 'set-row-text');
    text.appendChild(el('div', 'set-row-label', 'Flöden'));
    text.appendChild(el('div', 'set-row-desc', 'Claude-flöden som skills, ritade på en canvas: steg, agenter, villkor och hooks.'));
    rowEl.appendChild(text);
    const ctl = el('div', 'set-row-ctl');
    ctl.appendChild(smallBtn('Öppna', () => { ui.search.value = ''; showSection(FLOW_ID); }));
    rowEl.appendChild(ctl);
    const host = el('div', 'flow-host');
    host.hidden = true;
    box.appendChild(host);
    flowUi.host = host;
    return [{ def: { label: 'Flöden' }, sectionId: sec.id, controls: [], el: rowEl, flowSearch: true,
      search: 'flöden flow flows orchestrate canvas skill steg' }];
  }

  // Closing by the user (outside click, X, Klar, Esc) asks first when a form has unsaved
  // input, and waits for the flow editor's last save.
  async function requestClose() {
    if (!(await cfgConfirmDiscard())) return;
    if (!(await flowSettleBeforeClose())) return;
    close();
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
    x.addEventListener('click', () => requestClose());
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
      b.addEventListener('click', () => {
        search.value = '';
        showSection(sec.id);
        if (sec.claudecfg) cfgReload();
      });
      nav.appendChild(b);
      ui.nav.set(sec.id, b);

      const box = el('section', 'set-section');
      box.setAttribute('aria-label', sec.label);
      box.appendChild(el('h2', 'set-h2', sec.label));
      if (sec.note) box.appendChild(el('div', 'set-section-note', sec.note));
      const rows = sec.keys ? buildKeysRows(sec) : sec.about ? buildAboutRows(sec)
        : sec.claudecfg ? buildClaudeCfgRows(sec, box)
        : sec.claudeflows ? buildFlowRows(sec, box) : sec.rows.map((r) => buildRow(r, sec.id));
      for (const r of rows) { if (r.flowSearch) box.insertBefore(r.el, flowUi.host); else box.appendChild(r.el); ui.rows.push(r); }
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
    done.addEventListener('click', () => requestClose());
    foot.appendChild(reset);
    foot.appendChild(done);
    dlg.appendChild(foot);

    overlay.appendChild(dlg);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) requestClose(); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Esc in a search box with text clears it first; an open Claude-konfiguration
        // form is cancelled next; only then does Esc close the dialog.
        if (document.activeElement === search && search.value) { e.preventDefault(); search.value = ''; applySearch(); }
        else if (cfg.form && cfgVisible()) { e.preventDefault(); cfgCancelForm(); }
        else if (flowConsumesEsc()) e.preventDefault();
        else { e.preventDefault(); requestClose(); }
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
        // The flows search row only shows while searching; the canvas takes its place.
        for (const r of rows) r.el.hidden = !!r.flowSearch;
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
    flowLayout(q);
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
    ui.overlay.classList.add('show');
    showSection(activeSection);
    ui.search.focus();
    refreshChecks();
    refreshAbout();
    // Loaded fresh on every open, so search finds agents / skills / hooks too.
    cfgReload();
  }

  function close() {
    if (!isOpen()) return;
    // A pending flow edit keeps saving in the background; the editor stays mounted.
    flowFlush();
    // A text field with an unsent edit: commit it the way a blur would.
    const a = document.activeElement;
    if (a && ui.dlg.contains(a) && a.tagName === 'INPUT' && a.type === 'text') a.blur();
    // An unsaved Claude-konfiguration form does not outlive the dialog.
    cfg.form = null;
    ui.overlay.classList.remove('show');
    flowLayout('');
    const p = prevFocus;
    prevFocus = null;
    restoreFocus(p);
  }

  onAppSettingsChanged(() => { if (isOpen()) syncAll(); });

  window.openAppSettings = open;
  window.closeAppSettings = close;
  window.isAppSettingsOpen = isOpen;
})();
