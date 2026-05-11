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
let activeId = null;
let tabSeq = 0;
let paneSeq = 0;
const newTabId  = () => 'tab-'  + (++tabSeq);
const newPaneId = () => 'pane-' + (++paneSeq);

const tabsEl          = document.getElementById('tabs');
const areaEl          = document.getElementById('terminal-area');
const statusCwd       = document.getElementById('status-cwd');
const statusTabs      = document.getElementById('status-tabs');
const treeEl          = document.getElementById('tree');
const sidebarEl       = document.getElementById('sidebar');
const sidebarHandleEl = document.getElementById('sidebar-handle');
const agentListEl     = document.getElementById('agent-list');

// ---------- icons ----------
function shellSvg() {
  return `<svg class="tab-icon" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" stroke-width="1"/>
    <path d="M3 6l3 2-3 2M7 10h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
function closeSvg() {
  return `<svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;
}
function editorSvg() {
  return `<svg class="tab-icon" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="1" width="9" height="12" rx="1" stroke="currentColor" stroke-width="1"/>
    <path d="M4 5h5M4 7.5h5M4 10h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
    <path d="M11 9.5l2.5-2.5-1-1L10 8.5V10h1.5z" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
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
  return basename(getActivePane(tab)?.cwd || '') || 'PowerShell';
}

// ---------- status ----------
function updateStatus() {
  statusTabs.textContent = `${tabs.size} tab${tabs.size === 1 ? '' : 's'}`;
  if (activeId && tabs.has(activeId)) {
    const tab = tabs.get(activeId);
    statusCwd.textContent = tab.type === 'editor' ? tab.filePath : (getActivePane(tab)?.cwd || '~');
  } else {
    statusCwd.textContent = '~';
  }
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
  const old = getActivePane(tab);
  if (old) old.el.classList.remove('pane-active');
  tab.activePaneId = paneId;
  const pane = tab.panes.get(paneId);
  if (!pane) return;
  pane.el.classList.add('pane-active');
  pane.term.focus();
  if (tab.tabId === activeId) {
    if (!tab.customTitle) tab.titleEl.textContent = basename(pane.cwd || '') || 'PowerShell';
    updateStatus();
    renderTree();
  }
}

function setActive(tabId) {
  if (!tabs.has(tabId)) return;
  activeId = tabId;
  const suppressUntil = Date.now() + 350;
  for (const [tid, tab] of tabs) {
    tab.tabEl.classList.toggle('active', tid === tabId);
    tab.container.classList.toggle('active', tid === tabId);
    for (const [, pane] of tab.panes) pane.suppressBusyUntil = suppressUntil;
  }
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
    const lbl = document.createElement('span'); lbl.textContent = item.label; el.appendChild(lbl);
    if (item.shortcut) {
      const sc = document.createElement('span'); sc.className = 'ctx-shortcut'; sc.textContent = item.shortcut;
      el.appendChild(sc);
    }
    if (!item.disabled && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
    ctxMenuEl.appendChild(el);
  }
  ctxMenuEl.style.display = 'block';
  const rect = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = Math.max(0, Math.min(x, window.innerWidth  - rect.width  - 4)) + 'px';
  ctxMenuEl.style.top  = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}
function hideContextMenu() { ctxMenuEl.style.display = 'none'; }
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

  const { id: ptyId, cwd } = await window.term.create({
    cols: term.cols, rows: term.rows, cwd: opts.cwd || undefined
  });

  ptyPaneMap.set(ptyId, { tabId: tab.tabId, paneId });

  const pane = {
    paneId, ptyId, term, fit, serialize, el: paneEl, ro: null,
    cwd, claudeRunning: false, claudeBusyUntil: 0, claudeSessionId: null,
    copilotRunning: false, copilotBusyUntil: 0, copilotSessionId: null,
    copilotUsage: null,
    suppressBusyUntil: 0, lastDataAt: 0, usage: null,
    runOnReady: opts.runOnReady || null
  };
  tab.panes.set(paneId, pane);

  // Input — extend suppressBusyUntil so PTY echo of keystrokes
  // doesn't trigger the working indicator
  term.onData(data => {
    window.term.input(ptyId, data);
    pane.suppressBusyUntil = Math.max(pane.suppressBusyUntil || 0, Date.now() + 200);
  });
  term.onResize(({ cols, rows }) => window.term.resize(ptyId, cols, rows));

  // Ctrl+C: copy if selection, else send ^C to pty
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.shiftKey || e.altKey) return true;
    if (e.key === 'c' || e.key === 'C') {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      return true;
    }
    return true;
  });

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
        action: () => { if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); } }
      },
      {
        label: 'Paste',
        action: async () => { try { const t = await navigator.clipboard.readText(); if (t) window.term.input(ptyId, t); } catch (_) {} }
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
    const first = data.trim().split(/\s+/)[0]?.toLowerCase();
    if (first === 'claude' || first === 'claude.exe' || first === 'claude.cmd') {
      pane.claudeRunning = true;
      pane.claudeBusyUntil = Date.now() + 600;
      scheduleAgentRender();
    } else if (first === 'copilot' || first === 'copilot.exe' || first === 'copilot.cmd') {
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
      if (tab.activePaneId === paneId) {
        if (!tab.customTitle) tab.titleEl.textContent = basename(cwd) || 'PowerShell';
        if (tab.tabId === activeId) { renderTree(); updateStatus(); }
      }
    }
    if (pane.claudeRunning) { pane.claudeRunning = false; scheduleAgentRender(); }
    if (pane.copilotRunning) { pane.copilotRunning = false; scheduleAgentRender(); }
    if (pane.runOnReady) {
      const cmd = pane.runOnReady; pane.runOnReady = null;
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
      if (pane.runOnReady) { const cmd = pane.runOnReady; pane.runOnReady = null; window.term.input(ptyId, cmd + '\r'); }
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
  tabEl.innerHTML = `${shellSvg()}<span class="tab-title">${escapeHtml(initialName)}</span><span class="tab-close" title="Close tab">${closeSvg()}</span>`;
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
  tabEl.innerHTML = `${editorSvg()}<span class="tab-title">${escapeHtml(name)}</span><span class="tab-close" title="Close tab">${closeSvg()}</span>`;
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
      if (res.ok) { tab.dirty = false; tab.titleEl.textContent = tab.customTitle || name; }
    });
    tab.editor.onDidChangeModelContent(() => {
      if (!tab.dirty) { tab.dirty = true; tab.titleEl.textContent = '● ' + (tab.customTitle || name); }
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

// ---------- close tab ----------
function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (tab.type === 'editor') {
    try { tab.editor?.dispose(); } catch (_) {}
    tab.container.remove(); tab.tabEl.remove(); tabs.delete(tabId);
    if (activeId === tabId) { activeId = null; const n = tabs.keys().next().value; if (n) setActive(n); else window.win.close(); }
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
  if (activeId === tabId) {
    activeId = null;
    const next = tabs.keys().next().value;
    if (next) setActive(next);
    else window.win.close();
  }
  updateStatus();
  scheduleAgentRender();
  scheduleSaveSession();
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
  const current = tab.customTitle || tab.titleEl.textContent || '';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'tab-rename-input'; input.value = current;
  tab.titleEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const span = document.createElement('span'); span.className = 'tab-title';
    const name = input.value.trim();
    if (commit && name) { tab.customTitle = name; span.textContent = name; }
    else { tab.customTitle = null; span.textContent = tabAutoName(tab); }
    input.replaceWith(span); tab.titleEl = span;
    span.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tab); });
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
  if (!pane) return;
  window.term.input(pane.ptyId, `cd '${String(targetPath).replace(/'/g, "''")}'; Clear-Host\r`);
  pane.term.focus();
}
function folderContextItems(fp) {
  return [
    { label: 'Go here in shell',      action: () => cdToPath(fp) },
    { label: 'Go here in a new shell',action: () => createTab({ cwd: fp }) },
    { separator: true },
    { label: 'Open Claude here',       action: () => createTab({ cwd: fp, runOnReady: 'claude' }) },
    { label: 'Open Copilot here',      action: () => createTab({ cwd: fp, runOnReady: 'copilot' }) },
    { separator: true },
    { label: 'Open in Explorer',       action: () => window.fileApi.openExternal(fp) }
  ];
}
async function renderTree() {
  treeEl.innerHTML = '';
  if (!activeId || !tabs.has(activeId)) {
    treeEl.innerHTML = '<div class="wt-empty">No active tab</div>'; return;
  }
  const tab  = tabs.get(activeId);
  const pane = getActivePane(tab);
  if (!pane?.cwd) { treeEl.innerHTML = '<div class="wt-empty">Loading…</div>'; return; }

  const rootRow = document.createElement('div');
  rootRow.className = 'wt-item open';
  rootRow.style.paddingLeft = '6px';
  rootRow.dataset.path = pane.cwd;
  rootRow.innerHTML = `<span class="wt-arrow">▶</span><span class="wt-icon">📁</span><span class="wt-name" title="${escapeHtml(pane.cwd)}">${escapeHtml((basename(pane.cwd) || pane.cwd).toUpperCase())}</span>`;
  treeEl.appendChild(rootRow);
  const rootChildren = document.createElement('div');
  rootChildren.dataset.childrenOf = pane.cwd;
  treeEl.appendChild(rootChildren);
  tab.expandedPaths.add(pane.cwd);
  await populateChildren(tab, rootChildren, pane.cwd, 1);

  const ordered = Array.from(tab.expandedPaths).filter(p => p !== pane.cwd).sort((a, b) => a.length - b.length);
  for (const ep of ordered) {
    const slot = treeEl.querySelector(`[data-children-of="${CSS.escape(ep)}"]`);
    const row  = treeEl.querySelector(`[data-path="${CSS.escape(ep)}"]`);
    if (slot && row && slot.dataset.populated !== '1') {
      row.classList.add('open'); slot.style.display = '';
      await populateChildren(tab, slot, ep, parseInt(row.dataset.depth || '1', 10) + 1);
    }
  }
  rootRow.addEventListener('click', () => {
    const open = rootRow.classList.toggle('open');
    rootChildren.style.display = open ? '' : 'none';
    if (open) tab.expandedPaths.add(pane.cwd); else tab.expandedPaths.delete(pane.cwd);
  });
  rootRow.addEventListener('contextmenu', (e) => {
    e.preventDefault(); showContextMenu(e.clientX, e.clientY, folderContextItems(pane.cwd));
  });
}
async function populateChildren(tab, slotEl, dirPath, depth) {
  if (slotEl.dataset.populated === '1') return;
  slotEl.innerHTML = `<div class="wt-empty" style="padding-left:${depth*12+6}px">Loading…</div>`;
  const result = await window.fs.list(dirPath);
  slotEl.innerHTML = ''; slotEl.dataset.populated = '1';
  if (result.error) {
    const e = document.createElement('div'); e.className = 'wt-error';
    e.style.paddingLeft = (depth*12+6)+'px'; e.textContent = result.error;
    slotEl.appendChild(e); return;
  }
  if (!result.entries?.length) {
    const e = document.createElement('div'); e.className = 'wt-empty';
    e.style.paddingLeft = (depth*12+6)+'px'; e.textContent = '(empty)';
    slotEl.appendChild(e); return;
  }
  for (const entry of result.entries) {
    const row = document.createElement('div');
    row.className = 'wt-item'; row.dataset.path = entry.path;
    row.dataset.depth = String(depth); row.style.paddingLeft = (depth*12+6)+'px';
    if (tab.selectedPath === entry.path) row.classList.add('sel');
    if (entry.isDirectory) {
      row.innerHTML = `<span class="wt-arrow">▶</span><span class="wt-icon">📁</span><span class="wt-name">${escapeHtml(entry.name)}</span>`;
      const childSlot = document.createElement('div');
      childSlot.dataset.childrenOf = entry.path; childSlot.style.display = 'none';
      row.addEventListener('click', async (e) => {
        e.stopPropagation(); selectRow(tab, row, entry.path);
        const open = row.classList.toggle('open');
        if (open) {
          tab.expandedPaths.add(entry.path); childSlot.style.display = '';
          if (childSlot.dataset.populated !== '1') await populateChildren(tab, childSlot, entry.path, depth+1);
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
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open in Editor',          action: () => openInEditor(entry.path) },
          { label: 'Open in External Editor', action: () => window.fileApi.openExternal(entry.path) }
        ]);
      });
      slotEl.appendChild(row);
    }
  }
}
function selectRow(tab, rowEl, p) {
  tab.selectedPath = p;
  treeEl.querySelectorAll('.wt-item.sel').forEach(e => e.classList.remove('sel'));
  rowEl.classList.add('sel');
}

// ---------- sidebar controls ----------
document.getElementById('sb-collapse').addEventListener('click', () => sidebarEl.classList.add('collapsed'));
sidebarHandleEl.addEventListener('click', () => sidebarEl.classList.remove('collapsed'));
document.getElementById('sb-refresh').addEventListener('click', () => { if (activeId) renderTree(); });
document.getElementById('sb-up').addEventListener('click', async () => {
  if (!activeId) return;
  const tab  = tabs.get(activeId);
  const pane = getActivePane(tab);
  if (!pane?.cwd) return;
  const parent = await window.fs.parent(pane.cwd);
  if (parent) { pane.cwd = parent; tab.expandedPaths.clear(); tab.selectedPath = null; renderTree(); updateStatus(); }
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
function renderAgentPanel() {
  if (!agentListEl) return;
  const running = getAllAgentPanes();
  if (running.length === 0) {
    if (agentRowCache.size || !agentListEl.querySelector('.agent-empty')) {
      agentListEl.innerHTML = '';
      agentRowCache.clear();
      const e = document.createElement('div'); e.className = 'agent-empty';
      e.textContent = 'No agents running'; agentListEl.appendChild(e);
    }
    return;
  }
  const placeholder = agentListEl.querySelector('.agent-empty');
  if (placeholder) placeholder.remove();

  const seen = new Set();
  const now = Date.now();
  for (const { tab, pane, type } of running) {
    const key = agentRowKey(pane.paneId, type);
    seen.add(key);
    let c = agentRowCache.get(key);
    if (!c) {
      const row = document.createElement('div'); row.className = 'agent-tab idle agent-' + type;
      const dot = document.createElement('span'); dot.className = 'agent-status-dot';
      const main = document.createElement('div'); main.className = 'agent-tab-main';
      const top = document.createElement('div'); top.className = 'agent-tab-top';
      const badgeEl = document.createElement('span'); badgeEl.className = 'agent-tab-badge'; badgeEl.textContent = type === 'claude' ? 'C' : 'GH';
      const nameEl = document.createElement('span'); nameEl.className = 'agent-tab-name';
      const statEl = document.createElement('span'); statEl.className = 'agent-tab-status';
      top.appendChild(badgeEl); top.appendChild(nameEl); top.appendChild(statEl); main.appendChild(top);
      const usageEl = document.createElement('div'); main.appendChild(usageEl);
      const modelEl = document.createElement('div'); modelEl.className = 'agent-tab-model'; main.appendChild(modelEl);
      const saveBtn = document.createElement('span');
      saveBtn.className = 'agent-tab-save'; saveBtn.textContent = '＋';
      saveBtn.addEventListener('click', (e) => { e.stopPropagation(); saveCurrentAgentSession(pane, tab, type); });
      row.appendChild(dot); row.appendChild(main); row.appendChild(saveBtn);
      row.addEventListener('click', () => { setActive(tab.tabId); setActivePane(tab, pane.paneId); });
      agentListEl.appendChild(row);
      c = { row, nameEl, statEl, usageEl, modelEl, saveBtn };
      agentRowCache.set(key, c);
    }
    const s = paneAgentState(pane, type);
    c.saveBtn.title = s.saveTitle;
    const working = now < s.busyUntil;
    const newCls = 'agent-tab agent-' + type + ' ' + (working ? 'working' : 'idle');
    if (c.row.className !== newCls) c.row.className = newCls;
    const newName = (tab.customTitle || tabAutoName(tab)) + (tab.panes.size > 1 ? ' [pane]' : '');
    if (c.nameEl.textContent !== newName) c.nameEl.textContent = newName;
    const newStat = working ? 'working' : 'idle';
    if (c.statEl.textContent !== newStat) c.statEl.textContent = newStat;

    if (s.usage && !s.usage.error) {
      const ctx = s.usage.contextTokens;
      const max = s.usage.contextWindow || (type === 'claude' ? contextWindowFor(s.usage.model) : 128000);
      const pct = ctx != null ? Math.min(100, Math.round((ctx/max)*100)) : null;
      const usageCls = 'agent-tab-usage' + (pct == null ? '' : pct >= 85 ? ' danger' : pct >= 70 ? ' warn' : '');
      const maxLabel = max >= 1e6 ? '1M' : max >= 1e3 ? (Math.round(max/1e3) + 'k') : String(max);
      const usageText = pct != null ? `${formatTokens(ctx)} ctx · ${pct}% of ${maxLabel}` : `${formatTokens(ctx)} ctx`;
      if (c.usageEl.className !== usageCls) c.usageEl.className = usageCls;
      if (c.usageEl.textContent !== usageText) c.usageEl.textContent = usageText;
      if (s.usage.model) {
        const lbl = s.modelFn(s.usage.model);
        if (c.modelEl.textContent !== lbl) c.modelEl.textContent = lbl;
        c.modelEl.style.display = '';
      } else { c.modelEl.style.display = 'none'; }
    } else if (s.usage?.error) {
      if (c.usageEl.className !== 'agent-tab-usage muted') c.usageEl.className = 'agent-tab-usage muted';
      if (c.usageEl.textContent !== s.emptyMsg) c.usageEl.textContent = s.emptyMsg;
      c.modelEl.style.display = 'none';
    } else {
      if (c.usageEl.className !== 'agent-tab-usage') c.usageEl.className = 'agent-tab-usage';
      if (c.usageEl.textContent !== '') c.usageEl.textContent = '';
      c.modelEl.style.display = 'none';
    }
    c.saveBtn.style.display = s.sessionId ? '' : 'none';
  }
  for (const [k, c] of agentRowCache) {
    if (!seen.has(k)) { c.row.remove(); agentRowCache.delete(k); }
  }
}

// ---------- Saved agent sessions library ----------
// Entries: { id, cwd, name, type: 'claude'|'copilot' }
// Legacy entries without type are treated as 'claude' for backward compat.
const claudeSessionLibrary = [];
const copilotSessionLibrary = [];
const claudeSessionsListEl = document.getElementById('claude-sessions-list');

function resumeCommandFor(type, id) {
  return type === 'copilot' ? `copilot --resume=${id}` : `claude --resume ${id}`;
}

function librariesInOrder() {
  return [
    ...claudeSessionLibrary.map(s => ({ s, lib: claudeSessionLibrary, type: 'claude' })),
    ...copilotSessionLibrary.map(s => ({ s, lib: copilotSessionLibrary, type: 'copilot' }))
  ];
}

function renderClaudeSessions() {
  if (!claudeSessionsListEl) return;
  claudeSessionsListEl.innerHTML = '';
  const all = librariesInOrder();
  if (!all.length) {
    const e = document.createElement('div'); e.className = 'agent-empty';
    e.textContent = 'No saved sessions'; claudeSessionsListEl.appendChild(e); return;
  }
  for (const { s, lib, type } of all) {
    const row = document.createElement('div'); row.className = 'saved-session saved-' + type;
    const top = document.createElement('div'); top.className = 'saved-session-top';
    const badge = document.createElement('span'); badge.className = 'saved-session-badge'; badge.textContent = type === 'claude' ? 'C' : 'GH';
    const nm = document.createElement('span'); nm.className = 'saved-session-name'; nm.textContent = s.name;
    top.appendChild(badge); top.appendChild(nm);
    const cw = document.createElement('span'); cw.className = 'saved-session-cwd'; cw.textContent = basename(s.cwd);
    row.appendChild(top); row.appendChild(cw);
    row.addEventListener('click', () => {
      createTab({ cwd: s.cwd, runOnReady: resumeCommandFor(type, s.id) });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Rename', action: () => startRenameSavedSession(s, nm) },
        { label: 'Resume', action: () => createTab({ cwd: s.cwd, runOnReady: resumeCommandFor(type, s.id) }) },
        { separator: true },
        { label: 'Remove', action: () => {
          const i = lib.indexOf(s);
          if (i >= 0) lib.splice(i, 1);
          renderClaudeSessions(); scheduleSaveSession();
        }}
      ]);
    });
    claudeSessionsListEl.appendChild(row);
  }
}

function startRenameSavedSession(s, nameEl) {
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'saved-session-rename-input'; input.value = s.name;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const span = document.createElement('span'); span.className = 'saved-session-name';
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
  lib.push({ id: sid, cwd: pane.cwd, name: defaultName });
  renderClaudeSessions();
  scheduleSaveSession();
  const last = claudeSessionsListEl.lastElementChild;
  if (last) {
    const nm = last.querySelector('.saved-session-name');
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
  lib.push({ id: sid, cwd: pane.cwd, name });
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

// ---------- window controls ----------
document.getElementById('btn-min').addEventListener('click',   () => window.win.minimize());
document.getElementById('btn-max').addEventListener('click',   () => window.win.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.win.close());
document.getElementById('new-tab').addEventListener('click',   () => createTab());

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitAll, 50); });

// ---------- keyboard shortcuts ----------
window.addEventListener('keydown', (e) => {
  // Skip if inside a terminal (xterm handles keys)
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT') return;

  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault(); createTab();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (!activeId) return;
    const tab = tabs.get(activeId);
    if (!tab) return;
    if (tab.panes.size > 1) closePane(tab, tab.activePaneId);
    else closeTab(activeId);
  } else if (e.ctrlKey && e.key === 'b') {
    e.preventDefault(); sidebarEl.classList.toggle('collapsed');
  } else if (e.key === 'F2') {
    if (document.activeElement?.classList.contains('tab-rename-input')) return;
    e.preventDefault();
    if (activeId) { const t = tabs.get(activeId); if (t) startRename(t); }
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (activeId) { const t = tabs.get(activeId); if (t) splitPane(t, t.activePaneId, 'v'); }
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    if (activeId) { const t = tabs.get(activeId); if (t) splitPane(t, t.activePaneId, 'h'); }
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
    const ap = t.type === 'editor' ? null : getActivePane(t);
    let scrollback = null;
    if (ap?.serialize) { try { scrollback = ap.serialize.serialize({ scrollback: 5000 }); } catch (_) {} }
    tabsData.push({
      type: t.type === 'editor' ? 'editor' : 'terminal',
      cwd: ap?.cwd || null,
      filePath: t.filePath || null,
      customTitle: t.customTitle || null,
      color: t.color || null,
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
        else tab = await createTab({ cwd: t.cwd || undefined, initialContent: t.scrollback || null });
        if (t.color) setTabColor(tab, t.color);
        if (t.customTitle) { tab.customTitle = t.customTitle; tab.titleEl.textContent = t.customTitle; }
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
