const { Terminal } = window;
const FitAddonNs = window.FitAddon || {};
const FitAddon = FitAddonNs.FitAddon || FitAddonNs.default || FitAddonNs;

const WINDOWS_TERMINAL_THEME = {
  background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff',
  cursorAccent: '#0c0c0c', selectionBackground: '#3a3d41',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
  blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
  brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e',
  brightCyan: '#61d6d6', brightWhite: '#f2f2f2'
};

// tab fields: id, term, fit, container, tabEl, titleEl, title, customTitle,
//   color, cwd, shell, treeRoot, expandedPaths, selectedPath, ro,
//   runOnReady, claudeRunning, claudeBusyUntil, suppressBusyUntil, lastDataAt, usage
const tabs = new Map();
let activeId = null;

const tabsEl       = document.getElementById('tabs');
const areaEl       = document.getElementById('terminal-area');
const statusCwd    = document.getElementById('status-cwd');
const statusTabs   = document.getElementById('status-tabs');
const treeEl       = document.getElementById('tree');
const sidebarEl    = document.getElementById('sidebar');
const sidebarHandleEl = document.getElementById('sidebar-handle');
const agentListEl  = document.getElementById('agent-list');

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
const FILE_ICONS = {
  '.ts':'🟦','.tsx':'🟦','.js':'🟨','.jsx':'🟨','.mjs':'🟨','.cjs':'🟨',
  '.json':'📦','.md':'📘','.html':'🌐','.htm':'🌐','.css':'🎨','.scss':'🎨',
  '.py':'🐍','.rs':'🦀','.go':'🐹','.java':'☕','.cs':'🟪',
  '.png':'🖼️','.jpg':'🖼️','.svg':'🖼️','.ico':'🖼️',
  '.zip':'🗜️','.tar':'🗜️','.gz':'🗜️',
  '.pdf':'📕','.env':'📋','.gitignore':'🙈',
  '.yml':'⚙','.yaml':'⚙','.toml':'⚙','.lock':'🔒',
  '.ps1':'💠','.sh':'📜','.bat':'📜','.cmd':'📜','.exe':'⚡'
};
function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return '🐳';
  if (lower === 'package.json') return '📦';
  if (lower.startsWith('.git')) return '🙈';
  const dot = lower.lastIndexOf('.');
  return FILE_ICONS[dot >= 0 ? lower.slice(dot) : ''] || '📄';
}
function basename(p) {
  if (!p) return '';
  const cleaned = p.replace(/[\\/]+$/, '');
  const i = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return i >= 0 ? cleaned.slice(i + 1) || cleaned : cleaned;
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- tab helpers ----------
function tabAutoName(tab) { return basename(tab.cwd || '') || 'PowerShell'; }

function pushSize(t) {
  const { cols, rows } = t.term;
  if (cols && rows) window.term.resize(t.id, cols, rows);
}
function fitTab(t) {
  if (!t || !t.fit) return;
  try {
    const dims = t.fit.proposeDimensions();
    if (!dims || !dims.cols || !dims.rows) return;
    if (dims.cols !== t.term.cols || dims.rows !== t.term.rows) {
      t.fit.fit();
      pushSize(t);
    }
  } catch (_) {}
}
function fitAll() { for (const [, t] of tabs) fitTab(t); }

// ---------- active / status ----------
function setActive(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  const suppressUntil = Date.now() + 350;
  for (const [tid, t] of tabs) {
    t.tabEl.classList.toggle('active', tid === id);
    t.container.classList.toggle('active', tid === id);
    t.suppressBusyUntil = suppressUntil;
  }
  const t = tabs.get(id);
  requestAnimationFrame(() => {
    try { t.fit.fit(); } catch (_) {}
    t.term.focus();
    pushSize(t);
  });
  renderTree();
  updateStatus();
  scheduleAgentRender();
}
function updateStatus() {
  statusTabs.textContent = `${tabs.size} tab${tabs.size === 1 ? '' : 's'}`;
  if (activeId && tabs.has(activeId)) {
    statusCwd.textContent = tabs.get(activeId).cwd || '~';
  } else {
    statusCwd.textContent = '~';
  }
}

// ---------- createTab ----------
async function createTab(opts = {}) {
  const container = document.createElement('div');
  container.className = 'term-container';
  areaEl.appendChild(container);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 13, lineHeight: 1.0, cursorBlink: true, cursorStyle: 'bar',
    scrollback: 5000, allowProposedApi: true, theme: WINDOWS_TERMINAL_THEME
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  const { id, shell, cwd } = await window.term.create({
    cols: term.cols, rows: term.rows, cwd: opts.cwd || undefined
  });

  const initialName = basename(cwd) || 'PowerShell';
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `${shellSvg()}<span class="tab-title">${escapeHtml(initialName)}</span><span class="tab-close" title="Close tab">${closeSvg()}</span>`;
  tabsEl.appendChild(tabEl);

  const titleEl = tabEl.querySelector('.tab-title');
  const closeEl = tabEl.querySelector('.tab-close');

  tabEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tab-close') || e.target.closest('.tab-rename-input')) return;
    if (e.button === 1) { closeTab(id); return; }
    setActive(id);
  });
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });

  titleEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const t = tabs.get(id);
    if (t) startRename(t);
  });

  tabEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tab-rename-input')) return;
    e.preventDefault(); e.stopPropagation();
    const t = tabs.get(id);
    if (!t) return;
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', shortcut: 'F2', action: () => startRename(t) },
      { separator: true },
      { swatches: TAB_COLORS, selected: t.color || null, onPick: (c) => setTabColor(t, c.value) },
      { separator: true },
      { label: 'Close tab', shortcut: 'Ctrl+Shift+W', action: () => closeTab(id) }
    ]);
  });

  term.onData(data => window.term.input(id, data));
  term.onResize(({ cols, rows }) => window.term.resize(id, cols, rows));

  // Right-click: copy selection or paste
  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault(); e.stopPropagation();
    hideContextMenu();
    if (term.hasSelection()) {
      const sel = term.getSelection();
      if (sel) { try { await navigator.clipboard.writeText(sel); } catch (_) {} term.clearSelection(); }
      return;
    }
    try { const text = await navigator.clipboard.readText(); if (text) window.term.input(id, text); } catch (_) {}
  });

  // Shell title — don't override if user renamed
  term.onTitleChange(title => {
    const t = tabs.get(id);
    if (t && title) t.title = title;
  });

  // OSC 6633: PSReadLine Enter handler emits command line before submission
  term.parser.registerOscHandler(6633, (data) => {
    if (typeof data !== 'string') return false;
    const cmd = data.trim();
    const t = tabs.get(id);
    if (!t) return false;
    const first = cmd.split(/\s+/)[0]?.toLowerCase();
    if (first === 'claude' || first === 'claude.exe' || first === 'claude.cmd') {
      t.claudeRunning = true;
      t.claudeBusyUntil = Date.now() + 600;
      scheduleAgentRender();
    }
    return false;
  });

  // OSC 9;9: cwd marker from prompt wrapper
  term.parser.registerOscHandler(9, (data) => {
    if (typeof data !== 'string' || !data.startsWith('9;')) return false;
    let cwd = data.substring(2).trim().replace(/^"+|"+$/g, '');
    if (!cwd) return false;
    const t = tabs.get(id);
    if (t && t.cwd !== cwd) {
      t.cwd = cwd;
      if (!t.customTitle) t.titleEl.textContent = basename(cwd) || 'PowerShell';
      if (id === activeId) { renderTree(); updateStatus(); }
    }
    if (t && t.claudeRunning) { t.claudeRunning = false; scheduleAgentRender(); }
    if (t && t.runOnReady) {
      const cmd = t.runOnReady;
      t.runOnReady = null;
      setTimeout(() => window.term.input(id, cmd + '\r'), 30);
    }
    return false;
  });

  const tab = {
    id, term, fit, container, tabEl, titleEl,
    title: 'PowerShell', customTitle: null, color: null,
    cwd, shell,
    treeRoot: null, expandedPaths: new Set(), selectedPath: null,
    ro: null,
    runOnReady: opts.runOnReady || null,
    claudeRunning: false, claudeBusyUntil: 0, suppressBusyUntil: 0, lastDataAt: 0,
    usage: null
  };
  tabs.set(id, tab);

  if (tab.runOnReady) {
    setTimeout(() => {
      if (tab.runOnReady) { const cmd = tab.runOnReady; tab.runOnReady = null; window.term.input(id, cmd + '\r'); }
    }, 1500);
  }

  let roTimer = null;
  tab.ro = new ResizeObserver(() => {
    clearTimeout(roTimer);
    roTimer = setTimeout(() => fitTab(tab), 16);
  });
  tab.ro.observe(container);

  setActive(id);
  updateStatus();
  return tab;
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.ro) { try { t.ro.disconnect(); } catch (_) {} }
  window.term.kill(id);
  t.term.dispose();
  t.container.remove();
  t.tabEl.remove();
  tabs.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = tabs.keys().next().value;
    if (next) setActive(next);
    else window.win.close();
  }
  updateStatus();
  scheduleAgentRender();
}

// Stream pty data
window.term.onData((id, data) => {
  const t = tabs.get(id);
  if (!t) return;
  t.term.write(data);
  t.lastDataAt = Date.now();
  if (t.claudeRunning && t.lastDataAt > (t.suppressBusyUntil || 0)) {
    t.claudeBusyUntil = t.lastDataAt + 500;
    scheduleAgentRender();
  }
});
window.term.onExit((id) => { if (tabs.has(id)) closeTab(id); });

// ---------- context menu ----------
const ctxMenuEl = document.getElementById('ctx-menu');

function showContextMenu(x, y, items) {
  ctxMenuEl.innerHTML = '';
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div'); sep.className = 'ctx-sep';
      ctxMenuEl.appendChild(sep); continue;
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
    const label = document.createElement('span'); label.textContent = item.label;
    el.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement('span'); sc.className = 'ctx-shortcut'; sc.textContent = item.shortcut;
      el.appendChild(sc);
    }
    if (!item.disabled && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
    ctxMenuEl.appendChild(el);
  }
  ctxMenuEl.style.display = 'block';
  const rect = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  ctxMenuEl.style.top  = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}
function hideContextMenu() { ctxMenuEl.style.display = 'none'; }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.ctx-menu')) hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);
window.addEventListener('resize', hideContextMenu);

function cdToPath(targetPath) {
  if (!activeId) return;
  const t = tabs.get(activeId);
  if (!t || !targetPath) return;
  window.term.input(t.id, `cd '${String(targetPath).replace(/'/g, "''")}'\r`);
  t.term.focus();
}
function folderContextItems(folderPath) {
  return [
    { label: 'Go here in shell', action: () => cdToPath(folderPath) },
    { label: 'Go here in a new shell', action: () => createTab({ cwd: folderPath }) },
    { separator: true },
    { label: 'Open Claude here', action: () => createTab({ cwd: folderPath, runOnReady: 'claude' }) }
  ];
}

// ---------- tab rename + color ----------
const TAB_COLORS = [
  { name: 'None',   value: null },
  { name: 'Red',    value: '#f44747' },
  { name: 'Orange', value: '#d7ba7d' },
  { name: 'Yellow', value: '#f9f1a5' },
  { name: 'Green',  value: '#4ec994' },
  { name: 'Cyan',   value: '#61d6d6' },
  { name: 'Blue',   value: '#3b78ff' },
  { name: 'Purple', value: '#c586c0' },
  { name: 'Pink',   value: '#ff8fb3' }
];

function setTabColor(tab, value) {
  tab.color = value;
  if (value) { tab.tabEl.style.setProperty('--tab-color', value); tab.tabEl.dataset.colored = '1'; }
  else { tab.tabEl.style.removeProperty('--tab-color'); delete tab.tabEl.dataset.colored; }
}

function startRename(tab) {
  if (!tab) return;
  const current = tab.customTitle || tab.titleEl.textContent || '';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'tab-rename-input'; input.value = current;
  tab.titleEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const span = document.createElement('span'); span.className = 'tab-title';
    if (commit) {
      const name = input.value.trim();
      if (name) { tab.customTitle = name; span.textContent = name; }
      else { tab.customTitle = null; span.textContent = tabAutoName(tab); }
    } else {
      span.textContent = tab.customTitle || tabAutoName(tab);
    }
    input.replaceWith(span); tab.titleEl = span;
    span.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tab); });
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
async function renderTree() {
  treeEl.innerHTML = '';
  if (!activeId || !tabs.has(activeId)) {
    treeEl.innerHTML = '<div class="wt-empty">No active tab</div>'; return;
  }
  const t = tabs.get(activeId);
  if (!t.cwd) { treeEl.innerHTML = '<div class="wt-empty">Loading…</div>'; return; }

  const rootName = basename(t.cwd) || t.cwd;
  const rootRow = document.createElement('div');
  rootRow.className = 'wt-item open';
  rootRow.style.paddingLeft = '6px';
  rootRow.dataset.path = t.cwd;
  rootRow.innerHTML = `<span class="wt-arrow">▶</span><span class="wt-icon">📁</span><span class="wt-name" title="${escapeHtml(t.cwd)}">${escapeHtml(rootName.toUpperCase())}</span>`;
  treeEl.appendChild(rootRow);
  const rootChildren = document.createElement('div');
  rootChildren.dataset.childrenOf = t.cwd;
  treeEl.appendChild(rootChildren);

  t.expandedPaths.add(t.cwd);
  await populateChildren(t, rootChildren, t.cwd, 1);

  const ordered = Array.from(t.expandedPaths).filter(p => p !== t.cwd).sort((a, b) => a.length - b.length);
  for (const ep of ordered) {
    const slot = treeEl.querySelector(`[data-children-of="${CSS.escape(ep)}"]`);
    const row  = treeEl.querySelector(`[data-path="${CSS.escape(ep)}"]`);
    if (slot && row && slot.dataset.populated !== '1') {
      row.classList.add('open'); slot.style.display = '';
      await populateChildren(t, slot, ep, parseInt(row.dataset.depth || '1', 10) + 1);
    }
  }

  rootRow.addEventListener('click', () => {
    const open = rootRow.classList.toggle('open');
    rootChildren.style.display = open ? '' : 'none';
    if (open) t.expandedPaths.add(t.cwd); else t.expandedPaths.delete(t.cwd);
  });
  rootRow.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, folderContextItems(t.cwd));
  });
}

async function populateChildren(tab, slotEl, dirPath, depth) {
  if (slotEl.dataset.populated === '1') return;
  slotEl.innerHTML = `<div class="wt-empty" style="padding-left:${depth * 12 + 6}px">Loading…</div>`;
  const result = await window.fs.list(dirPath);
  slotEl.innerHTML = ''; slotEl.dataset.populated = '1';

  if (result.error) {
    const err = document.createElement('div');
    err.className = 'wt-error'; err.style.paddingLeft = (depth * 12 + 6) + 'px';
    err.textContent = result.error; slotEl.appendChild(err); return;
  }
  if (!result.entries || result.entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wt-empty'; empty.style.paddingLeft = (depth * 12 + 6) + 'px';
    empty.textContent = '(empty)'; slotEl.appendChild(empty); return;
  }

  for (const entry of result.entries) {
    const row = document.createElement('div');
    row.className = 'wt-item';
    row.dataset.path = entry.path; row.dataset.depth = String(depth);
    row.style.paddingLeft = (depth * 12 + 6) + 'px';
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
          if (childSlot.dataset.populated !== '1') await populateChildren(tab, childSlot, entry.path, depth + 1);
        } else {
          tab.expandedPaths.delete(entry.path); childSlot.style.display = 'none';
        }
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation(); selectRow(tab, row, entry.path);
        showContextMenu(e.clientX, e.clientY, folderContextItems(entry.path));
      });
      slotEl.appendChild(row); slotEl.appendChild(childSlot);
    } else {
      row.innerHTML = `<span class="wt-arrow" style="visibility:hidden">▶</span><span class="wt-icon">${fileIcon(entry.name, false)}</span><span class="wt-name">${escapeHtml(entry.name)}</span>`;
      row.addEventListener('click', (e) => { e.stopPropagation(); selectRow(tab, row, entry.path); });
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
document.getElementById('sb-refresh').addEventListener('click', () => {
  if (!activeId) return;
  const t = tabs.get(activeId);
  if (t) renderTree();
});
document.getElementById('sb-up').addEventListener('click', async () => {
  if (!activeId) return;
  const t = tabs.get(activeId);
  if (!t || !t.cwd) return;
  const parent = await window.fs.parent(t.cwd);
  if (parent) { t.cwd = parent; t.expandedPaths.clear(); t.selectedPath = null; renderTree(); updateStatus(); }
});

// ---------- sidebar resize ----------
const SIDEBAR_MIN = 160;
const SIDEBAR_KEY = 'sidebarWidth';
const savedWidth = parseInt(localStorage.getItem(SIDEBAR_KEY) || '', 10);
if (Number.isFinite(savedWidth) && savedWidth >= SIDEBAR_MIN) sidebarEl.style.width = savedWidth + 'px';

const resizeEl = document.getElementById('sidebar-resize');
let dragState = null;

resizeEl.addEventListener('pointerdown', (e) => {
  if (sidebarEl.classList.contains('collapsed')) return;
  e.preventDefault(); resizeEl.setPointerCapture(e.pointerId);
  dragState = { startX: e.clientX, startWidth: sidebarEl.getBoundingClientRect().width };
  sidebarEl.classList.add('no-transition'); resizeEl.classList.add('dragging');
  document.body.classList.add('resizing-sidebar');
});
resizeEl.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const max = Math.max(SIDEBAR_MIN, Math.floor(window.innerWidth * 0.6));
  sidebarEl.style.width = Math.min(max, Math.max(SIDEBAR_MIN, dragState.startWidth + (e.clientX - dragState.startX))) + 'px';
});
function endResize(e) {
  if (!dragState) return;
  try { resizeEl.releasePointerCapture(e.pointerId); } catch (_) {}
  dragState = null;
  sidebarEl.classList.remove('no-transition'); resizeEl.classList.remove('dragging');
  document.body.classList.remove('resizing-sidebar');
  const w = Math.round(sidebarEl.getBoundingClientRect().width);
  if (w >= SIDEBAR_MIN) localStorage.setItem(SIDEBAR_KEY, String(w));
}
resizeEl.addEventListener('pointerup', endResize);
resizeEl.addEventListener('pointercancel', endResize);
resizeEl.addEventListener('dblclick', () => { sidebarEl.style.width = '240px'; localStorage.setItem(SIDEBAR_KEY, '240'); });

// ---------- Claude Agent panel ----------
let agentRenderQueued = false;
function scheduleAgentRender() {
  if (agentRenderQueued) return;
  agentRenderQueued = true;
  requestAnimationFrame(() => { agentRenderQueued = false; renderAgentPanel(); });
}

function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function contextWindowFor(model) {
  if (!model) return 200000;
  const m = model.toLowerCase();
  return (m.includes('1m') || m.includes('[1m]')) ? 1000000 : 200000;
}
function shortModelLabel(model) {
  if (!model) return '';
  if (/^(opus|sonnet|haiku|default)/i.test(model)) {
    return model.replace(/\s*\((?:1M|200k)\s*context\)/i, '').trim();
  }
  const m = model.toLowerCase();
  const match = m.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (match) {
    const [, family, major, minor] = match;
    return family.charAt(0).toUpperCase() + family.slice(1) + ` ${major}.${minor}`;
  }
  return model;
}

function renderAgentPanel() {
  if (!agentListEl) return;
  const claudeTabs = [...tabs.values()].filter(t => t.claudeRunning);
  agentListEl.innerHTML = '';
  if (claudeTabs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'agent-empty'; empty.textContent = 'No Claude sessions running';
    agentListEl.appendChild(empty); return;
  }
  const now = Date.now();
  for (const t of claudeTabs) {
    const working = now < t.claudeBusyUntil;
    const row = document.createElement('div');
    row.className = 'agent-tab ' + (working ? 'working' : 'idle');
    const dot = document.createElement('span'); dot.className = 'agent-status-dot';
    const main = document.createElement('div'); main.className = 'agent-tab-main';
    const top = document.createElement('div'); top.className = 'agent-tab-top';
    const name = document.createElement('span'); name.className = 'agent-tab-name';
    name.textContent = t.customTitle || tabAutoName(t);
    const status = document.createElement('span'); status.className = 'agent-tab-status';
    status.textContent = working ? 'working' : 'idle';
    top.appendChild(name); top.appendChild(status); main.appendChild(top);

    if (t.usage && !t.usage.error) {
      const ctx = t.usage.contextTokens;
      const maxCtx = t.usage.contextWindow || contextWindowFor(t.usage.model);
      const pct = ctx != null ? Math.min(100, Math.round((ctx / maxCtx) * 100)) : null;
      const maxLabel = maxCtx >= 1e6 ? '1M' : '200k';
      const usageLine = document.createElement('div'); usageLine.className = 'agent-tab-usage';
      usageLine.textContent = pct != null ? `${formatTokens(ctx)} ctx · ${pct}% of ${maxLabel}` : `${formatTokens(ctx)} ctx`;
      main.appendChild(usageLine);
      if (t.usage.model) {
        const modelLine = document.createElement('div'); modelLine.className = 'agent-tab-model';
        modelLine.textContent = shortModelLabel(t.usage.model);
        main.appendChild(modelLine);
      }
    } else if (t.usage?.error) {
      const usageLine = document.createElement('div'); usageLine.className = 'agent-tab-usage muted';
      usageLine.textContent = 'no session yet'; main.appendChild(usageLine);
    }

    row.appendChild(dot); row.appendChild(main);
    row.addEventListener('click', () => setActive(t.id));
    agentListEl.appendChild(row);
  }
}

async function refreshClaudeUsage() {
  const claudeTabs = [...tabs.values()].filter(t => t.claudeRunning && t.cwd);
  if (claudeTabs.length === 0) return;
  await Promise.all(claudeTabs.map(async t => {
    try { t.usage = await window.claudeApi.usage(t.cwd); } catch (_) {}
  }));
  scheduleAgentRender();
}
setInterval(refreshClaudeUsage, 2000);
setInterval(() => { if ([...tabs.values()].some(t => t.claudeRunning)) renderAgentPanel(); }, 400);
renderAgentPanel();

// ---------- window controls ----------
document.getElementById('btn-min').addEventListener('click', () => window.win.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.win.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.win.close());
document.getElementById('new-tab').addEventListener('click', () => createTab());

// Resize
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitAll, 50); });

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault(); createTab();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault(); if (activeId) closeTab(activeId);
  } else if (e.ctrlKey && e.key === 'b') {
    e.preventDefault(); sidebarEl.classList.toggle('collapsed');
  } else if (e.key === 'F2') {
    if (document.activeElement?.classList.contains('tab-rename-input')) return;
    e.preventDefault();
    if (activeId) { const t = tabs.get(activeId); if (t) startRename(t); }
  }
});

// Boot
createTab();
