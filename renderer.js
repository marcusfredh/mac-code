const { Terminal } = window;
const FitAddonNs = window.FitAddon || {};
const FitAddon = FitAddonNs.FitAddon || FitAddonNs.default || FitAddonNs;
const SerializeAddonNs = window.SerializeAddon || {};
const SerializeAddon = SerializeAddonNs.SerializeAddon || SerializeAddonNs.default || SerializeAddonNs;

const WINDOWS_TERMINAL_THEME = {
  background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff',
  cursorAccent: '#0c0c0c', selectionBackground: '#3a3d41',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
  blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
  brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e',
  brightCyan: '#61d6d6', brightWhite: '#f2f2f2'
};

// tabs: Map<tabId, Tab>
// ptyPaneMap: Map<ptyId, {tabId, paneId}> — routes pty events to the right pane
const tabs = new Map();
const ptyPaneMap = new Map();
// tabId -> chat view controller, for tabs whose surface is a Claude chat pane
const chatTabs = new Map();
let activeId = null;
const tabHistory = []; // MRU order: index 0 = most recent
let tabSeq = 0;
let paneSeq = 0;
const newTabId  = () => 'tab-'  + (++tabSeq);
const newPaneId = () => 'pane-' + (++paneSeq);

const tabsEl          = document.getElementById('tabs');
const areaEl          = document.getElementById('terminal-area');
const statusCwd       = document.getElementById('status-cwd');
const statusTabs      = document.getElementById('status-tabs');
const statusShell     = document.getElementById('status-shell');
const statusAgentsEl  = document.getElementById('status-agents');
const treeEl          = document.getElementById('tree');
const treeRootEl      = document.getElementById('tree-root');
const treeRootNameEl  = document.getElementById('tree-root-name');
const treeRootCountEl = document.getElementById('tree-root-count');
const sidebarEl       = document.getElementById('sidebar');
const sidebarHandleEl = document.getElementById('sidebar-handle');
const agentListEl     = document.getElementById('agent-list');
const agentsPanelEl   = document.getElementById('agents-panel');
const agentsHandleEl  = document.getElementById('agents-handle');
const agentsCountEl   = document.getElementById('agents-count');
const savedCountEl    = document.getElementById('saved-count');

let homeDir = '';
window.fs.home().then((h) => { homeDir = h || ''; }).catch(() => {});

// ---------- icons ----------
function shellSvg() {
  return `<svg class="tab-icon" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="2" width="14" height="12" rx="2.5" stroke="currentColor" stroke-width="1"/>
    <path d="M3.8 6l2.4 2-2.4 2M8 10h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
function closeSvg() {
  return `<svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>`;
}
function editorSvg() {
  return `<svg class="tab-icon" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="1" width="9" height="12" rx="1.5" stroke="currentColor" stroke-width="1"/>
    <path d="M4 5h5M4 7.5h5M4 10h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
    <path d="M11 9.5l2.5-2.5-1-1L10 8.5V10h1.5z" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// Tab chrome: colour dot, then either an agent badge (chat panes) or a file/shell
// glyph, then the title, then the close affordance.
function tabInnerHtml(kind, name) {
  const lead = kind === 'chat'
    ? '<span class="tab-badge">C</span>'
    : kind === 'editor' ? editorSvg() : shellSvg();
  return `<span class="tab-dot"></span>${lead}` +
    `<span class="tab-title">${escapeHtml(name)}<span class="tab-dirty"></span></span>` +
    `<span class="tab-close" title="Close tab">${closeSvg()}</span>`;
}

function shortPath(p) {
  if (!p) return '~';
  if (homeDir && p.toLowerCase().startsWith(homeDir.toLowerCase())) {
    return '~' + p.slice(homeDir.length);
  }
  return p;
}
const FILE_ICONS = {
  '.ts':'🟦','.tsx':'🟦','.js':'🟨','.jsx':'🟨','.mjs':'🟨','.cjs':'🟨',
  '.json':'📦','.md':'📘','.html':'🌐','.css':'🎨','.scss':'🎨',
  '.py':'🐍','.rs':'🦀','.go':'🐹','.java':'☕','.cs':'🟪',
  '.png':'🖼️','.jpg':'🖼️','.svg':'🖼️','.ico':'🖼️',
  '.zip':'🗜️','.gz':'🗜️','.env':'📋','.gitignore':'🙈',
  '.yml':'⚙','.yaml':'⚙','.toml':'⚙','.lock':'🔒',
  '.ps1':'💠','.sh':'📜','.bat':'📜','.cmd':'📜','.exe':'⚡'
};
function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const low = name.toLowerCase();
  if (low === 'dockerfile') return '🐳';
  if (low === 'package.json') return '📦';
  if (low.startsWith('.git')) return '🙈';
  const dot = low.lastIndexOf('.');
  return FILE_ICONS[dot >= 0 ? low.slice(dot) : ''] || '📄';
}
function basename(p) {
  if (!p) return '';
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) || s : s;
}
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------- tab drag-to-reorder ----------
let tabDrag = null;
function reorderTabsMap() {
  const newOrder = new Map();
  for (const el of tabsEl.children) {
    for (const [id, t] of tabs) {
      if (t.tabEl === el) { newOrder.set(id, t); break; }
    }
  }
  tabs.clear();
  for (const [id, t] of newOrder) tabs.set(id, t);
  updateStatus();
  scheduleSaveSession();
}
function wireTabPointer(tabEl, tabId) {
  tabEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tab-close') || e.target.closest('.tab-rename-input')) return;
    if (e.button === 1) { closeTab(tabId); return; }
    if (e.button !== 0) return;
    setActive(tabId);
    tabDrag = { tabEl, startX: e.clientX, started: false };
  });
}
document.addEventListener('pointermove', (e) => {
  if (!tabDrag) return;
  const { tabEl } = tabDrag;
  const dx = e.clientX - tabDrag.startX;
  if (!tabDrag.started && Math.abs(dx) < 5) return;
  if (!tabDrag.started) { tabDrag.started = true; tabEl.classList.add('dragging'); }
  for (const other of tabsEl.children) {
    if (other === tabEl) continue;
    const r = other.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right) {
      const before = e.clientX < r.left + r.width / 2;
      if (before) tabsEl.insertBefore(tabEl, other);
      else tabsEl.insertBefore(tabEl, other.nextSibling);
      break;
    }
  }
});
const _endTabDrag = () => {
  if (!tabDrag) return;
  const { tabEl, started } = tabDrag;
  tabDrag = null;
  tabEl.classList.remove('dragging');
  if (started) reorderTabsMap();
};
document.addEventListener('pointerup', _endTabDrag);
document.addEventListener('pointercancel', _endTabDrag);

// ---------- tab helpers ----------
function getActivePane(tab) { return tab.panes.get(tab.activePaneId); }
function tabAutoName(tab) {
  if (tab.type === 'editor') return basename(tab.filePath || '') || 'Editor';
  if (tab.type === 'chat') return basename(tab.cwd || '') || 'claude';
  return basename(getActivePane(tab)?.cwd || '') || 'PowerShell';
}
// Titles carry a trailing dirty-dot span, so never assign textContent directly.
function setTabTitle(tab, text) {
  tab.titleEl.textContent = text;
  const dot = document.createElement('span');
  dot.className = 'tab-dirty';
  tab.titleEl.appendChild(dot);
}
function setTabDirty(tab, dirty) {
  tab.dirty = !!dirty;
  tab.tabEl.classList.toggle('dirty', tab.dirty);
}

// ---------- status ----------
function tabCwd(tab) {
  if (!tab) return null;
  if (tab.type === 'editor') return tab.filePath;
  if (tab.type === 'chat') return tab.cwd;
  return getActivePane(tab)?.cwd || null;
}

function updateStatus() {
  statusTabs.textContent = `${tabs.size} tab${tabs.size === 1 ? '' : 's'}`;
  const tab = activeId ? tabs.get(activeId) : null;
  const cwd = tabCwd(tab);
  statusCwd.textContent = cwd || '~';
  statusCwd.title = cwd || '';
  updateStatusAgents();
}

// Right-hand status cluster: one dot per agent kind that is currently present.
function updateStatusAgents() {
  const rows = [];
  const claude = getAllClaudePanes();
  const copilot = getAllCopilotPanes();
  const chatViews = Array.from(chatTabs.values());
  const now = Date.now();

  const claudeWorking =
    claude.some(({ pane }) => now < pane.claudeBusyUntil) ||
    chatViews.some((c) => c.getState().working);
  if (claude.length || chatViews.length) {
    rows.push({ label: claudeWorking ? 'Claude working' : 'Claude idle', working: claudeWorking });
  }
  if (copilot.length) {
    const working = copilot.some(({ pane }) => now < pane.copilotBusyUntil);
    rows.push({ label: working ? 'Copilot working' : 'Copilot idle', working });
  }

  statusAgentsEl.innerHTML = '';
  rows.forEach((row, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'status-sep';
      sep.textContent = '·';
      statusAgentsEl.appendChild(sep);
    }
    const wrap = document.createElement('span');
    wrap.className = 'status-agent' + (row.working ? ' working' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    wrap.appendChild(dot);
    wrap.appendChild(document.createTextNode(row.label));
    statusAgentsEl.appendChild(wrap);
  });
}

// ---------- pane resize ----------
function fitPane(pane) {
  if (!pane?.fit) return;
  try {
    const dims = pane.fit.proposeDimensions();
    if (!dims?.cols || !dims?.rows) return;
    if (dims.cols !== pane.term.cols || dims.rows !== pane.term.rows) {
      pane.fit.fit();
      window.term.resize(pane.ptyId, pane.term.cols, pane.term.rows);
    }
  } catch (_) {}
}
function fitAll() {
  for (const [, tab] of tabs) for (const [, pane] of tab.panes) fitPane(pane);
}

// ---------- active tab/pane ----------
function setActivePane(tab, paneId) {
  // A chat tab's only pane is the terminal drawer. Focus it, but leave activePaneId
  // null so the tab still treats the chat surface as its main content.
  if (tab.type === 'chat') {
    const p = tab.panes.get(paneId);
    if (p) p.term.focus();
    return;
  }
  const old = getActivePane(tab);
  if (old) old.el.classList.remove('pane-active');
  tab.activePaneId = paneId;
  const pane = tab.panes.get(paneId);
  if (!pane) return;
  pane.el.classList.add('pane-active');
  pane.term.focus();
  if (tab.tabId === activeId) {
    if (!tab.customTitle) setTabTitle(tab, basename(pane.cwd || '') || 'PowerShell');
    updateStatus();
    renderTree();
  }
}

function setActive(tabId) {
  if (!tabs.has(tabId)) return;
  activeId = tabId;
  const idx = tabHistory.indexOf(tabId);
  if (idx !== -1) tabHistory.splice(idx, 1);
  tabHistory.unshift(tabId);
  const suppressUntil = Date.now() + 350;
  for (const [tid, tab] of tabs) {
    tab.tabEl.classList.toggle('active', tid === tabId);
    tab.container.classList.toggle('active', tid === tabId);
    for (const [, pane] of tab.panes) pane.suppressBusyUntil = suppressUntil;
  }
  for (const [tid, view] of chatTabs) view.setActive(tid === tabId);
  const tab = tabs.get(tabId);
  const pane = getActivePane(tab);
  if (pane) {
    requestAnimationFrame(() => {
      try { pane.fit.fit(); } catch (_) {}
      pane.term.focus();
      window.term.resize(pane.ptyId, pane.term.cols, pane.term.rows);
    });
  } else if (tab.type === 'editor' && tab.editor) {
    requestAnimationFrame(() => { try { tab.editor.focus(); } catch (_) {} });
  } else if (tab.type === 'chat') {
    const view = chatTabs.get(tabId);
    if (view) requestAnimationFrame(() => view.focus());
  }
  renderTree();
  updateStatus();
  scheduleAgentRender();
  scheduleSaveSession();
}

// ---------- context menu ----------
const ctxMenuEl = document.getElementById('ctx-menu');
function showContextMenu(x, y, items) {
  ctxMenuEl.innerHTML = '';
  for (const item of items) {
    if (item.separator) {
      const s = document.createElement('div'); s.className = 'ctx-sep';
      ctxMenuEl.appendChild(s); continue;
    }
    if (item.swatches) {
      const row = document.createElement('div'); row.className = 'ctx-swatches';
      for (const c of item.swatches) {
        const sw = document.createElement('div');
        sw.className = 'ctx-swatch' + (c.value === null ? ' none' : '');
        sw.title = c.name;
        if (c.value) sw.style.background = c.value;
        if (item.selected === c.value) sw.classList.add('selected');
        sw.addEventListener('click', () => { hideContextMenu(); item.onPick(c); });
        row.appendChild(sw);
      }
      ctxMenuEl.appendChild(row); continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.disabled ? ' disabled' : '');
    if (item.badge) {
      const b = document.createElement('span');
      b.className = 'ctx-badge' + (item.badge === 'GH' ? ' gh' : '');
      b.textContent = item.badge;
      el.appendChild(b);
    }
    const lbl = document.createElement('span');
    lbl.className = 'ctx-label';
    lbl.textContent = item.label;
    el.appendChild(lbl);
    if (item.hint) {
      const h = document.createElement('span');
      h.className = 'ctx-hint' + (item.hint === 'chat' ? ' chat' : '');
      h.textContent = item.hint;
      el.appendChild(h);
    }
    if (item.shortcut) {
      const sc = document.createElement('span'); sc.className = 'ctx-shortcut'; sc.textContent = item.shortcut;
      el.appendChild(sc);
    }
    if (!item.disabled && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
    ctxMenuEl.appendChild(el);
  }
  ctxMenuEl.classList.add('show');
  const rect = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = Math.max(0, Math.min(x, window.innerWidth  - rect.width  - 4)) + 'px';
  ctxMenuEl.style.top  = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}
function hideContextMenu() { ctxMenuEl.classList.remove('show'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.ctx-menu')) hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);
window.addEventListener('resize', hideContextMenu);

// ---------- pane resizer drag ----------
function setupResizerDrag(resizerEl, beforeEl, afterEl, direction) {
  let drag = null;
  resizerEl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); resizerEl.setPointerCapture(e.pointerId);
    const pr = resizerEl.parentElement.getBoundingClientRect();
    const br = beforeEl.getBoundingClientRect();
    const rs = direction === 'h' ? resizerEl.offsetWidth : resizerEl.offsetHeight;
    drag = {
      startPos: direction === 'h' ? e.clientX : e.clientY,
      startBefore: direction === 'h' ? br.width : br.height,
      available: (direction === 'h' ? pr.width : pr.height) - rs
    };
    resizerEl.classList.add('dragging');
    document.body.classList.add('resizing-pane', direction === 'h' ? 'resizing-pane-h' : 'resizing-pane-v');
  });
  resizerEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const delta = (direction === 'h' ? e.clientX : e.clientY) - drag.startPos;
    const nb = Math.max(80, Math.min(drag.available - 80, drag.startBefore + delta));
    beforeEl.style.flex = `0 0 ${nb}px`;
    afterEl.style.flex  = `0 0 ${drag.available - nb}px`;
  });
  const end = (e) => {
    if (!drag) return;
    try { resizerEl.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
    resizerEl.classList.remove('dragging');
    document.body.classList.remove('resizing-pane', 'resizing-pane-h', 'resizing-pane-v');
  };
  resizerEl.addEventListener('pointerup', end);
  resizerEl.addEventListener('pointercancel', end);
}

// ---------- Ctrl+Z undo tracking ----------
// Per-pane stack of input chunks (typed runs + pastes). Ctrl+Z (delivered via IPC
// from main process — only path that survives menu accelerators and xterm's textarea)
// pops the last chunk and sends backspaces matching its printable length. Enter/Esc/
// Ctrl+C clear the stack since the input was submitted or cancelled.
function visibleLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) n++;
  }
  return n;
}
function flushUndoCurrent(pane) {
  const u = pane.undoState;
  if (u.current) { u.stack.push(u.current); u.current = ''; }
}
function clearUndoAll(pane) {
  pane.undoState.current = '';
  pane.undoState.stack.length = 0;
}
function trackUndoInput(pane, data) {
  if (!data) return;
  const u = pane.undoState;
  if (data.length > 1) {
    flushUndoCurrent(pane);
    if (visibleLength(data) > 0) u.stack.push(data);
    return;
  }
  const c = data.charCodeAt(0);
  if (c === 0x0d || c === 0x0a || c === 0x1b || c === 0x03) { clearUndoAll(pane); return; }
  if (c === 0x7f || c === 0x08) {
    if (u.current.length > 0) u.current = u.current.slice(0, -1);
    else if (u.stack.length > 0) {
      const last = u.stack.pop();
      if (last.length > 1) u.stack.push(last.slice(0, -1));
    }
    return;
  }
  if (c === 0x09 || c === 0x17) { flushUndoCurrent(pane); return; }
  if (c >= 0x20 && c < 0x7f) { u.current += data; return; }
  flushUndoCurrent(pane);
}
function popUndoChunk(pane) {
  const u = pane.undoState;
  if (u.current.length > 0) { const t = u.current; u.current = ''; return t; }
  if (u.stack.length > 0) return u.stack.pop();
  return '';
}

// ---------- create pane (pty + xterm) ----------
async function createPaneProcess(tab, paneEl, opts = {}) {
  const paneId = newPaneId();

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 13, lineHeight: 1.0, cursorBlink: true, cursorStyle: 'bar',
    scrollback: 5000, allowProposedApi: true, theme: WINDOWS_TERMINAL_THEME
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  term.open(paneEl);
  fit.fit();

  if (opts.initialContent) {
    try { term.write(opts.initialContent); } catch (_) {}
  }

  const { id: ptyId, cwd, shell } = await window.term.create({
    cols: term.cols, rows: term.rows, cwd: opts.cwd || undefined
  });
  if (shell && statusShell) {
    statusShell.textContent = basename(shell).replace(/\.exe$/i, '');
    statusShell.title = shell;
  }

  ptyPaneMap.set(ptyId, { tabId: tab.tabId, paneId });

  const pane = {
    paneId, ptyId, term, fit, serialize, el: paneEl, ro: null,
    cwd, claudeRunning: false, claudeBusyUntil: 0, claudeSessionId: null,
    copilotRunning: false, copilotBusyUntil: 0, copilotSessionId: null,
    copilotUsage: null,
    suppressBusyUntil: 0, lastDataAt: 0, usage: null,
    runOnReady: opts.runOnReady || null,
    undoState: { current: '', stack: [] }
  };
  tab.panes.set(paneId, pane);

  // Input — extend suppressBusyUntil so PTY echo of keystrokes
  // doesn't trigger the working indicator
  term.onData(data => {
    window.term.input(ptyId, data);
    pane.suppressBusyUntil = Math.max(pane.suppressBusyUntil || 0, Date.now() + 200);
    trackUndoInput(pane, data);
  });
  term.onResize(({ cols, rows }) => window.term.resize(ptyId, cols, rows));

  // Ctrl+C: copy if selection, else send ^C to pty
  // Ctrl+V: explicit paste (works even if xterm textarea lost focus, e.g. during TUI redraws)
  // Ctrl+Backspace: delete word backward (send ^W / 0x17)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      return true;
    }
    if (e.ctrlKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      navigator.clipboard.readText().then(t => {
        if (t) term.paste(t);
        term.focus();
      }).catch(() => {});
      return false;
    }
    if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Insert') {
      e.preventDefault();
      navigator.clipboard.readText().then(t => {
        if (t) term.paste(t);
        term.focus();
      }).catch(() => {});
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Backspace') {
      e.preventDefault();
      window.term.input(ptyId, '\x17');
      flushUndoCurrent(pane);
      return false;
    }
    return true;
  });

  // Intercept native paste event in capture phase to prevent double-paste
  // (xterm textarea also fires paste; we drive paste explicitly via term.paste above)
  paneEl.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (t) term.paste(t);
    term.focus();
  }, true);

  // File path links: left-click → external editor
  const FILE_LINK_RE = /(?:[A-Za-z]:[\\/]|\.\.?[\\/])[\w\\/.\-]+(\.[\w]{1,6})\b/g;
  let hoveredFilePath = null;
  term.registerLinkProvider({
    provideLinks(lineNum, callback) {
      const line = term.buffer.active.getLine(lineNum - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      FILE_LINK_RE.lastIndex = 0;
      const links = [];
      let m;
      while ((m = FILE_LINK_RE.exec(text)) !== null) {
        const fp = m[0];
        links.push({
          range: { start: { x: m.index + 1, y: lineNum }, end: { x: m.index + fp.length, y: lineNum } },
          text: fp,
          activate(_, linkText) { window.fileApi.openExternal(linkText); },
          hover(_, linkText) { hoveredFilePath = linkText; },
          leave() { hoveredFilePath = null; }
        });
      }
      callback(links.length ? links : undefined);
    }
  });

  // Right-click: copy/paste + split + file options
  paneEl.addEventListener('contextmenu', async (e) => {
    e.preventDefault(); e.stopPropagation();
    hideContextMenu();
    setActivePane(tab, paneId);
    const fileItems = hoveredFilePath ? [
      { separator: true },
      { label: 'Open in Editor',          action: () => openInEditor(hoveredFilePath) },
      { label: 'Open in External Editor', action: () => window.fileApi.openExternal(hoveredFilePath) }
    ] : [];
    showContextMenu(e.clientX, e.clientY, [
      {
        label: 'Copy',
        disabled: !term.hasSelection(),
        action: () => { if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); } term.focus(); }
      },
      {
        label: 'Paste',
        action: async () => { try { const t = await navigator.clipboard.readText(); if (t) term.paste(t); } catch (_) {} term.focus(); }
      },
      { separator: true },
      { label: 'Split Right', action: () => splitPane(tab, paneId, 'h') },
      { label: 'Split Down',  action: () => splitPane(tab, paneId, 'v') },
      { separator: true },
      {
        label: tab.panes.size > 1 ? 'Close Pane' : 'Close Tab',
        action: () => tab.panes.size > 1 ? closePane(tab, paneId) : closeTab(tab.tabId)
      },
      ...fileItems
    ]);
  });

  // Click → focus this pane
  paneEl.addEventListener('mousedown', () => {
    if (tab.activePaneId !== paneId) setActivePane(tab, paneId);
  });

  // Pane close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close-btn';
  closeBtn.innerHTML = closeSvg();
  closeBtn.title = 'Close pane';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tab.panes.size > 1) closePane(tab, paneId);
    else closeTab(tab.tabId);
  });
  paneEl.appendChild(closeBtn);

  // OSC 6633: command line capture (claude / copilot detection)
  term.parser.registerOscHandler(6633, (data) => {
    if (typeof data !== 'string') return false;
    const parts = data.trim().split(/\s+/);
    const first = parts[0]?.toLowerCase();
    const second = parts[1]?.toLowerCase();
    if (first === 'claude' || first === 'claude.exe' || first === 'claude.cmd') {
      pane.claudeRunning = true;
      pane.claudeBusyUntil = Date.now() + 600;
      scheduleAgentRender();
    } else if (
      first === 'copilot' || first === 'copilot.exe' || first === 'copilot.cmd' ||
      ((first === 'gh' || first === 'gh.exe') && second === 'copilot')
    ) {
      pane.copilotRunning = true;
      pane.copilotBusyUntil = Date.now() + 600;
      scheduleAgentRender();
    }
    return false;
  });

  // OSC 9;9: cwd from prompt wrapper
  term.parser.registerOscHandler(9, (data) => {
    if (typeof data !== 'string' || !data.startsWith('9;')) return false;
    const cwd = data.substring(2).trim().replace(/^"+|"+$/g, '');
    if (!cwd) return false;
    if (pane.cwd !== cwd) {
      pane.cwd = cwd;
      scheduleSaveSession();
      if (tab.type === 'chat') {
        // The drawer can wander with `cd` without moving the chat's own folder.
        const view = chatTabs.get(tab.tabId);
        if (view) view.setTerminalCwd(cwd);
      } else if (tab.activePaneId === paneId) {
        if (!tab.customTitle) setTabTitle(tab, basename(cwd) || 'PowerShell');
        if (tab.tabId === activeId) { renderTree(); updateStatus(); }
      }
    }
    if (pane.claudeRunning) { pane.claudeRunning = false; scheduleAgentRender(); }
    if (pane.copilotRunning) { pane.copilotRunning = false; scheduleAgentRender(); }
    if (pane.runOnReady) {
      const cmd = pane.runOnReady; pane.runOnReady = null;
      markAgentRunningFromCmd(pane, cmd);
      setTimeout(() => window.term.input(ptyId, cmd + '\r'), 30);
    }
    return false;
  });

  // Resize observer per pane
  let roTimer = null;
  pane.ro = new ResizeObserver(() => {
    clearTimeout(roTimer);
    roTimer = setTimeout(() => fitPane(pane), 16);
  });
  pane.ro.observe(paneEl);

  // Fallback runOnReady
  if (pane.runOnReady) {
    setTimeout(() => {
      if (pane.runOnReady) {
        const cmd = pane.runOnReady; pane.runOnReady = null;
        markAgentRunningFromCmd(pane, cmd);
        window.term.input(ptyId, cmd + '\r');
      }
    }, 1500);
  }

  return pane;
}

// ---------- split pane ----------
async function splitPane(tab, paneId, direction) {
  const pane = tab.panes.get(paneId);
  if (!pane) return;

  const splitEl = document.createElement('div');
  splitEl.className = direction === 'h' ? 'split-h' : 'split-v';
  pane.el.replaceWith(splitEl);

  pane.el.style.flex = '1 1 50%';
  splitEl.appendChild(pane.el);

  const resizerEl = document.createElement('div');
  resizerEl.className = 'pane-resizer ' + (direction === 'h' ? 'resizer-h' : 'resizer-v');
  splitEl.appendChild(resizerEl);

  const newPaneEl = document.createElement('div');
  newPaneEl.className = 'pane-container';
  newPaneEl.style.flex = '1 1 50%';
  splitEl.appendChild(newPaneEl);

  setupResizerDrag(resizerEl, pane.el, newPaneEl, direction);

  const newPane = await createPaneProcess(tab, newPaneEl, { cwd: pane.cwd });
  setActivePane(tab, newPane.paneId);
}

// ---------- close pane ----------
function closePane(tab, paneId) {
  const pane = tab.panes.get(paneId);
  if (!pane) return;

  if (pane.ro) { try { pane.ro.disconnect(); } catch (_) {} }
  window.term.kill(pane.ptyId);
  ptyPaneMap.delete(pane.ptyId);
  pane.term.dispose();
  paneWorkingState.delete(paneId + ':claude');
  paneWorkingState.delete(paneId + ':copilot');
  tab.panes.delete(paneId);

  // Collapse split: sibling expands to fill
  const el = pane.el;
  const splitParent = el.parentElement;
  if (splitParent && (splitParent.classList.contains('split-h') || splitParent.classList.contains('split-v'))) {
    const sibling = Array.from(splitParent.children).find(c => c !== el && !c.classList.contains('pane-resizer'));
    if (sibling) {
      sibling.style.flex = splitParent.style.flex || '1';
      splitParent.replaceWith(sibling);
    }
  } else {
    el.remove();
  }

  if (tab.panes.size === 0) { closeTab(tab.tabId); return; }

  if (tab.activePaneId === paneId) {
    tab.activePaneId = null;
    setActivePane(tab, tab.panes.keys().next().value);
  }
  // Refit all remaining panes — xterm cols/rows must match new container size
  requestAnimationFrame(() => { for (const [, p] of tab.panes) fitPane(p); });
  scheduleAgentRender();
}

// ---------- create tab ----------
async function createTab(opts = {}) {
  const tabId = newTabId();

  const container = document.createElement('div');
  container.className = 'term-container';
  areaEl.appendChild(container);

  const paneEl = document.createElement('div');
  paneEl.className = 'pane-container pane-active';
  container.appendChild(paneEl);

  const initialName = basename(opts.cwd || '') || 'PowerShell';
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = tabInnerHtml('terminal', initialName);
  tabsEl.appendChild(tabEl);
  const titleEl = tabEl.querySelector('.tab-title');
  const closeEl = tabEl.querySelector('.tab-close');

  const tab = {
    tabId, container, tabEl, titleEl,
    title: 'PowerShell', customTitle: null, color: null,
    panes: new Map(), activePaneId: null,
    expandedPaths: new Set(), selectedPath: null
  };
  tabs.set(tabId, tab);
  const autoColor = pickRandomUnusedColor();
  if (autoColor) setTabColor(tab, autoColor);

  wireTabPointer(tabEl, tabId);
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId); });
  titleEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tab); });
  tabEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tab-rename-input')) return;
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', shortcut: 'F2', action: () => startRename(tab) },
      { separator: true },
      { swatches: availableColorsForTab(tab), selected: tab.color || null, onPick: (c) => setTabColor(tab, c.value) },
      { separator: true },
      { label: 'Close tab', action: () => closeTab(tabId) }
    ]);
  });

  const firstPane = await createPaneProcess(tab, paneEl, { cwd: opts.cwd, runOnReady: opts.runOnReady, initialContent: opts.initialContent });
  tab.activePaneId = firstPane.paneId;

  setActive(tabId);
  updateStatus();
  return tab;
}

// ---------- open in editor ----------
function openInEditor(filePath) {
  for (const [id, tab] of tabs) {
    if (tab.type === 'editor' && tab.filePath === filePath) { setActive(id); return; }
  }
  createEditorTab(filePath);
}

async function createEditorTab(filePath) {
  const tabId = newTabId();
  const container = document.createElement('div');
  container.className = 'term-container';
  areaEl.appendChild(container);

  const name = basename(filePath);
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = tabInnerHtml('editor', name);
  tabsEl.appendChild(tabEl);
  const titleEl = tabEl.querySelector('.tab-title');
  const closeEl  = tabEl.querySelector('.tab-close');

  const tab = {
    tabId, container, tabEl, titleEl,
    title: name, customTitle: null, color: null,
    panes: new Map(), activePaneId: null,
    expandedPaths: new Set(), selectedPath: null,
    type: 'editor', filePath, editor: null, dirty: false
  };
  tabs.set(tabId, tab);
  const autoColor = pickRandomUnusedColor();
  if (autoColor) setTabColor(tab, autoColor);

  wireTabPointer(tabEl, tabId);
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId); });
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [{ label: 'Close Tab', action: () => closeTab(tabId) }]);
  });

  const editorEl = document.createElement('div');
  editorEl.className = 'editor-pane';
  container.appendChild(editorEl);
  setActive(tabId);
  updateStatus();

  const result = await window.fileApi.read(filePath);
  if (result.error) {
    editorEl.innerHTML = `<div class="editor-error">Cannot open: ${escapeHtml(result.error)}</div>`;
    return tab;
  }

  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const LANG = {
    js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript',
    ts:'typescript', tsx:'typescript',
    json:'json', md:'markdown', html:'html', css:'css', scss:'scss',
    py:'python', rs:'rust', go:'go', java:'java', cs:'csharp',
    cpp:'cpp', c:'c', h:'c', sh:'shell', ps1:'powershell', bat:'bat', cmd:'bat',
    yml:'yaml', yaml:'yaml', toml:'ini', xml:'xml', sql:'sql'
  };
  const language = LANG[ext] || 'plaintext';

  editorEl.innerHTML = '<div style="padding:16px;color:#666;font-family:Segoe UI,sans-serif;font-size:12px">Loading editor…</div>';
  window._monacoReady.then(() => {
    if (!tabs.has(tabId)) return;
    editorEl.innerHTML = '';
    tab.editor = monaco.editor.create(editorEl, {
      value: result.content, language,
      theme: 'vs-dark', fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      minimap: { enabled: false }, scrollBeyondLastLine: false,
      automaticLayout: true, tabSize: 2,
      renderWhitespace: 'selection', wordWrap: 'off',
      lineNumbers: 'on', glyphMargin: false, folding: true,
      lineDecorationsWidth: 4, renderLineHighlight: 'all'
    });
    tab.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      const res = await window.fileApi.write(filePath, tab.editor.getValue());
      if (res.ok) setTabDirty(tab, false);
    });
    tab.editor.onDidChangeModelContent(() => {
      if (!tab.dirty) setTabDirty(tab, true);
    });
    requestAnimationFrame(() => {
      try {
        const { width, height } = editorEl.getBoundingClientRect();
        tab.editor.layout({ width: width || editorEl.offsetWidth, height: height || editorEl.offsetHeight });
        if (activeId === tabId) tab.editor.focus();
      } catch (_) {}
    });
  }).catch(err => {
    editorEl.innerHTML = `<div class="editor-error">Monaco failed to load: ${escapeHtml(String(err))}</div>`;
  });
  return tab;
}

// ---------- create Claude chat tab ----------
let chatSeq = 0;

// Which permission mode a new chat pane starts in. Seeded from the CLI's own
// permissions.defaultMode so the app agrees with `claude` out of the box, and
// overridable from the pane's permission menu.
const PERM_DEFAULT_KEY = 'chatPermissionDefault';
const PERM_MODE_IDS = new Set(['default', 'auto', 'acceptEdits', 'bypassPermissions']);
let cliPermissionDefault = 'default';

window.claudeApi.defaultPermissionMode()
  .then((r) => { if (r && PERM_MODE_IDS.has(r.mode)) cliPermissionDefault = r.mode; })
  .catch(() => {});

function defaultPermissionMode() {
  const stored = localStorage.getItem(PERM_DEFAULT_KEY);
  return PERM_MODE_IDS.has(stored) ? stored : cliPermissionDefault;
}
function setDefaultPermissionMode(mode) {
  if (!PERM_MODE_IDS.has(mode)) return;
  localStorage.setItem(PERM_DEFAULT_KEY, mode);
}

async function createChatTab(opts = {}) {
  const tabId = newTabId();
  const chatId = 'chat-' + (++chatSeq);
  const cwd = opts.cwd || (activeId && tabCwd(tabs.get(activeId))) || undefined;

  const container = document.createElement('div');
  container.className = 'term-container';
  areaEl.appendChild(container);

  const name = basename(cwd || '') || 'claude';
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = tabInnerHtml('chat', name);
  tabsEl.appendChild(tabEl);
  const titleEl = tabEl.querySelector('.tab-title');
  const closeEl = tabEl.querySelector('.tab-close');

  const tab = {
    tabId, container, tabEl, titleEl,
    title: name, customTitle: null, color: null,
    panes: new Map(), activePaneId: null,
    expandedPaths: new Set(), selectedPath: null,
    type: 'chat', chatId, cwd: cwd || null
  };
  tabs.set(tabId, tab);
  setTabColor(tab, opts.color || '#4ec994');

  wireTabPointer(tabEl, tabId);
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId); });
  titleEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tab); });
  tabEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tab-rename-input')) return;
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', shortcut: 'F2', action: () => startRename(tab) },
      { separator: true },
      { swatches: availableColorsForTab(tab), selected: tab.color || null, onPick: (c) => setTabColor(tab, c.value) },
      { separator: true },
      { label: 'Close tab', action: () => closeTab(tabId) }
    ]);
  });

  const permissionMode = PERM_MODE_IDS.has(opts.permissionMode)
    ? opts.permissionMode
    : defaultPermissionMode();

  const view = window.createChatView({
    chatId,
    cwd: cwd || '',
    name,
    getHomeDir: () => homeDir,
    model: opts.model || 'opus',
    permissionMode,
    helpers: { formatTokens, contextWindowFor, shortModelLabel },
    showMenu: (x, y, items) => showContextMenu(x, y, items),
    commands: chatPaletteCommands(tab),
    getDefaultPermissionMode: defaultPermissionMode,
    onDefaultPermissionMode: setDefaultPermissionMode,
    onTerminalOpen: (mount) => openChatTerminal(tab, mount),
    onTerminalRestart: (mount) => { closeChatTerminal(tab); openChatTerminal(tab, mount); },
    onTerminalFit: () => { const p = tab.termPane; if (p) requestAnimationFrame(() => fitPane(p)); },
    onTerminalFocus: () => { const p = tab.termPane; if (p) p.term.focus(); },
    onTerminalInput: (data) => { const p = tab.termPane; if (p) window.term.input(p.ptyId, data); },
    onStateChange: () => { scheduleAgentRender(); updateStatusAgents(); },
    onSessionId: (id) => { tab.chatSessionId = id; scheduleSaveSession(); },
    onModelChange: (model) => restartChat(tab, model),
    onRestart: () => restartChat(tab, view.model)
  });
  chatTabs.set(tabId, view);
  container.appendChild(view.el);
  view.setActive(true);

  setActive(tabId);
  updateStatus();

  const res = await window.chatApi.start({
    chatId, cwd,
    model: opts.model || 'opus',
    permissionMode,
    resumeSessionId: opts.resumeSessionId || null
  });
  if (res && res.error) view.handleStderr('Could not start Claude: ' + res.error);
  else if (res && res.cwd) { tab.cwd = res.cwd; updateStatus(); renderTree(); }

  scheduleAgentRender();
  scheduleSaveSession();
  return tab;
}

// ---------- terminal drawer inside a chat pane ----------
// The drawer's shell is a normal pane, registered in tab.panes so pty routing, cwd
// tracking and agent detection all work unchanged. tab.activePaneId stays null so the
// chat surface, not the shell, is what the tab focuses.
async function openChatTerminal(tab, mount) {
  if (tab.termPane) return tab.termPane;
  mount.innerHTML = '';
  const pane = await createPaneProcess(tab, mount, { cwd: tab.cwd || undefined });
  tab.termPane = pane;
  requestAnimationFrame(() => { fitPane(pane); pane.term.focus(); });
  scheduleAgentRender();
  return pane;
}

function closeChatTerminal(tab) {
  const pane = tab.termPane;
  if (!pane) return;
  tab.termPane = null;
  if (pane.ro) { try { pane.ro.disconnect(); } catch (_) {} }
  window.term.kill(pane.ptyId);
  ptyPaneMap.delete(pane.ptyId);
  tab.panes.delete(pane.paneId);
  try { pane.term.dispose(); } catch (_) {}
  scheduleAgentRender();
}

// Commands offered by the composer's `/` palette that act on the app rather than
// being sent to Claude. Shortcuts match the global bindings.
function chatPaletteCommands(tab) {
  return [
    {
      cmd: '/split-right', desc: 'Split the active pane to the right', key: 'Ctrl+Shift+R',
      run: () => { const t = tabs.get(activeId); if (t && t.panes.size) splitPane(t, t.activePaneId, 'h'); }
    },
    {
      cmd: '/split-down', desc: 'Split the active pane downward', key: 'Ctrl+Shift+D',
      run: () => { const t = tabs.get(activeId); if (t && t.panes.size) splitPane(t, t.activePaneId, 'v'); }
    },
    {
      cmd: '/handoff', desc: 'Write a handoff brief and open Copilot here', key: '↗',
      run: () => { if (tab.cwd) handoffClaudeToCopilot(tab.cwd); }
    },
    {
      cmd: '/save', desc: 'Save this session to the library', key: '＋',
      run: () => saveChatSession(tab)
    },
    {
      cmd: '/rename', desc: 'Rename this tab', key: 'F2',
      run: () => startRename(tab)
    },
    {
      cmd: '/shell-tab', desc: 'Open a full shell tab in this folder', key: '',
      run: () => { if (tab.cwd) createTab({ cwd: tab.cwd }); }
    }
  ];
}

// Model changes are launch flags, so switching means relaunching with --resume so
// the conversation carries over.
async function restartChat(tab, model) {
  const view = chatTabs.get(tab.tabId);
  if (!view) return;
  const resumeSessionId = view.sessionId || tab.chatSessionId || null;
  window.chatApi.stop(tab.chatId);
  const res = await window.chatApi.start({
    chatId: tab.chatId, cwd: tab.cwd || undefined,
    model: model || 'opus', resumeSessionId,
    // Carry the pane's mode across, or the gate would silently drop back to asking
    // while the pill still showed the old mode.
    permissionMode: view.getState().permissionMode
  });
  if (res && res.error) view.handleStderr('Could not restart Claude: ' + res.error);
}

function saveChatSession(tab) {
  const view = chatTabs.get(tab.tabId);
  const sid = view?.sessionId || tab.chatSessionId;
  if (!sid || !tab.cwd) return;
  if (claudeSessionLibrary.some((s) => s.id === sid)) return;
  const defaultName = (tab.customTitle || tabAutoName(tab)) + ' · ' + new Date().toISOString().slice(0, 10);
  claudeSessionLibrary.push({ id: sid, cwd: tab.cwd, name: defaultName, savedAt: Date.now(), kind: 'chat' });
  renderClaudeSessions();
  scheduleSaveSession();
}

// ---------- close tab ----------
function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const wasActive = activeId === tabId;
  const histIdx = tabHistory.indexOf(tabId);
  if (histIdx !== -1) tabHistory.splice(histIdx, 1);
  if (tab.type === 'chat') {
    const view = chatTabs.get(tabId);
    if (view) view.dispose();
    chatTabs.delete(tabId);
    closeChatTerminal(tab);
    window.chatApi.stop(tab.chatId);
    tab.container.remove(); tab.tabEl.remove(); tabs.delete(tabId);
    if (wasActive) { activeId = null; const n = pickNextActive(); if (n) setActive(n); else window.win.close(); }
    updateStatus(); scheduleAgentRender(); scheduleSaveSession(); return;
  }
  if (tab.type === 'editor') {
    try { tab.editor?.dispose(); } catch (_) {}
    tab.container.remove(); tab.tabEl.remove(); tabs.delete(tabId);
    if (wasActive) { activeId = null; const n = pickNextActive(); if (n) setActive(n); else window.win.close(); }
    updateStatus(); scheduleAgentRender(); scheduleSaveSession(); return;
  }
  for (const [, pane] of tab.panes) {
    if (pane.ro) { try { pane.ro.disconnect(); } catch (_) {} }
    window.term.kill(pane.ptyId);
    ptyPaneMap.delete(pane.ptyId);
    pane.term.dispose();
  }
  tab.container.remove();
  tab.tabEl.remove();
  tabs.delete(tabId);
  if (wasActive) {
    activeId = null;
    const next = pickNextActive();
    if (next) setActive(next);
    else window.win.close();
  }
  updateStatus();
  scheduleAgentRender();
  scheduleSaveSession();
}

function pickNextActive() {
  for (const id of tabHistory) if (tabs.has(id)) return id;
  return tabs.keys().next().value;
}

// ---------- stream pty data ----------
window.term.onData((ptyId, data) => {
  const ref = ptyPaneMap.get(ptyId);
  if (!ref) return;
  const pane = tabs.get(ref.tabId)?.panes.get(ref.paneId);
  if (!pane) return;
  pane.term.write(data);
  pane.lastDataAt = Date.now();
  if (pane.lastDataAt > (pane.suppressBusyUntil || 0)) {
    if (pane.claudeRunning) {
      pane.claudeBusyUntil = pane.lastDataAt + 500;
      scheduleAgentRender();
    }
    if (pane.copilotRunning) {
      pane.copilotBusyUntil = pane.lastDataAt + 500;
      scheduleAgentRender();
    }
  }
});
window.term.onExit((ptyId) => {
  const ref = ptyPaneMap.get(ptyId);
  if (!ref) return;
  const tab = tabs.get(ref.tabId);
  if (!tab) return;
  // A chat pane's drawer shell exiting must not take the chat tab with it.
  if (tab.type === 'chat') {
    closeChatTerminal(tab);
    const view = chatTabs.get(tab.tabId);
    if (view) view.terminalEnded();
    return;
  }
  if (tab.panes.size > 1) closePane(tab, ref.paneId);
  else closeTab(tab.tabId);
});

// ---------- tab rename + color ----------
const TAB_COLORS = [
  { name: 'None',   value: null },     { name: 'Red',    value: '#f44747' },
  { name: 'Orange', value: '#d7ba7d' },{ name: 'Yellow', value: '#f9f1a5' },
  { name: 'Green',  value: '#4ec994' },{ name: 'Cyan',   value: '#61d6d6' },
  { name: 'Blue',   value: '#3b78ff' },{ name: 'Purple', value: '#c586c0' },
  { name: 'Pink',   value: '#ff8fb3' }
];
function setTabColor(tab, value) {
  tab.color = value;
  if (value) { tab.tabEl.style.setProperty('--tab-color', value); tab.tabEl.dataset.colored = '1'; }
  else { tab.tabEl.style.removeProperty('--tab-color'); delete tab.tabEl.dataset.colored; }
  scheduleSaveSession();
}
function colorsInUse(exceptTab = null) {
  const used = new Set();
  for (const [, t] of tabs) { if (t !== exceptTab && t.color) used.add(t.color); }
  return used;
}
function pickRandomUnusedColor() {
  const used = colorsInUse();
  const free = TAB_COLORS.filter(c => c.value !== null && !used.has(c.value));
  return free.length ? free[Math.floor(Math.random() * free.length)].value : null;
}
function availableColorsForTab(tab) {
  const used = colorsInUse(tab);
  return TAB_COLORS.filter(c => c.value === null || !used.has(c.value));
}
function startRename(tab) {
  const current = tab.customTitle || tabAutoName(tab) || '';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'tab-rename-input'; input.value = current;
  tab.titleEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const span = document.createElement('span'); span.className = 'tab-title';
    const name = input.value.trim();
    input.replaceWith(span); tab.titleEl = span;
    if (commit && name) { tab.customTitle = name; setTabTitle(tab, name); }
    else { tab.customTitle = null; setTabTitle(tab, tabAutoName(tab)); }
    setTabDirty(tab, tab.dirty);
    span.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tab); });
    const view = chatTabs.get(tab.tabId);
    if (view) view.setName(tab.customTitle || tabAutoName(tab));
    scheduleSaveSession();
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

// ---------- Explorer tree ----------
function cdToPath(targetPath) {
  if (!activeId) return;
  const pane = getActivePane(tabs.get(activeId));
  // A chat tab has no shell to cd; give it one at the target instead.
  if (!pane) { createTab({ cwd: targetPath }); return; }
  window.term.input(pane.ptyId, `cd '${String(targetPath).replace(/'/g, "''")}'; Clear-Host\r`);
  pane.term.focus();
}
function folderContextItems(fp) {
  return [
    { label: 'Go here in shell',        hint: 'terminal', action: () => cdToPath(fp) },
    { label: 'Go here in a new shell',  hint: 'terminal', action: () => createTab({ cwd: fp }) },
    { separator: true },
    { badge: 'C',  label: 'Open Claude here',  hint: 'chat', action: () => createChatTab({ cwd: fp }) },
    { badge: 'GH', label: 'Open Copilot here', hint: 'chat', action: () => createTab({ cwd: fp, runOnReady: 'gh copilot' }) },
    { badge: 'C',  label: 'Open Claude in terminal', hint: 'terminal', action: () => createTab({ cwd: fp, runOnReady: 'claude' }) },
    { separator: true },
    { label: 'Open in Explorer', action: () => window.fileApi.openExternal(fp) }
  ];
}

// A file's menu can hand the file (or the editor's selected range) to the active
// chat pane as a composer attachment.
function fileContextItems(fp, name) {
  const items = [
    { label: 'Open in Editor',          action: () => openInEditor(fp) },
    { label: 'Open in External Editor', action: () => window.fileApi.openExternal(fp) }
  ];
  const view = activeChatView();
  if (view) {
    items.push({ separator: true });
    items.push({
      badge: 'C', label: 'Attach to Claude chat', hint: 'chat',
      action: () => view.addRangeAttachment(name, `Look at the file ${fp}`)
    });
  }
  return items;
}

function activeChatView() {
  if (!activeId) return null;
  return chatTabs.get(activeId) || null;
}
// Rows are indented with a --wt-indent custom property so the CSS indent guide can
// be drawn at the right x without a wrapper element per level.
const TREE_INDENT = 14;
function indentRow(row, depth) {
  const px = depth * TREE_INDENT + 8;
  row.dataset.depth = String(depth);
  row.style.setProperty('--wt-indent', px + 'px');
  row.style.paddingLeft = px + 'px';
}

function isIgnoredName(name) {
  return name === 'node_modules' || name === 'dist' || name === '.git' || name.startsWith('.git');
}

async function renderTree() {
  treeEl.innerHTML = '';
  if (!activeId || !tabs.has(activeId)) {
    treeRootEl.style.display = 'none';
    treeEl.innerHTML = '<div class="wt-empty">No active tab</div>';
    return;
  }
  const tab = tabs.get(activeId);
  const root = tab.type === 'editor' ? null : tabCwd(tab);
  if (!root) {
    treeRootEl.style.display = 'none';
    treeEl.innerHTML = '<div class="wt-empty">Loading…</div>';
    return;
  }

  treeRootEl.style.display = 'flex';
  treeRootNameEl.textContent = (basename(root) || root).toUpperCase();
  treeRootNameEl.title = root;
  treeRootCountEl.textContent = '';
  treeRootEl.onclick = () => cdToPath(root);
  treeRootEl.oncontextmenu = (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, folderContextItems(root));
  };

  const rootChildren = document.createElement('div');
  rootChildren.dataset.childrenOf = root;
  rootChildren.style.display = 'contents';
  treeEl.appendChild(rootChildren);
  tab.expandedPaths.add(root);
  const count = await populateChildren(tab, rootChildren, root, 0);
  treeRootCountEl.textContent = count == null ? '' : String(count);

  const ordered = Array.from(tab.expandedPaths).filter(p => p !== root).sort((a, b) => a.length - b.length);
  for (const ep of ordered) {
    const slot = treeEl.querySelector(`[data-children-of="${CSS.escape(ep)}"]`);
    const row  = treeEl.querySelector(`[data-path="${CSS.escape(ep)}"]`);
    if (slot && row && slot.dataset.populated !== '1') {
      row.classList.add('open'); slot.style.display = 'contents';
      await populateChildren(tab, slot, ep, parseInt(row.dataset.depth || '0', 10) + 1);
    }
  }
}

async function populateChildren(tab, slotEl, dirPath, depth) {
  if (slotEl.dataset.populated === '1') return null;
  const loading = document.createElement('div');
  loading.className = 'wt-empty';
  loading.textContent = 'Loading…';
  slotEl.appendChild(loading);
  const result = await window.fs.list(dirPath);
  slotEl.innerHTML = ''; slotEl.dataset.populated = '1';
  if (result.error) {
    const e = document.createElement('div'); e.className = 'wt-error';
    e.textContent = result.error;
    slotEl.appendChild(e); return null;
  }
  if (!result.entries?.length) {
    const e = document.createElement('div'); e.className = 'wt-empty';
    e.textContent = '(empty)';
    slotEl.appendChild(e); return 0;
  }
  for (const entry of result.entries) {
    const row = document.createElement('div');
    row.className = 'wt-item' + (isIgnoredName(entry.name) ? ' ignored' : '');
    row.dataset.path = entry.path;
    indentRow(row, depth);
    if (tab.selectedPath === entry.path) row.classList.add('sel');
    if (entry.isDirectory) {
      row.innerHTML = `<span class="wt-arrow">▶</span><span class="wt-icon">📁</span><span class="wt-name">${escapeHtml(entry.name)}</span>`;
      const childSlot = document.createElement('div');
      childSlot.dataset.childrenOf = entry.path;
      childSlot.style.display = 'none';
      row.addEventListener('click', async (e) => {
        e.stopPropagation(); selectRow(tab, row, entry.path);
        const open = row.classList.toggle('open');
        if (open) {
          tab.expandedPaths.add(entry.path); childSlot.style.display = 'contents';
          if (childSlot.dataset.populated !== '1') await populateChildren(tab, childSlot, entry.path, depth + 1);
        } else { tab.expandedPaths.delete(entry.path); childSlot.style.display = 'none'; }
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation(); selectRow(tab, row, entry.path);
        showContextMenu(e.clientX, e.clientY, folderContextItems(entry.path));
      });
      slotEl.appendChild(row); slotEl.appendChild(childSlot);
    } else {
      row.innerHTML = `<span class="wt-arrow" style="visibility:hidden">▶</span><span class="wt-icon">${fileIcon(entry.name,false)}</span><span class="wt-name">${escapeHtml(entry.name)}</span>`;
      row.addEventListener('click', (e) => { e.stopPropagation(); selectRow(tab, row, entry.path); });
      row.addEventListener('dblclick', (e) => { e.stopPropagation(); openInEditor(entry.path); });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation(); selectRow(tab, row, entry.path);
        showContextMenu(e.clientX, e.clientY, fileContextItems(entry.path, entry.name));
      });
      slotEl.appendChild(row);
    }
  }
  return result.entries.length;
}
function selectRow(tab, rowEl, p) {
  tab.selectedPath = p;
  treeEl.querySelectorAll('.wt-item.sel').forEach(e => e.classList.remove('sel'));
  rowEl.classList.add('sel');
}

// ---------- sidebar controls ----------
document.getElementById('sb-collapse').addEventListener('click', () => sidebarEl.classList.add('collapsed'));
sidebarHandleEl.addEventListener('click', () => sidebarEl.classList.remove('collapsed'));

// Agents panel collapse (persisted alongside the Explorer's)
const AGENTS_COLLAPSED_KEY = 'agentsPanelCollapsed';
if (localStorage.getItem(AGENTS_COLLAPSED_KEY) === '1') {
  agentsPanelEl.classList.add('no-transition', 'collapsed');
  requestAnimationFrame(() => agentsPanelEl.classList.remove('no-transition'));
}
function setAgentsCollapsed(collapsed) {
  agentsPanelEl.classList.toggle('collapsed', collapsed);
  localStorage.setItem(AGENTS_COLLAPSED_KEY, collapsed ? '1' : '0');
  requestAnimationFrame(fitAll);
}
document.getElementById('agents-collapse').addEventListener('click', () => setAgentsCollapsed(true));
agentsHandleEl.addEventListener('click', () => setAgentsCollapsed(false));
document.getElementById('agents-new').addEventListener('click', () => {
  const cwd = activeId ? tabCwd(tabs.get(activeId)) : null;
  createChatTab({ cwd: cwd || undefined });
});

// Saved Sessions collapse toggle (persisted)
const SAVED_COLLAPSED_KEY = 'savedSessionsCollapsed';
const savedSectionEl = document.getElementById('saved-section');
const savedToggleEl = document.getElementById('saved-toggle');
if (localStorage.getItem(SAVED_COLLAPSED_KEY) === '1') savedSectionEl.classList.add('saved-collapsed');
savedToggleEl.addEventListener('click', (e) => {
  if (e.target.closest('#saved-clear-old')) return;
  const collapsed = savedSectionEl.classList.toggle('saved-collapsed');
  localStorage.setItem(SAVED_COLLAPSED_KEY, collapsed ? '1' : '0');
});
const clearOldBtn = document.getElementById('saved-clear-old');
let clearOldBusy = false;
clearOldBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (clearOldBusy) return;
  clearOldBusy = true;
  const label = clearOldBtn.querySelector('.saved-clear-label');
  const original = label.textContent;
  label.textContent = 'Clearing…';
  try {
    const { removed, unknown } = await clearOldSavedSessions();
    label.textContent = removed
      ? `Removed ${removed}`
      : (unknown ? `Kept ${unknown} (no date)` : 'Nothing old');
  } catch (err) {
    label.textContent = 'Failed';
  }
  setTimeout(() => { label.textContent = original; clearOldBusy = false; }, 2200);
});
clearOldBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault(); e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, [
    { label: 'Clear older than 1 day',    action: () => runClearOld(1) },
    { label: 'Clear older than 1 week',   action: () => runClearOld(7) },
    { label: 'Clear older than 1 month',  action: () => runClearOld(30) },
    { separator: true },
    { label: 'Remove all saved sessions', action: () => {
      claudeSessionLibrary.length = 0;
      copilotSessionLibrary.length = 0;
      renderClaudeSessions();
      scheduleSaveSession();
    }}
  ]);
});
async function runClearOld(days) {
  const label = clearOldBtn.querySelector('.saved-clear-label');
  const original = label.textContent;
  const { removed } = await clearOldSavedSessions(days);
  label.textContent = removed ? `Removed ${removed}` : 'Nothing old';
  setTimeout(() => { label.textContent = original; }, 2200);
}

document.getElementById('sb-refresh').addEventListener('click', () => { if (activeId) renderTree(); });
document.getElementById('sb-up').addEventListener('click', async () => {
  if (!activeId) return;
  const tab = tabs.get(activeId);
  const cwd = tabCwd(tab);
  if (!cwd) return;
  const parent = await window.fs.parent(cwd);
  if (!parent) return;
  // Walking up only changes what the Explorer shows; the shell stays where it is.
  const pane = getActivePane(tab);
  if (pane) pane.cwd = parent;
  else if (tab.type === 'chat') tab.cwd = parent;
  tab.expandedPaths.clear(); tab.selectedPath = null;
  renderTree(); updateStatus();
});

// ---------- sidebar resize ----------
const SIDEBAR_MIN = 160, SIDEBAR_KEY = 'sidebarWidth';
const savedW = parseInt(localStorage.getItem(SIDEBAR_KEY) || '', 10);
if (Number.isFinite(savedW) && savedW >= SIDEBAR_MIN) sidebarEl.style.width = savedW + 'px';
const resizeEl = document.getElementById('sidebar-resize');
let sbDrag = null;
resizeEl.addEventListener('pointerdown', (e) => {
  if (sidebarEl.classList.contains('collapsed')) return;
  e.preventDefault(); resizeEl.setPointerCapture(e.pointerId);
  sbDrag = { startX: e.clientX, startW: sidebarEl.getBoundingClientRect().width };
  sidebarEl.classList.add('no-transition'); resizeEl.classList.add('dragging');
  document.body.classList.add('resizing-sidebar');
});
resizeEl.addEventListener('pointermove', (e) => {
  if (!sbDrag) return;
  const max = Math.max(SIDEBAR_MIN, Math.floor(window.innerWidth * 0.6));
  sidebarEl.style.width = Math.min(max, Math.max(SIDEBAR_MIN, sbDrag.startW + (e.clientX - sbDrag.startX))) + 'px';
});
const endSbDrag = (e) => {
  if (!sbDrag) return;
  try { resizeEl.releasePointerCapture(e.pointerId); } catch (_) {}
  sbDrag = null;
  sidebarEl.classList.remove('no-transition'); resizeEl.classList.remove('dragging');
  document.body.classList.remove('resizing-sidebar');
  const w = Math.round(sidebarEl.getBoundingClientRect().width);
  if (w >= SIDEBAR_MIN) localStorage.setItem(SIDEBAR_KEY, String(w));
};
resizeEl.addEventListener('pointerup', endSbDrag);
resizeEl.addEventListener('pointercancel', endSbDrag);
resizeEl.addEventListener('dblclick', () => { sidebarEl.style.width = '240px'; localStorage.setItem(SIDEBAR_KEY, '240'); });

// ---------- Claude Agent panel ----------
let agentRenderQueued = false;
function scheduleAgentRender() {
  if (agentRenderQueued) return; agentRenderQueued = true;
  requestAnimationFrame(() => { agentRenderQueued = false; renderAgentPanel(); });
}
function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'k';
  return String(n);
}
function contextWindowFor(model) {
  if (!model) return 200000;
  const m = model.toLowerCase();
  return (m.includes('1m') || m.includes('[1m]')) ? 1000000 : 200000;
}
function shortModelLabel(model) {
  if (!model) return '';
  if (/^(opus|sonnet|haiku|default)/i.test(model))
    return model.replace(/\s*\((?:1M|200k)\s*context\)/i, '').trim();
  const m = model.toLowerCase();
  const x = m.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (x) return x[1].charAt(0).toUpperCase()+x[1].slice(1)+` ${x[2]}.${x[3]}`;
  return model;
}

function markAgentRunningFromCmd(pane, cmd) {
  if (!cmd) return;
  const lo = cmd.trim().toLowerCase();
  if (lo === 'claude' || lo.startsWith('claude ') || lo.startsWith('claude.')) {
    pane.claudeRunning = true;
    pane.claudeBusyUntil = Date.now() + 600;
    scheduleAgentRender();
  } else if (lo === 'copilot' || lo.startsWith('copilot ') || lo.startsWith('copilot.') ||
             lo === 'gh copilot' || lo.startsWith('gh copilot ') || lo.startsWith('gh.exe copilot')) {
    pane.copilotRunning = true;
    pane.copilotBusyUntil = Date.now() + 600;
    scheduleAgentRender();
  }
}

function getAllAgentPanes() {
  const result = [];
  for (const [, tab] of tabs)
    for (const [, pane] of tab.panes) {
      if (pane.claudeRunning) result.push({ tab, pane, type: 'claude' });
      if (pane.copilotRunning) result.push({ tab, pane, type: 'copilot' });
    }
  return result;
}
function getAllClaudePanes() {
  return getAllAgentPanes().filter(x => x.type === 'claude');
}
function getAllCopilotPanes() {
  return getAllAgentPanes().filter(x => x.type === 'copilot');
}

function shortCopilotModelLabel(model) {
  if (!model) return '';
  // Copilot keys look like "gpt-5.4", "gpt-4.1-mini", "claude-sonnet-4-5". Pass through.
  return model;
}

function paneAgentState(pane, type) {
  if (type === 'claude') {
    return {
      busyUntil: pane.claudeBusyUntil, usage: pane.usage,
      sessionId: pane.claudeSessionId, modelFn: shortModelLabel,
      saveTitle: 'Save Claude session', emptyMsg: 'no session yet'
    };
  }
  return {
    busyUntil: pane.copilotBusyUntil, usage: pane.copilotUsage,
    sessionId: pane.copilotSessionId, modelFn: shortCopilotModelLabel,
    saveTitle: 'Save Copilot session', emptyMsg: 'no session yet'
  };
}

const agentRowCache = new Map();
function agentRowKey(paneId, type) { return paneId + ':' + type; }

// One card per agent: chat panes the app drives itself, plus `claude`/`copilot`
// detected running inside a terminal pane.
function collectAgents() {
  const out = [];
  for (const [tabId, view] of chatTabs) {
    const tab = tabs.get(tabId);
    if (!tab) continue;
    out.push({ key: 'chat:' + tab.chatId, kind: 'chat', type: 'claude', tab, view });
  }
  for (const { tab, pane, type } of getAllAgentPanes()) {
    out.push({ key: agentRowKey(pane.paneId, type), kind: 'pane', type, tab, pane });
  }
  return out;
}

function maxLabelFor(max) {
  return max >= 1e6 ? '1M' : max >= 1e3 ? (Math.round(max / 1e3) + 'k') : String(max);
}

function buildAgentCard(entry) {
  const card = document.createElement('div');
  card.className = 'agent-card idle';

  const top = document.createElement('div'); top.className = 'agent-top';
  const badge = document.createElement('span'); badge.className = 'agent-badge';
  badge.textContent = entry.type === 'claude' ? 'CLAUDE' : 'COPILOT';
  const name = document.createElement('span'); name.className = 'agent-name';
  const stateWrap = document.createElement('span'); stateWrap.className = 'agent-state';
  const stateDot = document.createElement('span'); stateDot.className = 'dot';
  const stateText = document.createElement('span');
  stateWrap.appendChild(stateDot); stateWrap.appendChild(stateText);
  top.appendChild(badge); top.appendChild(name); top.appendChild(stateWrap);
  card.appendChild(top);

  const usage = document.createElement('div'); usage.className = 'agent-usage';
  const usageTop = document.createElement('div'); usageTop.className = 'agent-usage-top';
  const abs = document.createElement('span'); abs.className = 'agent-usage-abs';
  const pctEl = document.createElement('span'); pctEl.className = 'agent-usage-pct';
  usageTop.appendChild(abs); usageTop.appendChild(pctEl);
  const bar = document.createElement('div'); bar.className = 'agent-bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);
  usage.appendChild(usageTop); usage.appendChild(bar);
  card.appendChild(usage);

  const foot = document.createElement('div'); foot.className = 'agent-foot';
  const model = document.createElement('span'); model.className = 'agent-model';
  const handoff = document.createElement('span'); handoff.className = 'agent-act handoff';
  handoff.textContent = '↗ Hand off';
  handoff.title = 'Write a handoff brief and open Copilot here (right-click for length)';
  const save = document.createElement('span'); save.className = 'agent-act';
  save.textContent = '＋ Save';
  foot.appendChild(model);
  if (entry.type === 'claude') foot.appendChild(handoff);
  foot.appendChild(save);
  card.appendChild(foot);

  return { card, badge, name, stateDot, stateText, abs, pctEl, fill, model, handoff, save };
}

function renderAgentPanel() {
  if (!agentListEl) return;
  const entries = collectAgents();
  agentsCountEl.textContent = String(entries.length);

  if (!entries.length) {
    if (agentRowCache.size || !agentListEl.querySelector('.agent-empty')) {
      agentListEl.innerHTML = '';
      agentRowCache.clear();
      const e = document.createElement('div');
      e.className = 'agent-empty';
      e.textContent = 'No agents running';
      agentListEl.appendChild(e);
    }
    updateStatusAgents();
    return;
  }
  const placeholder = agentListEl.querySelector('.agent-empty');
  if (placeholder) placeholder.remove();

  const seen = new Set();
  const now = Date.now();

  for (const entry of entries) {
    seen.add(entry.key);
    let c = agentRowCache.get(entry.key);
    if (!c) {
      c = buildAgentCard(entry);
      agentRowCache.set(entry.key, c);
      agentListEl.appendChild(c.card);
    }
    c.entry = entry;

    // Re-bind handlers each pass: the entry's tab/pane identity can change.
    c.card.onclick = () => {
      setActive(entry.tab.tabId);
      if (entry.kind !== 'pane') return;
      // An agent running in a chat pane's drawer: reveal the drawer before focusing.
      if (entry.tab.type === 'chat') {
        const view = chatTabs.get(entry.tab.tabId);
        if (view && !view.isTerminalOpen()) view.toggleTerminal();
        else setActivePane(entry.tab, entry.pane.paneId);
        return;
      }
      setActivePane(entry.tab, entry.pane.paneId);
    };
    c.handoff.onclick = (e) => {
      e.stopPropagation();
      const cwd = entry.kind === 'chat' ? entry.tab.cwd : entry.pane.cwd;
      if (cwd) handoffClaudeToCopilot(cwd);
    };
    c.handoff.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      const cwd = entry.kind === 'chat' ? entry.tab.cwd : entry.pane.cwd;
      if (cwd) showHandoffLengthMenu(e.clientX, e.clientY, cwd);
    };
    c.save.onclick = (e) => {
      e.stopPropagation();
      if (entry.kind === 'chat') saveChatSession(entry.tab);
      else saveCurrentAgentSession(entry.pane, entry.tab, entry.type);
    };

    let working, ctx, max, model, sessionId, note = null;
    if (entry.kind === 'chat') {
      const s = entry.view.getState();
      working = s.working;
      ctx = s.contextTokens;
      max = s.contextWindow || 200000;
      model = s.apiModel ? shortModelLabel(s.apiModel) : s.modelLabel;
      sessionId = s.sessionId;
      if (s.exited) note = 'session ended';
    } else {
      const s = paneAgentState(entry.pane, entry.type);
      working = now < s.busyUntil;
      const u = s.usage;
      if (u && !u.error) {
        ctx = u.contextTokens;
        max = u.contextWindow || (entry.type === 'claude' ? contextWindowFor(u.model) : 128000);
        model = u.model ? s.modelFn(u.model) : '';
      } else {
        ctx = null;
        max = entry.type === 'claude' ? 200000 : 128000;
        model = '';
        if (u && u.error) note = s.emptyMsg;
      }
      sessionId = s.sessionId;
    }

    const cls = 'agent-card agent-' + entry.type + ' ' + (working ? 'working' : 'idle');
    if (c.card.className !== cls) c.card.className = cls;

    const label = (entry.tab.customTitle || tabAutoName(entry.tab)) +
      (entry.kind === 'pane' && entry.tab.panes.size > 1 ? ' [pane]' : '');
    if (c.name.textContent !== label) c.name.textContent = label;

    const stateLabel = note || (working ? 'Working' : 'Idle');
    if (c.stateText.textContent !== stateLabel) c.stateText.textContent = stateLabel;

    const pct = ctx != null && max ? Math.min(100, Math.round((ctx / max) * 100)) : null;
    const absText = ctx != null
      ? `${formatTokens(ctx)} / ${maxLabelFor(max)} ctx`
      : (note ? note : 'no usage yet');
    if (c.abs.textContent !== absText) c.abs.textContent = absText;
    c.abs.className = 'agent-usage-abs' + (ctx == null ? ' muted' : '');
    const pctText = pct == null ? '' : pct + '%';
    if (c.pctEl.textContent !== pctText) c.pctEl.textContent = pctText;
    const level = pct == null ? '' : pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : '';
    c.pctEl.className = 'agent-usage-pct ' + level;
    c.fill.className = level;
    c.fill.style.width = (pct == null ? 0 : pct) + '%';

    if (c.model.textContent !== (model || '')) c.model.textContent = model || '';
    c.save.style.display = sessionId ? '' : 'none';
  }

  for (const [k, c] of agentRowCache) {
    if (!seen.has(k)) { c.card.remove(); agentRowCache.delete(k); }
  }
  updateStatusAgents();
}

// ---------- Claude → Copilot handoff ----------
const HANDOFF_LENGTH_OPTIONS = [
  { label: 'Compact',  tokens: 2000 },
  { label: 'Medium',   tokens: 6000 },
  { label: 'Large',    tokens: 12000 }
];
function getDefaultHandoffTokens() {
  const v = parseInt(localStorage.getItem('handoffTargetTokens') || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 6000;
}
function showHandoffLengthMenu(x, y, cwd) {
  showContextMenu(x, y, HANDOFF_LENGTH_OPTIONS.map(o => ({
    label: `Hand off — ${o.label} (~${o.tokens} tok)`,
    action: () => {
      localStorage.setItem('handoffTargetTokens', String(o.tokens));
      handoffClaudeToCopilot(cwd, o.tokens);
    }
  })));
}
async function handoffClaudeToCopilot(cwd, targetTokens) {
  if (!cwd) return;
  const tokens = targetTokens || getDefaultHandoffTokens();
  const res = await window.claudeApi.handoff({ cwd, targetTokens: tokens });
  if (res?.error) {
    alert('Handoff failed: ' + res.error);
    return;
  }
  const rel = res.relPath || '.mac-code/handoff.md';
  // Copy a ready prompt to clipboard so user can paste if auto-inject misses.
  const prompt = `Read ${rel} — it's a handoff brief from a Claude Code session that ran out of tokens. After reading, ask me what to continue with.`;
  try { await navigator.clipboard.writeText(prompt); } catch (_) {}
  // Open a new copilot tab in the same cwd. After copilot launches, try to
  // inject the read prompt. Delay is heuristic — paste fallback in clipboard.
  const tab = await createTab({ cwd, runOnReady: 'gh copilot' });
  setTimeout(() => {
    try {
      const pane = tab && getActivePane(tab);
      if (pane && pane.copilotRunning) {
        window.term.input(pane.ptyId, prompt + '\r');
      }
    } catch (_) {}
  }, 6500);
}

// ---------- Saved agent sessions library ----------
// Entries: { id, cwd, name, type: 'claude'|'copilot' }
// Legacy entries without type are treated as 'claude' for backward compat.
const claudeSessionLibrary = [];
const copilotSessionLibrary = [];
const claudeSessionsListEl = document.getElementById('claude-sessions-list');

function resumeCommandFor(type, id) {
  return type === 'copilot' ? `gh copilot --resume=${id}` : `claude --resume ${id}`;
}

function librariesInOrder() {
  return [
    ...claudeSessionLibrary.map(s => ({ s, lib: claudeSessionLibrary, type: 'claude' })),
    ...copilotSessionLibrary.map(s => ({ s, lib: copilotSessionLibrary, type: 'copilot' }))
  ];
}

// A saved Claude session opens as a chat pane (resumed in place); Copilot has no
// chat surface, so it still resumes inside a terminal.
function resumeSavedSession(s, type) {
  if (type === 'claude') createChatTab({ cwd: s.cwd, resumeSessionId: s.id });
  else createTab({ cwd: s.cwd, runOnReady: resumeCommandFor(type, s.id) });
}

function renderClaudeSessions() {
  if (!claudeSessionsListEl) return;
  claudeSessionsListEl.innerHTML = '';
  const all = librariesInOrder();
  if (savedCountEl) savedCountEl.textContent = String(all.length);
  if (!all.length) {
    const e = document.createElement('div'); e.className = 'agent-empty';
    e.textContent = 'No saved sessions'; claudeSessionsListEl.appendChild(e); return;
  }
  for (const { s, lib, type } of all) {
    const row = document.createElement('div'); row.className = 'saved-session saved-' + type;
    const dot = document.createElement('span'); dot.className = 'saved-dot';
    const main = document.createElement('div'); main.className = 'saved-main';
    const nm = document.createElement('span'); nm.className = 'saved-name'; nm.textContent = s.name;
    const cw = document.createElement('span'); cw.className = 'saved-cwd';
    cw.textContent = shortPath(s.cwd);
    cw.title = s.cwd;
    main.appendChild(nm); main.appendChild(cw);
    const action = document.createElement('span'); action.className = 'saved-action'; action.textContent = 'Resume';
    row.appendChild(dot); row.appendChild(main); row.appendChild(action);
    row.addEventListener('click', () => resumeSavedSession(s, type));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = [
        { label: 'Rename', action: () => startRenameSavedSession(s, nm) },
        { label: 'Resume', hint: type === 'claude' ? 'chat' : 'terminal', badge: type === 'claude' ? 'C' : 'GH',
          action: () => resumeSavedSession(s, type) }
      ];
      if (type === 'claude') {
        items.push({ label: 'Resume in terminal', hint: 'terminal',
          action: () => createTab({ cwd: s.cwd, runOnReady: resumeCommandFor(type, s.id) }) });
        items.push({ separator: true });
        items.push({ label: 'Hand off to Copilot', action: () => handoffClaudeToCopilot(s.cwd) });
      }
      items.push({ separator: true });
      items.push({ label: 'Remove', action: () => {
        const i = lib.indexOf(s);
        if (i >= 0) lib.splice(i, 1);
        renderClaudeSessions(); scheduleSaveSession();
      }});
      showContextMenu(e.clientX, e.clientY, items);
    });
    row.dataset.sessionId = s.id;
    claudeSessionsListEl.appendChild(row);
  }
  annotateSessionAges();
}

// The name carries the date a session was *saved*, but "Clear old" judges by last
// activity — so hovering a row explains why an old-looking entry is still here.
let ageAnnotateToken = 0;
async function annotateSessionAges() {
  const token = ++ageAnnotateToken;
  const all = librariesInOrder();
  if (!all.length) return;
  let ages;
  try {
    ages = await window.sessionApi.ages(all.map(({ s, type }) => ({ id: s.id, cwd: s.cwd, type })));
  } catch (_) { return; }
  if (token !== ageAnnotateToken) return;
  const now = Date.now();
  for (const a of ages) {
    if (!a || !a.id) continue;
    const row = claudeSessionsListEl.querySelector(`[data-session-id="${CSS.escape(a.id)}"]`);
    if (!row) continue;
    if (a.exists === false) {
      row.title = 'Transcript is gone — this session can no longer be resumed';
      row.classList.add('saved-stale');
      continue;
    }
    const days = (now - a.mtime) / 86400000;
    row.title = 'Last active ' + (days < 1
      ? 'today'
      : days < 2 ? 'yesterday' : Math.round(days) + ' days ago');
  }
}

// Saved-session names are built as "<tab> · 2026-06-04" or "… · 2026-06-04 11:38",
// which is the only age signal for entries saved before savedAt existed.
function ageFromName(name) {
  const m = String(name || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const t = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] ? Number(m[4]) : 12, m[5] ? Number(m[5]) : 0
  ).getTime();
  return Number.isFinite(t) ? t : null;
}

// "Clear old" drops saved sessions last touched more than a week ago. Age comes from
// the CLI transcript's mtime where it still exists, then savedAt, then the date in
// the name. A session whose transcript is gone can no longer be resumed, so it goes
// too. Only entries with no age signal at all are kept.
async function clearOldSavedSessions(maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const all = librariesInOrder();
  if (!all.length) return { removed: 0, kept: 0, unknown: 0 };

  let ages = [];
  try {
    ages = await window.sessionApi.ages(
      all.map(({ s, type }) => ({ id: s.id, cwd: s.cwd, type }))
    );
  } catch (_) { ages = []; }

  const byId = new Map();
  for (const a of ages) if (a && a.id) byId.set(a.id, a);

  let removed = 0, unknown = 0;
  const doomed = [];
  for (const { s, lib } of all) {
    const info = byId.get(s.id);
    let age = info && typeof info.mtime === 'number' ? info.mtime : null;
    if (age == null && typeof s.savedAt === 'number') age = s.savedAt;
    if (age == null) age = ageFromName(s.name);

    // No transcript left: the Resume command would fail, so it is stale by definition.
    const gone = !!(info && info.exists === false);
    if (age == null && !gone) { unknown++; continue; }
    if (gone || age < cutoff) doomed.push({ s, lib });
  }

  for (const { s, lib } of doomed) {
    const i = lib.indexOf(s);
    if (i >= 0) { lib.splice(i, 1); removed++; }
  }

  renderClaudeSessions();
  scheduleSaveSession();
  return { removed, kept: all.length - removed, unknown };
}

function startRenameSavedSession(s, nameEl) {
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'saved-rename-input'; input.value = s.name;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const span = document.createElement('span'); span.className = 'saved-name';
    const v = input.value.trim();
    if (commit && v) s.name = v;
    span.textContent = s.name;
    input.replaceWith(span);
    renderClaudeSessions();
    scheduleSaveSession();
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
}

function libraryFor(type) { return type === 'copilot' ? copilotSessionLibrary : claudeSessionLibrary; }

function saveCurrentAgentSession(pane, tab, type) {
  const sid = type === 'copilot' ? pane.copilotSessionId : pane.claudeSessionId;
  if (!sid || !pane.cwd) return;
  const lib = libraryFor(type);
  if (lib.some(s => s.id === sid)) return;
  const defaultName = (tab.customTitle || tabAutoName(tab)) + ' · ' + new Date().toISOString().slice(0,10);
  lib.push({ id: sid, cwd: pane.cwd, name: defaultName, savedAt: Date.now() });
  renderClaudeSessions();
  scheduleSaveSession();
  const last = claudeSessionsListEl.lastElementChild;
  if (last) {
    const nm = last.querySelector('.saved-name');
    if (nm) startRenameSavedSession(lib[lib.length - 1], nm);
  }
}

function maybeAutoSaveAgentSession(tab, pane, type) {
  const sid = type === 'copilot' ? pane.copilotSessionId : pane.claudeSessionId;
  const usage = type === 'copilot' ? pane.copilotUsage : pane.usage;
  if (!sid || !pane.cwd || !usage || usage.error) return;
  const ctx = usage.contextTokens;
  const max = usage.contextWindow || 200000;
  if (!ctx || !max) return;
  const pct = (ctx / max) * 100;
  if (pct < 10) return;
  const lib = libraryFor(type);
  if (lib.some(s => s.id === sid)) return;
  const stamp = new Date().toISOString().slice(0,16).replace('T',' ');
  const name = (tab.customTitle || tabAutoName(tab)) + ' · ' + stamp;
  lib.push({ id: sid, cwd: pane.cwd, name, savedAt: Date.now() });
  renderClaudeSessions();
  scheduleSaveSession();
}

async function refreshClaudeUsage() {
  const items = [];
  for (const [, tab] of tabs)
    for (const [, pane] of tab.panes)
      if (pane.claudeRunning && pane.cwd) items.push({ tab, pane });
  if (!items.length) return;
  await Promise.all(items.map(async ({ tab, pane }) => {
    try {
      pane.usage = await window.claudeApi.usage(pane.cwd);
      if (pane.usage?.sessionId) pane.claudeSessionId = pane.usage.sessionId;
      maybeAutoSaveAgentSession(tab, pane, 'claude');
    } catch (_) {}
  }));
  scheduleAgentRender();
}

async function refreshCopilotUsage() {
  const items = [];
  for (const [, tab] of tabs)
    for (const [, pane] of tab.panes)
      if (pane.copilotRunning && pane.cwd) items.push({ tab, pane });
  if (!items.length) return;
  await Promise.all(items.map(async ({ tab, pane }) => {
    try {
      pane.copilotUsage = await window.copilotApi.usage(pane.cwd);
      if (pane.copilotUsage?.sessionId) pane.copilotSessionId = pane.copilotUsage.sessionId;
      maybeAutoSaveAgentSession(tab, pane, 'copilot');
    } catch (_) {}
  }));
  scheduleAgentRender();
}

// ---------- Agent finish notifications ----------
const paneWorkingState = new Map();  // key: paneId:type -> bool

function checkAgentNotifications() {
  const now = Date.now();
  for (const [, tab] of tabs) {
    for (const [, pane] of tab.panes) {
      for (const type of ['claude', 'copilot']) {
        const running = type === 'claude' ? pane.claudeRunning : pane.copilotRunning;
        const key = pane.paneId + ':' + type;
        if (!running) { paneWorkingState.delete(key); continue; }
        const busyUntil = type === 'claude' ? pane.claudeBusyUntil : pane.copilotBusyUntil;
        const working = now < busyUntil;
        const wasWorking = paneWorkingState.get(key) ?? false;
        if (wasWorking && !working && !document.hasFocus()) {
          const name = tab.customTitle || tabAutoName(tab);
          const label = type === 'claude' ? 'Claude' : 'Copilot';
          new Notification(`${label} finished`, { body: `${name} is ready`, silent: false });
        }
        paneWorkingState.set(key, working);
      }
    }
  }
}

setInterval(refreshClaudeUsage, 2000);
setInterval(refreshCopilotUsage, 2000);
setInterval(() => { if (getAllAgentPanes().length > 0) { renderAgentPanel(); checkAgentNotifications(); } }, 400);
renderAgentPanel();
renderClaudeSessions();

// ---------- chat pane event routing ----------
function chatViewFor(chatId) {
  for (const [, view] of chatTabs) {
    if (view.chatId === chatId) return view;
  }
  return null;
}
window.chatApi.onEvent(({ chatId, event }) => {
  const view = chatViewFor(chatId);
  if (view) view.handleEvent(event);
});
window.chatApi.onStderr(({ chatId, text }) => {
  const view = chatViewFor(chatId);
  if (view) view.handleStderr(text);
});
window.chatApi.onExit(({ chatId, code, sessionId }) => {
  const view = chatViewFor(chatId);
  if (view) view.handleExit(code);
  // Keep the id so "Send" on a dead pane can resume rather than start fresh.
  for (const [tabId, v] of chatTabs) {
    if (v === view && sessionId) {
      const tab = tabs.get(tabId);
      if (tab) tab.chatSessionId = sessionId;
      break;
    }
  }
  scheduleAgentRender();
});
window.chatApi.onPermissionRequest((req) => {
  const view = chatViewFor(req.chatId);
  if (!view) {
    // Nothing to ask in — deny rather than leave the CLI hanging on the hook.
    window.chatApi.respondPermission({ permId: req.permId, decision: 'deny' });
    return;
  }
  view.handlePermission(req);
  if (!document.hasFocus()) {
    new Notification('Claude needs permission', {
      body: `${req.toolName} in ${basename(req.cwd || '')}`, silent: false
    });
  }
});

// ---------- window controls ----------
document.getElementById('btn-min').addEventListener('click',   () => window.win.minimize());
document.getElementById('btn-max').addEventListener('click',   () => window.win.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.win.close());

const newTabBtn = document.getElementById('new-tab');
newTabBtn.addEventListener('click', () => createTab());
newTabBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const cwd = activeId ? tabCwd(tabs.get(activeId)) : null;
  showContextMenu(e.clientX, e.clientY, [
    { label: 'New shell', shortcut: 'Ctrl+T', hint: 'terminal', action: () => createTab({ cwd: cwd || undefined }) },
    { separator: true },
    { badge: 'C',  label: 'New Claude chat',   hint: 'chat',     action: () => createChatTab({ cwd: cwd || undefined }) },
    { badge: 'C',  label: 'Claude in terminal', hint: 'terminal', action: () => createTab({ cwd: cwd || undefined, runOnReady: 'claude' }) },
    { badge: 'GH', label: 'Copilot in terminal', hint: 'terminal', action: () => createTab({ cwd: cwd || undefined, runOnReady: 'gh copilot' }) }
  ]);
});

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitAll, 50); });

// Ctrl+Z arrives via IPC from the main process (before-input-event), bypassing menu
// accelerators and xterm's textarea. Apply chunk-level undo to the active pane.
window.shortcuts?.onCtrlZ?.(() => {
  if (!activeId) return;
  const tab = tabs.get(activeId);
  if (!tab || tab.type === 'editor') return;
  if (tab.type === 'chat') {
    const view = chatTabs.get(activeId);
    if (!view) return;
    // Undo belongs to whichever input the user is actually in.
    if (view.terminalHasFocus() && tab.termPane) {
      const chunk = popUndoChunk(tab.termPane);
      if (!chunk) return;
      const n = visibleLength(chunk);
      if (n > 0) window.term.input(tab.termPane.ptyId, '\x7f'.repeat(n));
      return;
    }
    view.undo();
    return;
  }
  const pane = getActivePane(tab);
  if (!pane) return;
  const chunk = popUndoChunk(pane);
  if (!chunk) return;
  const n = visibleLength(chunk);
  if (n > 0) window.term.input(pane.ptyId, '\x7f'.repeat(n));
});

// ---------- keyboard shortcuts ----------
window.addEventListener('keydown', (e) => {
  // Ctrl+` toggles a chat pane's terminal drawer. Handled before the field guard so
  // it also works from inside the composer and from the drawer's own shell.
  if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '`' || e.code === 'Backquote')) {
    const t = activeId ? tabs.get(activeId) : null;
    if (t && t.type === 'chat') {
      e.preventDefault();
      const view = chatTabs.get(activeId);
      if (view) view.toggleTerminal();
      return;
    }
  }

  // Skip if typing into a field — the terminal, the composer and the rename inputs
  // all handle their own keys.
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    const cwd = activeId ? tabCwd(tabs.get(activeId)) : null;
    createChatTab({ cwd: cwd || undefined });
  } else if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault(); createTab();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (!activeId) return;
    const tab = tabs.get(activeId);
    if (!tab) return;
    if (tab.panes.size > 1) closePane(tab, tab.activePaneId);
    else closeTab(activeId);
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault(); setAgentsCollapsed(!agentsPanelEl.classList.contains('collapsed'));
  } else if (e.ctrlKey && e.key === 'b') {
    e.preventDefault(); sidebarEl.classList.toggle('collapsed');
  } else if (e.key === 'F2') {
    if (document.activeElement?.classList.contains('tab-rename-input')) return;
    e.preventDefault();
    if (activeId) { const t = tabs.get(activeId); if (t) startRename(t); }
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    const t = activeId ? tabs.get(activeId) : null;
    if (t && t.panes.size) splitPane(t, t.activePaneId, 'v');
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    const t = activeId ? tabs.get(activeId) : null;
    if (t && t.panes.size) splitPane(t, t.activePaneId, 'h');
  }
});

// ---------- session persistence ----------
let _sessionReady = false;
let saveTimer = null;
function saveSession() {
  const tabsData = [];
  let activeIndex = -1;
  let i = 0;
  for (const [id, t] of tabs) {
    const ap = (t.type === 'editor' || t.type === 'chat') ? null : getActivePane(t);
    let scrollback = null;
    if (ap?.serialize) { try { scrollback = ap.serialize.serialize({ scrollback: 5000 }); } catch (_) {} }
    const view = chatTabs.get(id);
    tabsData.push({
      type: t.type === 'editor' ? 'editor' : t.type === 'chat' ? 'chat' : 'terminal',
      cwd: t.type === 'chat' ? (t.cwd || null) : (ap?.cwd || null),
      filePath: t.filePath || null,
      customTitle: t.customTitle || null,
      color: t.color || null,
      chatSessionId: view ? (view.sessionId || t.chatSessionId || null) : null,
      chatModel: view ? view.model : null,
      chatPermissionMode: view ? view.getState().permissionMode : null,
      chatTerminalOpen: view ? view.isTerminalOpen() : false,
      scrollback
    });
    if (id === activeId) activeIndex = i;
    i++;
  }
  window.sessionApi.save({
    tabs: tabsData, activeIndex,
    claudeSessions: claudeSessionLibrary,
    copilotSessions: copilotSessionLibrary
  });
}
function scheduleSaveSession() {
  if (!_sessionReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 500);
}
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); saveSession(); });

// ---------- boot ----------
(async () => {
  let restored = false;
  // Resolve the CLI's default mode before any pane is built, so the first pane of
  // the session doesn't start on 'default' and then disagree with the menu.
  try {
    const r = await window.claudeApi.defaultPermissionMode();
    if (r && PERM_MODE_IDS.has(r.mode)) cliPermissionDefault = r.mode;
  } catch (_) {}
  try {
    const sess = await window.sessionApi.load();
    if (Array.isArray(sess?.claudeSessions)) {
      claudeSessionLibrary.length = 0;
      claudeSessionLibrary.push(...sess.claudeSessions);
    }
    if (Array.isArray(sess?.copilotSessions)) {
      copilotSessionLibrary.length = 0;
      copilotSessionLibrary.push(...sess.copilotSessions);
    }
    renderClaudeSessions();
    if (sess?.tabs?.length) {
      const created = [];
      for (const t of sess.tabs) {
        let tab;
        if (t.type === 'editor' && t.filePath) tab = await createEditorTab(t.filePath);
        else if (t.type === 'chat') {
          tab = await createChatTab({
            cwd: t.cwd || undefined,
            model: t.chatModel || 'opus',
            permissionMode: t.chatPermissionMode || undefined,
            resumeSessionId: t.chatSessionId || null,
            color: t.color || null
          });
          if (t.chatTerminalOpen) {
            const v = chatTabs.get(tab.tabId);
            if (v) v.toggleTerminal();
          }
        }
        else tab = await createTab({ cwd: t.cwd || undefined, initialContent: t.scrollback || null });
        if (t.color) setTabColor(tab, t.color);
        if (t.customTitle) {
          tab.customTitle = t.customTitle;
          setTabTitle(tab, t.customTitle);
          const view = chatTabs.get(tab.tabId);
          if (view) view.setName(t.customTitle);
        }
        created.push(tab);
      }
      const idx = sess.activeIndex;
      if (idx >= 0 && idx < created.length) setActive(created[idx].tabId);
      restored = true;
    }
  } catch (_) {}
  if (!restored) await createTab();
  _sessionReady = true;
  scheduleSaveSession();
})();
