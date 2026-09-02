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
const statusBranch    = document.getElementById('status-branch');
const statusBranchSep = document.getElementById('status-branch-sep');
const statusTabs      = document.getElementById('status-tabs');
const statusShell     = document.getElementById('status-shell');
const statusAgentsEl  = document.getElementById('status-agents');
const statusLimitsEl  = document.getElementById('status-limits');
const statusLimitsSepEl = document.getElementById('status-limits-sep');
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
function gridSvg() {
  return `<svg class="tab-icon" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.1"/>
    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.1"/>
    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.1"/>
    <rect x="9" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" stroke-width="1.1"/>
  </svg>`;
}
function tabInnerHtml(kind, name) {
  const lead = kind === 'chat'
    ? '<span class="tab-badge">C</span>'
    : kind === 'editor' ? editorSvg() : kind === 'grid' ? gridSvg() : shellSvg();
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
    const t = tabs.get(tabId);
    // While a grid is active, a background chip is a candidate to drag INTO the grid, so
    // don't switch away on press — that would hide the grid and kill the drop target.
    // Activation is deferred to a plain click (pointerup with no drag) instead.
    const activeGrid = (activeId && tabs.get(activeId)?.type === 'grid') ? tabs.get(activeId) : null;
    const deferActivate = !!(activeGrid && t && t.type !== 'grid' && !t.gridOwner && tabId !== activeGrid.tabId);
    if (!deferActivate) {
      // A chip whose content lives in a grid: don't show it standalone (its container is
      // inside a hidden grid) — surface the grid and focus its cell instead.
      if (t && t.gridOwner && tabs.has(t.gridOwner)) {
        setActive(t.gridOwner);
        focusGridCell(tabs.get(t.gridOwner), tabId);
      } else {
        setActive(tabId);
      }
    }
    tabDrag = { tabEl, tabId, startX: e.clientX, startY: e.clientY, started: false, deferActivate };
  });
}
// If a chip is being dragged over the active grid's stage, return that grid tab (so the
// drop mounts the chip as a member instead of reordering the strip).
function gridUnderPoint(x, y) {
  const t = activeId ? tabs.get(activeId) : null;
  if (!t || t.type !== 'grid') return null;
  const r = t.stage.getBoundingClientRect();
  return (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) ? t : null;
}
function clearGridDropHint() {
  document.querySelectorAll('.grid-cell.drop-hot, .grid-empty.drop-hot')
    .forEach((el) => el.classList.remove('drop-hot'));
}
document.addEventListener('pointermove', (e) => {
  if (!tabDrag) return;
  const { tabEl } = tabDrag;
  const dx = e.clientX - tabDrag.startX;
  if (!tabDrag.started && Math.abs(dx) < 5 && Math.abs(e.clientY - (tabDrag.startY ?? e.clientY)) < 5) return;
  if (!tabDrag.started) { tabDrag.started = true; tabEl.classList.add('dragging'); }

  // Over the grid stage → offer a drop-into-grid instead of a strip reorder.
  const dropTab = tabDrag.tabId ? gridUnderPoint(e.clientX, e.clientY) : null;
  const dragged = tabDrag.tabId && tabs.get(tabDrag.tabId);
  const canDrop = dropTab && dragged && dragged.type !== 'grid' && !dragged.gridOwner;
  clearGridDropHint();
  if (canDrop) {
    tabEl.classList.add('dragging');
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.grid-cell, .grid-empty');
    (cell || dropTab.stage.querySelector('.grid-empty'))?.classList.add('drop-hot');
    return;
  }

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
const _endTabDrag = (e) => {
  if (!tabDrag) return;
  const { tabEl, tabId, started, deferActivate } = tabDrag;
  tabDrag = null;
  tabEl.classList.remove('dragging');
  clearGridDropHint();
  if (!started) {
    // A plain click on a background chip while a grid was active: switch to it now.
    if (deferActivate && tabId) setActive(tabId);
    return;
  }
  // Dropped onto a grid stage → mount as a member (non-destructive).
  const dropTab = e && tabId ? gridUnderPoint(e.clientX, e.clientY) : null;
  const dragged = tabId && tabs.get(tabId);
  if (dropTab && dragged && dragged.type !== 'grid' && !dragged.gridOwner) {
    addToGrid(dropTab, tabId);
    return;
  }
  // A drag that didn't land on the grid just reorders the strip; if activation was
  // deferred (grid still active), leave the grid active rather than switching.
  reorderTabsMap();
};
document.addEventListener('pointerup', _endTabDrag);
document.addEventListener('pointercancel', _endTabDrag);

// ---------- tab helpers ----------
function getActivePane(tab) { return tab.panes.get(tab.activePaneId); }
// The tab the user is currently working in. For a grid tab that's the focused cell — a
// real member tab — so Explorer, the status bar and file actions target the cell's own
// content instead of the empty grid shell. Everything that answers "what am I looking
// at?" reads this; bookkeeping (history, active-loop, session save) still uses activeId.
function activeTab() {
  const t = activeId ? tabs.get(activeId) : null;
  if (t && t.type === 'grid') return (t.focusedMember && tabs.get(t.focusedMember)) || null;
  return t;
}
function tabAutoName(tab) {
  if (tab.type === 'editor') return basename(tab.filePath || '') || 'Editor';
  if (tab.type === 'chat') return basename(tab.cwd || '') || 'claude';
  if (tab.type === 'grid') return 'Grid';
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
  const tab = activeTab();
  const cwd = tabCwd(tab);
  statusCwd.textContent = cwd || '~';
  statusCwd.title = cwd || '';
  refreshBranch(tab && tab.type !== 'editor' ? cwd : null);
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

// ---------- Your commands (user macros) ----------
// A shortcut for message text: /cp sends "Commit and push", /pr sends a whole
// review-then-PR instruction. They are Mac Code's own, not the CLI's - a composer
// expands one into plain text before anything is sent, so the same list works in chat
// panes and in hybrid terminal panes, and nothing has to be written into .claude.
const CUSTOM_CMD_KEY = 'customCommands';
const CUSTOM_CMD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function normCustomCommandName(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^\/+/, '');
}

function readCustomCommands() {
  let list = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_CMD_KEY) || '[]');
    if (Array.isArray(parsed)) list = parsed;
  } catch (_) {}
  return list
    .map((c) => ({ name: normCustomCommandName(c && c.name), text: String((c && c.text) || '') }))
    .filter((c) => CUSTOM_CMD_NAME_RE.test(c.name) && c.text.trim());
}

let customCommands = readCustomCommands();

function getCustomCommands() { return customCommands; }
function persistCustomCommands() {
  localStorage.setItem(CUSTOM_CMD_KEY, JSON.stringify(customCommands));
}
function findCustomCommand(name) {
  const n = normCustomCommandName(name).toLowerCase();
  return customCommands.find((c) => c.name.toLowerCase() === n) || null;
}
function customCommandPreview(text) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > 96 ? one.slice(0, 95) + '\u2026' : one;
}

// /cp becomes the command's text. Anything typed after the name is appended, or dropped
// in at $ARGS when the text names the spot itself. Returns null when the line is not one
// of these commands, which leaves it alone - the CLI's own /-commands still work.
function expandCustomCommand(body) {
  const line = String(body == null ? '' : body);
  if (line.includes('\n') || !line.trim().startsWith('/')) return null;
  const m = line.trim().match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = findCustomCommand(m[1]);
  if (!cmd) return null;
  const args = (m[2] || '').trim();
  if (cmd.text.includes('$ARGS')) {
    const filled = cmd.text.split('$ARGS').join(args);
    // An empty $ARGS leaves a gap behind; close it rather than sending double spaces.
    return (args ? filled : filled.replace(/[ \t]{2,}/g, ' ')).trim();
  }
  return args ? cmd.text + ' ' + args : cmd.text;
}

// ---------- the manager dialog ----------
const cmdModalEl  = document.getElementById('cmd-modal');
const cmdListEl   = document.getElementById('cmd-list');
const cmdNameEl   = document.getElementById('cmd-name');
const cmdTextEl   = document.getElementById('cmd-text');
const cmdErrorEl  = document.getElementById('cmd-error');
const cmdSaveEl   = document.getElementById('cmd-save');
const cmdCancelEl = document.getElementById('cmd-cancel');
const cmdCloseEl  = document.getElementById('cmd-close');

// The name being edited, or null while the form is adding a new one.
let cmdEditing = null;

function renderCustomCommandList() {
  cmdListEl.innerHTML = '';
  if (!customCommands.length) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'No commands yet. Add one below.';
    cmdListEl.appendChild(empty);
    return;
  }
  for (const c of customCommands) {
    const row = document.createElement('div');
    row.className = 'cmd-row' + (cmdEditing === c.name ? ' editing' : '');
    const name = document.createElement('span');
    name.className = 'cmd-row-name';
    name.textContent = '/' + c.name;
    row.appendChild(name);
    const text = document.createElement('span');
    text.className = 'cmd-row-text';
    text.textContent = customCommandPreview(c.text);
    text.title = c.text;
    row.appendChild(text);
    const edit = document.createElement('span');
    edit.className = 'cmd-act';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => startEditCustomCommand(c.name));
    row.appendChild(edit);
    const del = document.createElement('span');
    del.className = 'cmd-act danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteCustomCommand(c.name));
    row.appendChild(del);
    cmdListEl.appendChild(row);
  }
}

function setCustomCommandForm(cmd) {
  cmdEditing = cmd ? cmd.name : null;
  cmdNameEl.value = cmd ? cmd.name : '';
  cmdTextEl.value = cmd ? cmd.text : '';
  cmdErrorEl.textContent = '';
  cmdSaveEl.textContent = cmd ? 'Save changes' : 'Add command';
  cmdCancelEl.textContent = cmd ? 'Cancel edit' : 'Close';
  renderCustomCommandList();
}

function startEditCustomCommand(name) {
  const cmd = findCustomCommand(name);
  if (!cmd) return;
  setCustomCommandForm(cmd);
  cmdTextEl.focus();
}

function deleteCustomCommand(name) {
  const n = normCustomCommandName(name).toLowerCase();
  customCommands = customCommands.filter((c) => c.name.toLowerCase() !== n);
  persistCustomCommands();
  if (cmdEditing && cmdEditing.toLowerCase() === n) setCustomCommandForm(null);
  else renderCustomCommandList();
}

function saveCustomCommandForm() {
  const name = normCustomCommandName(cmdNameEl.value);
  const text = cmdTextEl.value.trim();
  if (!CUSTOM_CMD_NAME_RE.test(name)) {
    cmdErrorEl.textContent = 'Name: letters, digits, - and _, starting with a letter or digit.';
    cmdNameEl.focus();
    return;
  }
  if (!text) {
    cmdErrorEl.textContent = 'Give the command some text to send.';
    cmdTextEl.focus();
    return;
  }
  const clash = findCustomCommand(name);
  if (clash && (!cmdEditing || clash.name.toLowerCase() !== cmdEditing.toLowerCase())) {
    cmdErrorEl.textContent = '/' + clash.name + ' already exists.';
    cmdNameEl.focus();
    return;
  }
  if (cmdEditing) {
    const old = cmdEditing.toLowerCase();
    const at = customCommands.findIndex((c) => c.name.toLowerCase() === old);
    if (at >= 0) customCommands[at] = { name, text };
    else customCommands.push({ name, text });
  } else {
    customCommands.push({ name, text });
  }
  persistCustomCommands();
  setCustomCommandForm(null);
  cmdNameEl.focus();
}

function openCustomCommands(prefillName) {
  // Re-read first: another window may have changed the list since this one loaded.
  customCommands = readCustomCommands();
  const existing = prefillName ? findCustomCommand(prefillName) : null;
  setCustomCommandForm(existing);
  if (!existing && prefillName) cmdNameEl.value = normCustomCommandName(prefillName);
  cmdModalEl.classList.add('show');
  (existing ? cmdTextEl : cmdNameEl).focus();
}
function closeCustomCommands() { cmdModalEl.classList.remove('show'); }

cmdSaveEl.addEventListener('click', saveCustomCommandForm);
cmdCloseEl.addEventListener('click', closeCustomCommands);
cmdCancelEl.addEventListener('click', () => {
  if (cmdEditing) { setCustomCommandForm(null); cmdNameEl.focus(); return; }
  closeCustomCommands();
});
// Only the backdrop closes it; a click inside the box must not.
cmdModalEl.addEventListener('mousedown', (e) => { if (e.target === cmdModalEl) closeCustomCommands(); });
cmdNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); cmdTextEl.focus(); }
  if (e.key === 'Escape') { e.preventDefault(); closeCustomCommands(); }
  e.stopPropagation();
});
cmdTextEl.addEventListener('keydown', (e) => {
  // Enter saves; the text itself can still be multi-line with Shift+Enter.
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveCustomCommandForm(); }
  if (e.key === 'Escape') { e.preventDefault(); closeCustomCommands(); }
  e.stopPropagation();
});
cmdModalEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeCustomCommands(); }
});

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

// ---------- Hybrid Claude input ----------
// A terminal pane running `claude` is the fastest surface we have: it is Claude's own
// TUI drawn straight into xterm, with no markdown pass and no pacing in front of it.
// What it does not give us is an input box we can style. Hybrid mode keeps that output
// and replaces only the input — Claude's own composer box at the bottom of the pane is
// covered by an opaque band, xterm's keyboard is switched off, and text goes into the
// PTY from our own composer instead.
//
// The band is driven by a *positive* match on the composer box, so anything we do not
// recognise — a permission prompt, a /-menu, a plan review — unmasks and hands the
// keyboard back to the terminal rather than trapping the user behind paint.
const HYBRID_KEY = 'termHybridInput';
let hybridEnabled = localStorage.getItem(HYBRID_KEY) === '1';
const hybridToggleEl = document.getElementById('hybrid-toggle');

function bufLine(buf, y) {
  const line = buf.getLine(y);
  return line ? line.translateToString(true) : '';
}

// A row that is nothing but a horizontal rule — how the current CLI frames its input,
// above and below the prompt line. Older builds draw a rounded box instead, so the
// corner glyphs count as a frame too.
const RULE_RE = /^[─━═_]{12,}$/;
// Once a session is named, the CLI tacks the name onto the right end of the top rule:
// `────────────────────  my-session`. So a frame top is a rule that may carry a trailing
// label, not only a bare rule.
const RULE_LABELLED_RE = /^[─━═_]{12,}\s+\S/;
// Corner glyph followed by at least one horizontal. Loose enough that a session name
// drawn into the top border — `╭─ my-session ──────╮` — is still read as a frame.
const BOX_TOP_RE = /^[╭┌╔][─━═]/;
const BOX_BOTTOM_RE = /^[╰└╚][─━═]/;
function isFrameTop(t) { return RULE_RE.test(t) || RULE_LABELLED_RE.test(t) || BOX_TOP_RE.test(t); }
function isFrameBottom(t) { return RULE_RE.test(t) || BOX_BOTTOM_RE.test(t); }

// The prompt line inside the frame: a bare ❯ or >, optionally carrying typed text, and
// optionally inside a box border. A numbered choice is NOT a prompt — that is a dialog
// asking something, and hiding it would leave the user answering a box they cannot see.
const PROMPT_RE = /^(?:[│┃|]\s*)?[❯>](?:\s|$)/;
const CHOICE_RE = /^(?:[│┃|]\s*)?[❯>]?\s*\d+[.)]\s/;
const ASKING_RE = /do you want|would you like|\(y\/n\)|press enter to|esc to (?:cancel|reject|go back)/i;

// The rows Claude's composer occupies right now, as { top, bottom } viewport rows, or
// null when there is nothing we are confident enough to cover. Everything about this is
// a positive match: an unrecognised screen unmasks rather than guessing.
function claudeComposerRows(term) {
  const buf = term.buffer.active;
  // Scrolled back through the transcript: what is on screen is history, not the live
  // composer, so there is nothing to hide.
  if (buf.viewportY !== buf.baseY) return null;
  const cursorAbs = buf.baseY + buf.cursorY;
  const lastAbs = buf.baseY + term.rows - 1;

  // The cursor sits on whichever line currently takes input. If that is not a prompt,
  // the CLI is asking something and the screen stays as it is.
  const cursorText = bufLine(buf, cursorAbs).trim();
  if (!PROMPT_RE.test(cursorText) || CHOICE_RE.test(cursorText)) return null;

  // Once Claude names the session it prints that name on a line just above its input
  // box. Tolerate a single such label between the prompt and the frame top so the band
  // still recognises the composer — a question or a numbered choice is never a label,
  // and the cursor-is-on-a-prompt guard above already keeps us clear of dialogs.
  let top = -1;
  let skipped = false;
  for (let y = cursorAbs - 1; y >= Math.max(0, cursorAbs - 12); y--) {
    const t = bufLine(buf, y).trim();
    if (!t) continue;
    if (isFrameTop(t)) { top = y; break; }
    if (!skipped && !CHOICE_RE.test(t) && !ASKING_RE.test(t) && !PROMPT_RE.test(t)) {
      skipped = true; // the session-name label; the frame top should be right above it
      continue;
    }
    break; // something else is directly above the prompt: not a frame we know
  }
  if (top < 0) return null;

  let bottom = -1;
  for (let y = cursorAbs + 1; y <= Math.min(lastAbs, cursorAbs + 12); y++) {
    const t = bufLine(buf, y).trim();
    if (isFrameBottom(t)) { bottom = y; break; }
    // A multi-line paste grows the prompt; anything else means we lost the frame.
    if (t && !PROMPT_RE.test(t) && !/^[│┃|]/.test(t)) return null;
  }
  if (bottom < 0) return null;

  // Last guard: never cover a frame that is putting a question in it.
  for (let y = top; y <= bottom; y++) {
    const t = bufLine(buf, y);
    if (ASKING_RE.test(t) || CHOICE_RE.test(t.trim())) return null;
  }
  return { top: top - buf.baseY, bottom: bottom - buf.baseY };
}

// Where row 0 starts inside the pane, and how tall a row is. Measured rather than
// derived from the CSS padding, so it stays right if the pane's box model changes.
function paneRowMetrics(pane) {
  const screen = pane.el.querySelector('.xterm-screen');
  if (!screen || !pane.term.rows) return null;
  const sr = screen.getBoundingClientRect();
  if (sr.height <= 0) return null;
  const pr = pane.el.getBoundingClientRect();
  return { offset: sr.top - pr.top, cell: sr.height / pane.term.rows };
}

function setPaneStdin(pane, on) {
  const off = !on;
  if (pane.stdinOff === off) return;
  pane.stdinOff = off;
  try { pane.term.options.disableStdin = off; } catch (_) {}
}

// Band geometry and keyboard state for one pane. Cheap enough for every render.
function updatePaneMask(pane) {
  if (!pane.mask) return;
  // Mid-scrape the menu is open over the pane and about to be closed again. Leave the
  // band where it is rather than reacting to a screen that is not settled.
  if (pane.hybridScraping && pane.masked) return;
  const active = hybridEnabled && pane.claudeRunning && !pane.hybridRaw;
  const rows = active ? claudeComposerRows(pane.term) : null;
  const m = rows ? paneRowMetrics(pane) : null;

  if (!rows || !m) {
    pane.masked = false;
    pane.mask.classList.remove('on');
    pane.mask.style.height = '0px';
    setPaneStdin(pane, true);
    return;
  }
  // One extra pixel of height so rounding never leaves a sliver of the frame showing.
  pane.mask.style.top = Math.floor(m.offset + rows.top * m.cell) + 'px';
  pane.mask.style.height = (Math.ceil((rows.bottom - rows.top + 1) * m.cell) + 1) + 'px';
  pane.mask.classList.add('on');
  pane.masked = true;
  pane.everMasked = true;
  setPaneStdin(pane, false);
}

// Bracketed paste rather than raw keystrokes: Claude's input treats a paste as one
// block, so a multi-line message arrives intact instead of every newline submitting it.
// The submitting Enter goes in a later tick — Ink applies a paste asynchronously and can
// otherwise see the carriage return first.
function sendToClaudePty(ptyId, text) {
  const body = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // A single-line slash command goes in as typing, which is the path the CLI's own
  // command handling is built around. Everything else goes in as one paste so that
  // newlines land in the message instead of submitting it line by line.
  if (!body.includes('\n') && body.startsWith('/')) window.term.input(ptyId, body);
  else window.term.input(ptyId, '\x1b[200~' + body + '\x1b[201~');
  setTimeout(() => window.term.input(ptyId, '\r'), 30);
}

// What the CLI's own /-menu is showing right now, as { cmd, desc } rows. Entries are a
// name column and a description that wraps onto indented continuation lines.
const SLASH_HEAD_RE = /^\/([A-Za-z0-9][\w:.-]*)\s{2,}(\S.*)$/;

// The menu is drawn below the composer, and ordinary transcript text can look just like
// an entry — `/claude-api    23%` in /usage output, for one. So the scan starts under the
// composer frame rather than at the top of the screen.
function scrapeSlashPage(term, minRow) {
  const buf = term.buffer.active;
  const rows = [];
  let last = null;
  for (let y = Math.max(0, minRow || 0); y < term.rows; y++) {
    const raw = bufLine(buf, buf.baseY + y).replace(/\s+$/, '');
    if (!raw) { last = null; continue; }
    const head = SLASH_HEAD_RE.exec(raw.replace(/^\s*[❯>]?\s*/, ''));
    if (head) { last = { cmd: '/' + head[1], desc: head[2].trim() }; rows.push(last); continue; }
    if (last && /^\s{16,}\S/.test(raw)) { last.desc += ' ' + raw.trim(); continue; }
    last = null;
  }
  return rows;
}

// Whatever is typed into Claude's composer right now, with the prompt marker stripped.
// Empty means the CLI's input is clear and safe to drive.
function promptRest(term) {
  const buf = term.buffer.active;
  const t = bufLine(buf, buf.baseY + buf.cursorY);
  return t.replace(/^\s*(?:[│┃|]\s*)?[❯>]\s?/, '').trim();
}

// Read the CLI's slash commands out of its own menu.
//
// This is a mirror of the menu, not of the CLI: a command the menu does not list (2.1.234
// leaves out /cost, /vim, /todos and /review, for instance) will not appear here either.
// Typing it and sending still works — nothing validates against this list.
//
// There is no cheap way to ask for this list: `claude -p` only reports it in the init
// event of a session that has been given a message, and the files on disk miss every
// command that comes from a plugin or an MCP server. The menu in the pane has all of
// them, so the list is read the way a user would read it — open the menu, page down
// until nothing new appears, close it. All of that happens behind the mask, and the
// only key that changes the composer is the slash, which is backspaced away again.
async function hybridLoadCommands(pane) {
  if (!pane || !pane.claudeRunning || pane.hybridScraping) return null;
  // Never drive a composer that already has something in it.
  if (promptRest(pane.term) !== '') return null;
  const write = (b) => window.term.input(pane.ptyId, b);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Where the composer sits right now. The frame does not move while the menu is open,
  // so this is the boundary for every page of the walk.
  const frame = claudeComposerRows(pane.term);
  const menuFrom = frame ? frame.bottom + 1 : 0;
  pane.hybridScraping = true;
  const seen = new Map();
  try {
    write('/');
    await wait(500);
    let dry = 0;
    for (let step = 0; step < 40 && dry < 4; step++) {
      const page = scrapeSlashPage(pane.term, menuFrom);
      let fresh = 0;
      for (const row of page) {
        if (!seen.has(row.cmd)) { seen.set(row.cmd, row); fresh++; }
      }
      if (fresh) dry = 0; else dry++;
      // The menu only scrolls once the selection passes the last visible entry, so a
      // step has to move by a whole screenful. Moving four rows at a time made every
      // step after the first look empty, which ended the walk inside the first page.
      const stride = Math.max(8, page.length);
      write('\x1b[B'.repeat(stride));
      await wait(180);
    }
  } finally {
    // Put the composer back exactly as it was. Only the slash was typed, but a dropped
    // keystroke would leave a character behind that corrupts the next message, so this
    // keeps deleting until the line reads clean again.
    write('\x7f');
    for (let i = 0; i < 20; i++) {
      await wait(100);
      if (promptRest(pane.term) === '') break;
      write('\x7f');
    }
    pane.hybridScraping = false;
    updatePaneMask(pane);
  }
  return Array.from(seen.values()).sort((a, b) => a.cmd.localeCompare(b.cmd));
}

// ---------- the composer itself ----------
function hybridSend(tab) {
  const pane = getActivePane(tab);
  if (pane && pane.hybridBar) pane.hybridBar.submit();
}

function ensureHybridBar(tab, pane) {
  if (!pane) return null;
  if (pane.hybridBar) return pane.hybridBar;

  const wrap = document.createElement('div');
  wrap.className = 'hybrid-wrap';

  const palette = document.createElement('div');
  palette.className = 'palette';
  wrap.appendChild(palette);

  const bar = document.createElement('div');
  bar.className = 'hybrid-bar';
  wrap.appendChild(bar);

  const attachRow = document.createElement('div');
  attachRow.className = 'attach-row';
  bar.appendChild(attachRow);

  const row = document.createElement('div');
  row.className = 'hybrid-row';
  bar.appendChild(row);

  const input = document.createElement('textarea');
  input.className = 'hybrid-input';
  input.rows = 1;
  input.placeholder = 'Message Claude — Enter to send, Shift+Enter for a new line, / for commands';
  row.appendChild(input);

  const mkBtn = (label, title, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hybrid-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    if (title) b.title = title;
    return b;
  };

  const sendBtn = mkBtn('Send', 'Send to Claude — Enter', 'send');
  row.appendChild(sendBtn);

  const foot = document.createElement('div');
  foot.className = 'hybrid-foot';
  bar.appendChild(foot);

  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.accept = 'image/*';
  filePicker.multiple = true;
  filePicker.style.display = 'none';
  foot.appendChild(filePicker);

  const imageBtn = mkBtn('🖼 Image', 'Attach an image — or paste or drop one', null);
  foot.appendChild(imageBtn);
  const cmdBtn = mkBtn('/ Commands', "Your commands and Claude's own", null);
  foot.appendChild(cmdBtn);
  const undoBtn = mkBtn('↶', 'Undo last input — Ctrl+Z', null);
  foot.appendChild(undoBtn);
  const escBtn = mkBtn('Esc', 'Send Escape — interrupts Claude', null);
  foot.appendChild(escBtn);
  const stopBtn = mkBtn('Ctrl+C', 'Send Ctrl+C', null);
  foot.appendChild(stopBtn);
  // Escape hatch. Detection fails safe, but if it ever masks something it should not,
  // this puts the real terminal back without turning hybrid mode off everywhere.
  const rawBtn = mkBtn('Raw', "Show and use Claude's own input in the pane", null);
  foot.appendChild(rawBtn);

  const hint = document.createElement('span');
  hint.className = 'hybrid-hint';
  hint.textContent = 'Claude is asking in the pane — answer up there';
  foot.appendChild(hint);

  const status = document.createElement('span');
  status.className = 'hybrid-status';
  foot.appendChild(status);
  const setStatus = (t) => { status.textContent = t || ''; };

  const keyTo = (bytes) => {
    window.term.input(pane.ptyId, bytes);
  };

  // ---------- attachments ----------
  // A PTY carries text, not image bytes. So an attachment is written to disk and the
  // message carries its path, which is what Claude needs in order to read it anyway.
  const attachments = [];

  function renderAttachments() {
    attachRow.classList.toggle('show', attachments.length > 0);
    attachRow.innerHTML = '';
    attachments.forEach((att, i) => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (att.thumb ? '' : ' file');
      if (att.thumb) {
        const img = document.createElement('img');
        img.className = 'chip-thumb';
        img.src = att.thumb;
        chip.appendChild(img);
      } else {
        const glyph = document.createElement('span');
        glyph.textContent = '📄';
        chip.appendChild(glyph);
      }
      const label = document.createElement('span');
      label.className = 'chip-label mono';
      label.textContent = att.label;
      chip.appendChild(label);
      const x = document.createElement('span');
      x.className = 'chip-x';
      x.textContent = '✕';
      x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
      chip.appendChild(x);
      attachRow.appendChild(chip);
    });
  }

  async function addImageFile(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const base64 = btoa(bin);
    const mediaType = file.type || 'image/png';
    const ext = (mediaType.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const saved = await window.chatApi.saveAttachment({ base64, ext });
    if (!saved || saved.error || !saved.path) {
      setStatus('could not save attachment');
      return;
    }
    attachments.push({
      path: saved.path,
      label: file.name || saved.name,
      thumb: 'data:' + mediaType + ';base64,' + base64
    });
    renderAttachments();
  }

  function addPathAttachment(p, label) {
    attachments.push({ path: p, label: label || p });
    renderAttachments();
  }

  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { e.preventDefault(); addImageFile(file); }
      }
    }
  });
  imageBtn.addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', async () => {
    for (const file of filePicker.files) await addImageFile(file);
    filePicker.value = '';
  });
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
  wrap.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      if (file.type.startsWith('image/')) await addImageFile(file);
      else if (file.path) addPathAttachment(file.path, file.name);
    }
  });

  // ---------- undo ----------
  // The composer is a textarea, so undo/redo are the browser's own — Notepad-style
  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, chunked by word and pause, with real redo. Main
  // leaves those keys alone while this field has focus (see app:text-field-focus), and
  // the ↶ button drives that same native stack.
  function doUndo() { input.focus(); document.execCommand('undo'); }

  // Auto-grow the composer with its content, from ~2 lines (min-height) up to 200px.
  // The textarea's own resize grip is off (resize:none in CSS), so this is the only
  // thing driving its height — no user-drag state to preserve.
  function autoGrow() {
    input.style.height = 'auto';
    const h = Math.min(200, Math.max(46, input.scrollHeight));
    input.style.height = h + 'px';
  }

  // ---------- command palette ----------
  let paletteItems = [];
  let paletteIndex = 0;
  let loading = false;

  function paletteRows(filter) {
    const cmds = tab.hybridCommands || [];
    // Your own commands come first: they are the ones typed most, and they are text this
    // composer expands rather than a command handed to the CLI.
    const rows = getCustomCommands().map((c) => ({
      cmd: '/' + c.name, desc: customCommandPreview(c.text), custom: true, text: c.text
    }));
    rows.push({ cmd: '/commands', desc: 'Create or edit your own commands', manage: true });
    for (const c of cmds) rows.push({ cmd: c.cmd, desc: c.desc });
    if (!cmds.length) {
      rows.push({
        cmd: loading ? '(reading…)' : '(no commands loaded)',
        desc: loading ? "Paging through Claude's own menu" : 'Click ↻ to read the list from Claude',
        noInsert: true
      });
    }
    const f = (filter || '').toLowerCase();
    if (!f || f === '/') return rows;
    // Prefix matches first, then anything that merely contains the text: /rev should still
    // find /security-review without making it outrank /review itself.
    const term = f.replace(/^\//, '');
    const starts = rows.filter((r) => r.cmd.toLowerCase().startsWith(f));
    const contains = rows.filter((r) => !starts.includes(r) && r.cmd.toLowerCase().includes(term));
    return starts.concat(contains);
  }

  function showPalette(filter) {
    paletteItems = paletteRows(filter);
    if (!paletteItems.length) { hidePalette(); return; }
    paletteIndex = 0;
    palette.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.className = 'palette-hdr hybrid';
    const hdrText = document.createElement('span');
    const total = (tab.hybridCommands || []).length;
    hdrText.textContent = 'Commands' + (total ? ' · ' + total + ' from Claude' : '');
    hdr.appendChild(hdrText);
    const refresh = document.createElement('span');
    refresh.className = 'palette-refresh';
    refresh.textContent = '↻';
    refresh.title = 'Re-read the list from Claude';
    // mousedown, not click: the input must not lose focus first.
    refresh.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadCommands(true);
    });
    hdr.appendChild(refresh);
    palette.appendChild(hdr);
    paletteItems.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'palette-item' + (i === 0 ? ' sel' : '');
      const cmd = document.createElement('span');
      cmd.className = 'palette-cmd';
      cmd.textContent = r.cmd;
      item.appendChild(cmd);
      const desc = document.createElement('span');
      desc.className = 'palette-desc';
      desc.textContent = r.desc;
      item.appendChild(desc);
      item.addEventListener('mouseenter', () => setPaletteIndex(i));
      item.addEventListener('mousedown', (e) => { e.preventDefault(); runPalette(i, 'send'); });
      palette.appendChild(item);
    });
    palette.classList.add('show');
  }

  function hidePalette() { palette.classList.remove('show'); paletteItems = []; }

  function setPaletteIndex(i) {
    paletteIndex = i;
    Array.from(palette.querySelectorAll('.palette-item'))
      .forEach((node, n) => node.classList.toggle('sel', n === i));
  }

  function syncPalette() {
    const v = input.value;
    if (v.startsWith('/') && !v.includes('\n')) showPalette(v.trim());
    else hidePalette();
  }

  function runPalette(i, mode) {
    const r = paletteItems[i];
    if (!r || r.noInsert) return;
    hidePalette();
    if (r.manage) { openCustomCommands(); return; }
    if (r.custom) {
      // A command whose text names $ARGS is waiting for the rest of the line, so it goes
      // in as the name itself instead of sending half a sentence.
      if (r.text.includes('$ARGS')) {
        input.value = r.cmd + ' ';
        autoGrow();
        input.focus();
        return;
      }
      input.value = r.text;
      autoGrow();
      if (mode === 'send') submit();
      input.focus();
      return;
    }
    input.value = r.cmd + ' ';
    autoGrow();
    input.focus();
  }

  async function loadCommands(force) {
    if (!pane || loading) return;
    if (tab.hybridCommands && !force) return;
    loading = true;
    setStatus('reading commands…');
    if (palette.classList.contains('show')) showPalette(input.value.trim());
    let list = null;
    try { list = await hybridLoadCommands(pane); }
    catch (_) { list = null; }
    loading = false;
    if (list && list.length) {
      tab.hybridCommands = list;
      setStatus(list.length + ' commands');
    } else {
      setStatus('could not read commands — try ↻');
    }
    if (palette.classList.contains('show')) showPalette(input.value.trim());
  }

  // ---------- submit ----------
  function submit() {
    // /commands typed straight in, with the palette dismissed, opens the editor rather
    // than going to Claude as a message.
    if (input.value.trim().toLowerCase() === '/commands' && !findCustomCommand('commands')) {
      input.value = '';
      autoGrow();
      hidePalette();
      openCustomCommands();
      return;
    }
    if (!pane) return;
    // The band is down, so the pane is showing something that owns the keyboard itself —
    // a permission prompt, a menu, /usage. Text sent now would land in that, not in a
    // message, so it stays here until the pane is back to its composer.
    if (!pane.masked && !pane.hybridRaw) {
      setStatus('answer in the pane first — Claude is showing something there');
      return;
    }
    // Attachment paths go in ahead of the message, one per line.
    const paths = attachments.map((a) => a.path);
    // One of your own commands turns into its text here, so Claude only sees a message.
    const typed = input.value;
    const expanded = expandCustomCommand(typed);
    const body = (paths.length ? paths.join('\n') + '\n' : '') + (expanded == null ? typed : expanded);
    if (!body.trim()) return;
    input.value = '';
    attachments.length = 0;
    renderAttachments();
    autoGrow();
    hidePalette();
    sendToClaudePty(pane.ptyId, body);
  }

  // ---------- wiring ----------
  sendBtn.addEventListener('click', () => { submit(); input.focus(); });
  escBtn.addEventListener('click', () => { keyTo('\x1b'); input.focus(); });
  stopBtn.addEventListener('click', () => { keyTo('\x03'); input.focus(); });
  undoBtn.addEventListener('click', () => { doUndo(); input.focus(); });
  rawBtn.addEventListener('click', () => {
    pane.hybridRaw = !pane.hybridRaw;
    rawBtn.classList.toggle('send', pane.hybridRaw);
    updatePaneMask(pane);
    refreshHybridBar(pane);
    if (pane.hybridRaw) pane.term.focus();
    else input.focus();
  });
  cmdBtn.addEventListener('click', () => {
    if (palette.classList.contains('show')) { hidePalette(); input.focus(); return; }
    if (!input.value.startsWith('/')) {
      input.value = '/';
      autoGrow();
    }
    input.focus();
    showPalette(input.value.trim());
    loadCommands(false);
  });

  input.addEventListener('input', () => {
    autoGrow();
    syncPalette();
  });
  input.addEventListener('focus', () => bar.classList.add('focused'));
  input.addEventListener('blur', () => bar.classList.remove('focused'));

  input.addEventListener('keydown', (e) => {
    if (palette.classList.contains('show')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIndex((paletteIndex + 1) % paletteItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIndex((paletteIndex - 1 + paletteItems.length) % paletteItems.length); return; }
      if (e.key === 'Tab') { e.preventDefault(); runPalette(paletteIndex, 'insert'); return; }
      if (e.key === 'Escape') { e.preventDefault(); hidePalette(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runPalette(paletteIndex, 'send'); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); submit(); return; }
    // Escape belongs to Claude: it is how a running turn is interrupted.
    if (e.key === 'Escape') { e.preventDefault(); keyTo('\x1b'); return; }
    // Everything else is ordinary text editing, which the textarea already does. Keep it
    // away from the window-level shortcuts so Ctrl+T and friends don't fire while typing.
    e.stopPropagation();
  });

  // The composer lives inside its own pane, below that pane's terminal.
  pane.el.appendChild(wrap);
  pane.hybridBar = {
    el: wrap, input, submit, undo: doUndo, loadCommands,
    focus: () => input.focus()
  };
  renderAttachments();
  autoGrow();
  // The terminal just lost height to the bar; refit so the PTY matches.
  requestAnimationFrame(() => fitPane(pane));
  return pane.hybridBar;
}
function removeHybridBar(pane) {
  if (!pane || !pane.hybridBar) return;
  pane.hybridBar.el.remove();
  pane.hybridBar = null;
  if (pane.mask) { pane.mask.classList.remove('on'); pane.mask.style.height = '0px'; }
  pane.masked = false;
  pane.everMasked = false;
  pane.hybridRaw = false;
  pane.hybridScraping = false;
  setPaneStdin(pane, true);
  // The terminal just reclaimed the bar's height; refit so the PTY matches.
  requestAnimationFrame(() => fitPane(pane));
}

// Amber border + hint whenever the pane is showing something we deliberately did not
// mask, so it's clear the keyboard is back in the terminal for that moment.
function refreshHybridBar(pane) {
  if (!pane || !pane.hybridBar) return;
  const dialog = !!(pane.claudeRunning && pane.everMasked && !pane.masked && !pane.hybridRaw);
  pane.hybridBar.el.classList.toggle('dialog', dialog);
}

function updateHybrid() {
  for (const [, tab] of tabs) {
    if (tab.type === 'chat' || tab.type === 'editor') continue;
    // One composer per pane running Claude, so both halves of a split get their own.
    for (const [, pane] of tab.panes) {
      if (hybridEnabled && pane.claudeRunning) ensureHybridBar(tab, pane);
      else removeHybridBar(pane);
      updatePaneMask(pane);
      refreshHybridBar(pane);
    }
    maybeLoadHybridCommands(tab);
  }
}

// Reading the list drives a pane's keyboard, so it waits for a moment where that is
// safe: the band is up, Claude is not mid-turn, and its composer is empty. The list is
// the same across a tab's panes, so it is scraped once (from whichever pane is ready)
// and shared via tab.hybridCommands.
function maybeLoadHybridCommands(tab) {
  if (tab.hybridCommands || tab.hybridAutoTried) return;
  for (const [, pane] of tab.panes) {
    if (!pane.hybridBar || !pane.masked || pane.hybridScraping) continue;
    if (Date.now() < (pane.claudeBusyUntil || 0)) continue;
    if (promptRest(pane.term) !== '') continue;
    tab.hybridAutoTried = true;
    pane.hybridBar.loadCommands(false);
    return;
  }
}

if (hybridToggleEl) {
  hybridToggleEl.checked = hybridEnabled;
  hybridToggleEl.addEventListener('change', () => {
    hybridEnabled = !!hybridToggleEl.checked;
    localStorage.setItem(HYBRID_KEY, hybridEnabled ? '1' : '0');
    updateHybrid();
    const tab = activeTab();
    if (!tab) return;
    const pane = getActivePane(tab);
    if (pane && pane.hybridBar) pane.hybridBar.input.focus();
    else if (pane) pane.term.focus();
  });
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
  // Hybrid mode switched the terminal's keyboard off, so focus belongs in this pane's
  // own composer instead.
  if (pane.masked && pane.hybridBar) pane.hybridBar.input.focus();
  if (tab.tabId === activeId) {
    if (!tab.customTitle) setTabTitle(tab, basename(pane.cwd || '') || 'PowerShell');
    updateStatus();
    renderTree();
  }
}

function setActive(tabId) {
  if (!tabs.has(tabId)) return;
  // A tab that lives inside a grid can't be shown on its own — its container is mounted
  // in the grid's cell. Surface the grid and focus that cell instead (covers Ctrl+Tab,
  // openInEditor, history restore, anything that targets a member directly).
  const target = tabs.get(tabId);
  if (target.gridOwner && tabs.has(target.gridOwner)) {
    const g = tabs.get(target.gridOwner);
    if (activeId !== g.tabId) setActive(g.tabId);
    focusGridCell(g, tabId);
    return;
  }
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
  const tab = tabs.get(tabId);
  // A chat tab shown inside the active grid is still on-screen and must count as active,
  // or its view would pause as if backgrounded.
  const gridMemberIds = tab && tab.type === 'grid' ? new Set(tab.members) : null;
  for (const [tid, view] of chatTabs) view.setActive(tid === tabId || !!(gridMemberIds && gridMemberIds.has(tid)));
  updateHybrid();
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
  } else if (tab.type === 'grid') {
    requestAnimationFrame(() => {
      for (const id of tab.members) refitMember(tabs.get(id));
      focusMemberSurface(tab.focusedMember && tabs.get(tab.focusedMember));
    });
  }
  renderTree();
  updateStatus();
  scheduleAgentRender();
  scheduleSaveSession();
}

// Cycle the active tab in visual order. dir = +1 next, -1 previous; wraps around.
function cycleTab(dir) {
  const ids = Array.from(tabs.keys());
  if (ids.length < 2) return;
  const cur = activeId ? ids.indexOf(activeId) : -1;
  const next = (cur + dir + ids.length) % ids.length;
  setActive(ids[next]);
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

// ---------- git branch switcher (status bar) ----------
let branchReqSeq = 0;       // guards against out-of-order async responses
let branchShownCwd;         // cwd the pill currently reflects (undefined = never fetched)
let branchInfo = null;      // last { isRepo, current, detached, branches } or null

function renderBranchPill() {
  statusBranch.classList.remove('error');
  if (!branchInfo || !branchInfo.isRepo) {
    statusBranch.style.display = 'none';
    statusBranchSep.style.display = 'none';
    return;
  }
  const label = branchInfo.detached ? 'detached' : (branchInfo.current || '?');
  statusBranch.textContent = label;
  statusBranch.title = 'Switch branch — on ' + label;
  statusBranch.style.display = '';
  statusBranchSep.style.display = '';
}

// Fetch branches for `cwd` and update the pill. Cheap no-op when cwd unchanged
// (unless force), so it is safe to call from the frequently-run updateStatus().
async function refreshBranch(cwd, force = false) {
  if (!cwd || !window.gitApi) {
    branchShownCwd = cwd || null; branchInfo = null; renderBranchPill();
    return;
  }
  if (!force && cwd === branchShownCwd) { renderBranchPill(); return; }
  const seq = ++branchReqSeq;
  let info = null;
  try { info = await window.gitApi.branches(cwd); } catch { info = null; }
  if (seq !== branchReqSeq) return;           // a newer request superseded this one
  branchShownCwd = cwd;
  branchInfo = (info && info.isRepo) ? info : null;
  renderBranchPill();
}

async function switchBranch(cwd, branch) {
  let res = null;
  try { res = await window.gitApi.switch(cwd, branch); } catch (e) { res = { ok: false, error: String(e) }; }
  if (!res || !res.ok) {
    statusBranch.classList.add('error');
    statusBranch.textContent = 'switch failed';
    statusBranch.title = (res && res.error) || 'git switch failed';
    return;
  }
  refreshBranch(cwd, true);
}

statusBranch.addEventListener('click', async () => {
  if (branchMenuEl && branchMenuEl.classList.contains('show')) { closeBranchMenu(); return; }
  const tab = activeTab();
  const cwd = tab && tab.type !== 'editor' ? tabCwd(tab) : null;
  if (!cwd) return;
  let info = null;
  try { info = await window.gitApi.branches(cwd); } catch { info = null; }
  branchShownCwd = cwd;
  branchInfo = (info && info.isRepo) ? info : null;
  renderBranchPill();
  if (!branchInfo || !branchInfo.branches.length) return;
  openBranchMenu(cwd, branchInfo, statusBranch.getBoundingClientRect());
});

// ---------- filterable branch picker popup ----------
let branchMenuEl = null;
let branchMenuState = null;   // { cwd, current, all[], filtered[], index }

function ensureBranchMenu() {
  if (branchMenuEl) return branchMenuEl;
  const el = document.createElement('div');
  el.className = 'branch-menu';
  el.innerHTML =
    '<input class="branch-search" type="text" placeholder="Search branches…" spellcheck="false" autocomplete="off">' +
    '<div class="branch-action" style="display:none"></div>' +
    '<div class="branch-list"></div>';
  document.body.appendChild(el);
  const input = el.querySelector('.branch-search');
  input.addEventListener('input', () => filterBranchMenu(input.value));
  input.addEventListener('keydown', onBranchMenuKey);
  el.querySelector('.branch-action').addEventListener('click', () => runUpdateMain());
  branchMenuEl = el;
  return el;
}

function openBranchMenu(cwd, info, rect) {
  const el = ensureBranchMenu();
  branchMenuState = {
    cwd, current: info.current, all: info.branches.slice(), filtered: info.branches.slice(),
    index: 0, defaultBranch: info.defaultBranch || null, busy: false
  };
  const input = el.querySelector('.branch-search');
  input.value = '';
  // Pinned "fetch latest main/master" row — only when there is a remote to fetch from.
  if (info.hasRemote && info.defaultBranch) {
    setBranchAction(null, 'Fetch latest ' + info.defaultBranch);
  } else {
    el.querySelector('.branch-action').style.display = 'none';
  }
  renderBranchMenuList();
  el.classList.add('show');
  // Status bar sits at the bottom, so anchor the menu's bottom just above the pill.
  const menuRect = el.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(rect.left, window.innerWidth - menuRect.width - 6)) + 'px';
  el.style.top = '';
  el.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  input.focus();
}

function closeBranchMenu() {
  if (branchMenuEl) branchMenuEl.classList.remove('show');
  branchMenuState = null;
}

function filterBranchMenu(q) {
  if (!branchMenuState) return;
  const f = (q || '').trim().toLowerCase();
  branchMenuState.filtered = f
    ? branchMenuState.all.filter((b) => b.toLowerCase().includes(f))
    : branchMenuState.all.slice();
  branchMenuState.index = 0;
  renderBranchMenuList();
}

function renderBranchMenuList() {
  if (!branchMenuEl || !branchMenuState) return;
  const list = branchMenuEl.querySelector('.branch-list');
  list.innerHTML = '';
  const { filtered, current, index } = branchMenuState;
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'branch-empty';
    empty.textContent = 'No matching branch';
    list.appendChild(empty);
    return;
  }
  filtered.forEach((b, i) => {
    const item = document.createElement('div');
    item.className = 'branch-item' + (i === index ? ' sel' : '') + (b === current ? ' current' : '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = b;
    item.appendChild(name);
    if (b === current) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'current';
      item.appendChild(tag);
    }
    item.addEventListener('mouseenter', () => { branchMenuState.index = i; markBranchSel(); });
    item.addEventListener('mousedown', (e) => { e.preventDefault(); pickBranch(i); });
    list.appendChild(item);
  });
  scrollBranchSelIntoView();
}

function markBranchSel() {
  if (!branchMenuEl || !branchMenuState) return;
  Array.from(branchMenuEl.querySelectorAll('.branch-item'))
    .forEach((n, i) => n.classList.toggle('sel', i === branchMenuState.index));
}

function scrollBranchSelIntoView() {
  if (!branchMenuEl || !branchMenuState) return;
  const node = branchMenuEl.querySelectorAll('.branch-item')[branchMenuState.index];
  if (node) node.scrollIntoView({ block: 'nearest' });
}

function onBranchMenuKey(e) {
  if (!branchMenuState) return;
  const n = branchMenuState.filtered.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (n) { branchMenuState.index = (branchMenuState.index + 1) % n; markBranchSel(); scrollBranchSelIntoView(); }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (n) { branchMenuState.index = (branchMenuState.index - 1 + n) % n; markBranchSel(); scrollBranchSelIntoView(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pickBranch(branchMenuState.index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeBranchMenu();
  }
}

function pickBranch(i) {
  if (!branchMenuState) return;
  const b = branchMenuState.filtered[i];
  if (!b) return;
  const { cwd, current } = branchMenuState;
  closeBranchMenu();
  if (b !== current) switchBranch(cwd, b);
}

// Render the pinned fetch row. kind: null | 'spin' | 'ok' | 'error'.
function setBranchAction(kind, text) {
  const row = branchMenuEl && branchMenuEl.querySelector('.branch-action');
  if (!row) return;
  row.className = 'branch-action' + (kind ? ' ' + kind : '');
  row.title = text || '';
  row.textContent = '';
  const ic = document.createElement('span');
  ic.className = 'ba-ic';
  ic.textContent = kind === 'ok' ? '✓' : kind === 'error' ? '!' : '⟳';
  const tx = document.createElement('span');
  tx.className = 'ba-tx';
  tx.textContent = text;
  row.appendChild(ic);
  row.appendChild(tx);
  row.style.display = '';
}

async function runUpdateMain() {
  if (!branchMenuState || branchMenuState.busy) return;
  const { cwd, defaultBranch } = branchMenuState;
  if (!defaultBranch) return;
  branchMenuState.busy = true;
  setBranchAction('spin', 'Fetching ' + defaultBranch + '…');
  let res = null;
  try { res = await window.gitApi.updateMain(cwd); } catch (e) { res = { ok: false, error: String(e) }; }
  if (!branchMenuState) return;              // menu closed while fetching
  branchMenuState.busy = false;
  if (!res || !res.ok) {
    setBranchAction('error', (res && res.error) ? firstLine(res.error) : 'fetch failed');
    if (res && res.error) branchMenuEl.querySelector('.branch-action').title = res.error;
    return;
  }
  const b = res.branch || defaultBranch;
  setBranchAction('ok', res.updated ? ('Updated ' + b + ' to latest') : (b + ' already up to date'));
  if (res.message) branchMenuEl.querySelector('.branch-action').title = res.message;
  // Reflect any new commits in the pill and the open list's current marker.
  refreshBranch(cwd, true);
  try {
    const info = await window.gitApi.branches(cwd);
    if (branchMenuState && info && info.isRepo) {
      branchMenuState.current = info.current;
      branchMenuState.all = info.branches.slice();
      filterBranchMenu(branchMenuEl.querySelector('.branch-search').value);
    }
  } catch { /* ignore */ }
}

function firstLine(s) {
  return (s || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
}

document.addEventListener('mousedown', (e) => {
  if (branchMenuEl && branchMenuEl.classList.contains('show') &&
      !e.target.closest('.branch-menu') && !e.target.closest('.status-branch')) closeBranchMenu();
});
window.addEventListener('blur', closeBranchMenu);
window.addEventListener('resize', closeBranchMenu);

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
    // Proportional grow (basis 0), not fixed px: the ratio is what we want to keep, so
    // the panes still fill — and keep filling — when the window grows. Fixed-px flex
    // would freeze them at a max size and leave dead space beside a larger window.
    beforeEl.style.flex = `${Math.round(nb)} 1 0`;
    afterEl.style.flex  = `${Math.round(drag.available - nb)} 1 0`;
  });
  const end = (e) => {
    if (!drag) return;
    try { resizerEl.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
    resizerEl.classList.remove('dragging');
    document.body.classList.remove('resizing-pane', 'resizing-pane-h', 'resizing-pane-v');
    fitAll();
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
  // The xterm lives in its own framed box; this pane's composer is appended to paneEl
  // later as a sibling below it, so the composer sits under the terminal, not inside its
  // frame. The mask stays a child of paneEl (its offset is measured live), so its
  // geometry is unaffected by this wrapper.
  const termWrap = document.createElement('div');
  termWrap.className = 'pane-term';
  paneEl.appendChild(termWrap);
  term.open(termWrap);
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
    // Hybrid input: the band over Claude's own composer box, whether it is currently
    // drawn, and whether xterm's keyboard is switched off behind it.
    mask: null, masked: false, everMasked: false, stdinOff: false, hybridRaw: false,
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
  // (xterm textarea also fires paste; we drive paste explicitly via term.paste above).
  // The per-pane Claude composer lives inside this same paneEl, so let its own
  // textarea keep the native paste instead of hijacking it into the terminal.
  paneEl.addEventListener('paste', (e) => {
    if (e.target && e.target.closest && e.target.closest('.hybrid-wrap')) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (t) term.paste(t);
    term.focus();
  }, true);

  // A logical line the terminal soft-wrapped spans several buffer rows: the first row
  // is full width and each continuation row carries isWrapped=true. Link matching has
  // to run over the JOINED text — otherwise a URL split across two rows only matches
  // the fragment on whichever row the mouse is over. readWrappedBlock walks back to the
  // row where the logical line starts, concatenates the full-width rows into one string,
  // and hands back a coord() that maps a string offset to an xterm cell {x,y}. Rows are
  // read untrimmed so every row contributes exactly `cols` chars and offset→cell is a
  // straight division — a link range can therefore span rows (start.y !== end.y).
  function readWrappedBlock(lineNum) {
    const buf = term.buffer.active;
    const cols = term.cols;
    let start = lineNum - 1;
    if (start < 0) return null;
    while (start > 0) {
      const cur = buf.getLine(start);
      if (cur && cur.isWrapped) start--; else break;
    }
    const first = buf.getLine(start);
    if (!first) return null;
    let text = first.translateToString(false);
    let idx = start;
    while (true) {
      const next = buf.getLine(idx + 1);
      if (next && next.isWrapped) { text += next.translateToString(false); idx++; }
      else break;
    }
    return {
      text,
      // offset is 0-based into text; xterm cells are 1-based, y is a 1-based line number.
      coord(offset) { return { x: (offset % cols) + 1, y: start + Math.floor(offset / cols) + 1 }; }
    };
  }

  // File path links: left-click → external editor. The leading lookbehind keeps the
  // drive-letter alternative from matching a URL scheme's tail (the "s:/" in
  // "https://…"), which the URL provider below owns instead.
  const FILE_LINK_RE = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\.\.?[\\/])[\w\\/.\-]+(\.[\w]{1,6})\b/g;
  let hoveredFilePath = null;
  term.registerLinkProvider({
    provideLinks(lineNum, callback) {
      const block = readWrappedBlock(lineNum);
      if (!block) { callback(undefined); return; }
      FILE_LINK_RE.lastIndex = 0;
      const links = [];
      let m;
      while ((m = FILE_LINK_RE.exec(block.text)) !== null) {
        const fp = m[0];
        links.push({
          range: { start: block.coord(m.index), end: block.coord(m.index + fp.length - 1) },
          text: fp,
          activate(_, linkText) { window.fileApi.openExternal(linkText); },
          hover(_, linkText) { hoveredFilePath = linkText; },
          leave() { hoveredFilePath = null; }
        });
      }
      callback(links.length ? links : undefined);
    }
  });

  // URL links: left-click → default browser, opening the WHOLE url (scheme, host,
  // path, query and fragment) rather than just the origin.
  const URL_LINK_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;
  const URL_TRIM = '.,;:!?\'")]}>';
  term.registerLinkProvider({
    provideLinks(lineNum, callback) {
      const block = readWrappedBlock(lineNum);
      if (!block) { callback(undefined); return; }
      URL_LINK_RE.lastIndex = 0;
      const links = [];
      let m;
      while ((m = URL_LINK_RE.exec(block.text)) !== null) {
        // Drop trailing punctuation that is almost always sentence, not URL.
        let url = m[0];
        let end = url.length;
        while (end > 0 && URL_TRIM.includes(url[end - 1])) end--;
        url = url.slice(0, end);
        if (!url) continue;
        links.push({
          range: { start: block.coord(m.index), end: block.coord(m.index + url.length - 1) },
          text: url,
          activate(_, linkText) {
            const href = /^www\./i.test(linkText) ? 'https://' + linkText : linkText;
            window.fileApi.openExternal(href);
          }
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

  // Hybrid input's band. Always in the DOM, sized and shown only while hybrid mode is
  // on and the pane is running claude.
  const mask = document.createElement('div');
  mask.className = 'pane-mask';
  paneEl.appendChild(mask);
  pane.mask = mask;

  // The band has to follow whatever the TUI just drew, so it is driven off renders
  // rather than a timer.
  term.onRender(() => updatePaneMask(pane));

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

  // Resize observer per pane. Watch the terminal element, not the pane box: when a
  // per-pane composer appears, grows, or closes, the pane box is unchanged but the
  // terminal's height shifts — observing it keeps cols/rows in step with those too.
  let roTimer = null;
  pane.ro = new ResizeObserver(() => {
    clearTimeout(roTimer);
    roTimer = setTimeout(() => fitPane(pane), 16);
  });
  pane.ro.observe(term.element || paneEl);

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
  // The split takes over the slot the pane held, so it must inherit that slot's flex —
  // otherwise a nested split collapses to content width and leaves dead space beside it.
  splitEl.style.flex = pane.el.style.flex || '1 1 0';
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
  // Both panes just changed width/height; xterm cols/rows only follow if we refit. The
  // ResizeObserver is debounced and can miss the mid-surgery reflow, so refit explicitly
  // across two frames once layout has settled.
  requestAnimationFrame(() => {
    for (const [, p] of tab.panes) fitPane(p);
    requestAnimationFrame(() => { for (const [, p] of tab.panes) fitPane(p); });
  });
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

// ---------- Grid (dashboard) tab ----------
// A grid tab is a non-destructive layout: it BORROWS other tabs' live .term-container
// nodes into a CSS grid of cells, so several tabs are visible and running at once.
// Nothing is duplicated — the container is a single live DOM node that is moved into a
// cell and moved back to the stage when the cell is removed or the grid closed, so the
// borrowed tab keeps its PTY, scrollback and composer exactly as before. The focused
// cell is the "working tab" (see activeTab()), so Explorer/status follow it.
function gridColsFor(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function createGridTab() {
  const tabId = newTabId();

  const container = document.createElement('div');
  container.className = 'term-container grid-container';
  areaEl.appendChild(container);

  const stage = document.createElement('div');
  stage.className = 'grid-stage';
  container.appendChild(stage);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = tabInnerHtml('grid', 'Grid');
  tabsEl.appendChild(tabEl);
  const titleEl = tabEl.querySelector('.tab-title');
  const closeEl = tabEl.querySelector('.tab-close');

  const tab = {
    tabId, container, tabEl, titleEl, stage,
    title: 'Grid', customTitle: null, color: null,
    type: 'grid', members: [], focusedMember: null,
    panes: new Map(), activePaneId: null,
    expandedPaths: new Set(), selectedPath: null
  };
  tabs.set(tabId, tab);

  wireTabPointer(tabEl, tabId);
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId); });
  titleEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tab); });
  tabEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tab-rename-input')) return;
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', shortcut: 'F2', action: () => startRename(tab) },
      { label: 'Add a tab…', action: () => pickTabForGrid(tab) },
      { separator: true },
      { swatches: availableColorsForTab(tab), selected: tab.color || null, onPick: (c) => setTabColor(tab, c.value) },
      { separator: true },
      { label: 'Close grid', action: () => closeTab(tabId) }
    ]);
  });

  const autoColor = pickRandomUnusedColor();
  if (autoColor) setTabColor(tab, autoColor);

  setActive(tabId);
  renderGrid(tab);
  updateStatus();
  return tab;
}

// Deal n cells into `cols` columns as evenly as possible, giving the leftover cells to
// the earlier columns. e.g. (3,2) -> [2,1]: two cells stack in the left column, the lone
// third fills the right column's full height. (5,3) -> [2,2,1].
function gridColSizes(n, cols) {
  const base = Math.floor(n / cols);
  const extra = n % cols;
  const sizes = [];
  for (let i = 0; i < cols; i++) sizes.push(base + (i < extra ? 1 : 0));
  return sizes;
}

function buildGridCell(tab, id) {
  const m = tabs.get(id);
  const cell = document.createElement('div');
  cell.className = 'grid-cell' + (id === tab.focusedMember ? ' focused' : '');
  cell.dataset.member = id;

  const hdr = document.createElement('div');
  hdr.className = 'grid-cell-hdr';
  const dot = document.createElement('span');
  dot.className = 'gc-dot';
  if (m.color) dot.style.setProperty('--gc-color', m.color);
  const title = document.createElement('span');
  title.className = 'gc-title';
  title.textContent = m.customTitle || tabAutoName(m);
  const pop = document.createElement('span');
  pop.className = 'gc-btn'; pop.title = 'Open as full tab (remove from grid)';
  pop.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3 1h6v6M9 1L4 6M4 3H1v6h6V6" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  pop.addEventListener('click', (e) => { e.stopPropagation(); removeFromGrid(tab, id, true); });
  const rm = document.createElement('span');
  rm.className = 'gc-btn'; rm.title = 'Remove from grid';
  rm.innerHTML = closeSvg();
  rm.addEventListener('click', (e) => { e.stopPropagation(); removeFromGrid(tab, id, false); });
  hdr.append(dot, title, pop, rm);

  cell.appendChild(hdr);
  m.container.classList.add('in-grid');
  cell.appendChild(m.container);
  cell.addEventListener('mousedown', () => focusGridCell(tab, id));
  return cell;
}

// Rebuild the cell chrome from tab.members, re-mounting each member's live container.
// stage.innerHTML is cleared first, which only detaches the (still-live) containers; they
// are appended straight back into their new cells below.
function renderGrid(tab) {
  const stage = tab.stage;
  stage.innerHTML = '';
  tab.members = tab.members.filter((id) => tabs.has(id));
  const members = tab.members;
  if (!members.includes(tab.focusedMember)) tab.focusedMember = members[0] || null;

  if (!members.length) {
    const empty = document.createElement('div');
    empty.className = 'grid-empty grid-drop-zone';
    empty.textContent = 'Drag active tabs here to build a grid — or click to pick one';
    empty.addEventListener('click', () => pickTabForGrid(tab));
    stage.appendChild(empty);
    return;
  }

  const cols = Math.min(gridColsFor(members.length), members.length);
  const sizes = gridColSizes(members.length, cols);
  let idx = 0;
  for (let c = 0; c < cols; c++) {
    const col = document.createElement('div');
    col.className = 'grid-col';
    for (let r = 0; r < sizes[c] && idx < members.length; r++) {
      col.appendChild(buildGridCell(tab, members[idx++]));
    }
    stage.appendChild(col);
  }

  requestAnimationFrame(() => { for (const id of members) refitMember(tabs.get(id)); });
}

// Bring a member's terminal/editor/chat back in step with the cell size it now occupies.
function refitMember(m) {
  if (!m) return;
  if (m.type === 'editor') { try { m.editor?.layout(); } catch (_) {} return; }
  for (const [, pane] of m.panes) {
    try { pane.fit.fit(); window.term.resize(pane.ptyId, pane.term.cols, pane.term.rows); } catch (_) {}
  }
}
function focusMemberSurface(m) {
  if (!m) return;
  if (m.type === 'editor') { try { m.editor?.focus(); } catch (_) {} return; }
  if (m.type === 'chat') { const v = chatTabs.get(m.tabId); if (v) v.focus(); return; }
  const p = getActivePane(m);
  if (p) p.term.focus();
}

function focusGridCell(tab, id) {
  if (tab.type !== 'grid' || !tabs.has(id)) return;
  // Every mousedown inside a cell bubbles here; only do the (async, FS-touching) refocus
  // work when the focused cell actually changes.
  if (tab.focusedMember === id) return;
  tab.focusedMember = id;
  for (const cell of tab.stage.querySelectorAll('.grid-cell')) {
    cell.classList.toggle('focused', cell.dataset.member === id);
  }
  renderTree();
  updateStatus();
  focusMemberSurface(tabs.get(id));
}

// Mount a tab into the grid. Non-destructive: only moves the live container node.
function addToGrid(tab, memberId) {
  if (!tab || tab.type !== 'grid') return;
  const m = tabs.get(memberId);
  if (!m || m.type === 'grid' || memberId === tab.tabId) return;
  if (m.gridOwner) {                       // already gridded — focus it where it lives
    const g = tabs.get(m.gridOwner);
    if (g) { setActive(g.tabId); focusGridCell(g, memberId); }
    return;
  }
  m.gridOwner = tab.tabId;
  m.tabEl.classList.add('in-grid-chip');
  tab.members.push(memberId);
  tab.focusedMember = memberId;
  // A chat member shown in the active grid counts as on-screen.
  const v = chatTabs.get(memberId);
  if (v && activeId === tab.tabId) v.setActive(true);
  renderGrid(tab);
  renderTree();
  updateStatus();
  scheduleSaveSession();
}

// Detach a member from the grid, returning its container to the stage exactly as before.
// asFull=true also switches to it as a standalone tab.
function removeFromGrid(tab, memberId, asFull) {
  const idx = tab.members.indexOf(memberId);
  if (idx !== -1) tab.members.splice(idx, 1);
  const m = tabs.get(memberId);
  if (m) {
    delete m.gridOwner;
    m.tabEl.classList.remove('in-grid-chip');
    m.container.classList.remove('in-grid');
    areaEl.appendChild(m.container);       // home — hidden until it (or the grid) is active
    // Back in the pool and off-screen unless it's about to become the active tab.
    const v = chatTabs.get(memberId);
    if (v && !asFull) v.setActive(false);
  }
  renderGrid(tab);
  if (asFull && m) {
    setActive(memberId);
  } else {
    renderTree();
    updateStatus();
    scheduleSaveSession();
  }
}

// Menu of tabs not yet in any grid, for click-to-add on the empty grid / context menu.
function pickTabForGrid(tab) {
  const items = [];
  for (const [id, t] of tabs) {
    if (t.type === 'grid' || t.gridOwner || id === tab.tabId) continue;
    items.push({
      label: t.customTitle || tabAutoName(t),
      hint: t.type || 'terminal',
      action: () => { setActive(tab.tabId); addToGrid(tab, id); }
    });
  }
  if (!items.length) {
    items.push({ label: 'No free tabs — open more first', disabled: true, action: () => {} });
  }
  const r = tab.stage.getBoundingClientRect();
  showContextMenu(r.left + 24, r.top + 24, items);
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

// Same idea for the model: a chat pane always passes --model, so settings.json has to
// be read or a CLI configured for `opus[1m]` would quietly become a 200k pane here.
const CHAT_MODEL_IDS = ['opus', 'sonnet', 'haiku', 'fable'];
// Haiku is the one family the CLI has no 1M variant for.
const ONE_M_MODEL_IDS = new Set(['opus', 'sonnet', 'fable']);
let cliDefaultModel = 'opus';

function normalizeChatModel(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const oneM = /\[1m\]/.test(value);
  const bare = value.replace(/\[1m\]/g, '');
  // An exact model id is already what --model wants; don't collapse it to its alias,
  // or a CLI pinned to `claude-opus-4-8` would silently jump to the newest Opus.
  if (/^claude-/.test(bare)) return bare + (oneM ? '[1m]' : '');
  let id = CHAT_MODEL_IDS.find((k) => bare === k);
  // `opusplan` swaps models per mode, which a chat pane can't mirror — take the Opus half.
  if (!id && bare === 'opusplan') id = 'opus';
  if (!id) id = CHAT_MODEL_IDS.find((k) => bare.includes(k));
  if (!id) return null;
  return id + (oneM && ONE_M_MODEL_IDS.has(id) ? '[1m]' : '');
}

function defaultChatModel() {
  return cliDefaultModel;
}

// Exact model ids the account may use, newest first — the source for the model menu's
// "older versions" entries. Fetched once (cached in the main process) rather than
// hardcoded, so a new release doesn't have to be shipped here to show up.
let pinnedModels = [];

async function refreshChatModels() {
  try {
    const res = await window.claudeApi.models();
    if (res && Array.isArray(res.models) && res.models.length) pinnedModels = res.models;
  } catch (_) {}
  for (const [, view] of chatTabs) view.setModels(pinnedModels);
}

async function createChatTab(opts = {}) {
  const tabId = newTabId();
  const chatId = 'chat-' + (++chatSeq);
  const cwd = opts.cwd || tabCwd(activeTab()) || undefined;

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
    model: opts.model || defaultChatModel(),
    permissionMode,
    pinnedModels: pinnedModels,
    helpers: { formatTokens, contextWindowFor, shortModelLabel, modelIsNativeOneM },
    showMenu: (x, y, items) => showContextMenu(x, y, items),
    commands: chatPaletteCommands(tab),
    customCommands: {
      list: getCustomCommands,
      expand: expandCustomCommand,
      manage: openCustomCommands
    },
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
    onRestart: () => restartChat(tab, view.model),
    onRefreshLimits: (force) => refreshPlanLimits(force)
  });
  chatTabs.set(tabId, view);
  container.appendChild(view.el);
  view.setActive(true);
  // Seed the pane from the last poll so a new tab isn't blank until the next tick.
  if (planLimits) view.setLimits(planLimits);
  refreshPlanLimits();
  if (!pinnedModels.length) refreshChatModels();

  setActive(tabId);
  updateStatus();

  const res = await window.chatApi.start({
    chatId, cwd,
    model: opts.model || defaultChatModel(),
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
      run: () => { const t = activeTab(); if (t && t.panes.size) splitPane(t, t.activePaneId, 'h'); }
    },
    {
      cmd: '/split-down', desc: 'Split the active pane downward', key: 'Ctrl+Shift+D',
      run: () => { const t = activeTab(); if (t && t.panes.size) splitPane(t, t.activePaneId, 'v'); }
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
  // Resuming a session that has no transcript yet (model switched before the first
  // message) makes the CLI exit with "No conversation found".
  const resumeSessionId = view.getState().canResume
    ? (view.sessionId || tab.chatSessionId || null)
    : null;
  // `replace` lets the main process retire the old process itself, so its exit is not
  // reported as this pane dying right after the new one came up.
  const res = await window.chatApi.start({
    chatId: tab.chatId, cwd: tab.cwd || undefined, replace: true,
    model: model || defaultChatModel(), resumeSessionId,
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

  // Closing a grid never touches its members — hand each live container back to the
  // stage, then remove only the grid shell. The members live on exactly as before.
  if (tab.type === 'grid') {
    for (const id of [...tab.members]) {
      const m = tabs.get(id);
      if (!m) continue;
      delete m.gridOwner;
      m.tabEl.classList.remove('in-grid-chip');
      m.container.classList.remove('in-grid');
      areaEl.appendChild(m.container);
    }
    tab.container.remove(); tab.tabEl.remove(); tabs.delete(tabId);
    if (wasActive) { activeId = null; const n = pickNextActive(); if (n) setActive(n); else window.win.close(); }
    updateStatus(); scheduleAgentRender(); scheduleSaveSession(); return;
  }

  // A tab that is currently displayed inside a grid: drop its cell first so the grid
  // reflows (its container is removed by the normal close paths below).
  if (tab.gridOwner) {
    const g = tabs.get(tab.gridOwner);
    if (g && g.type === 'grid') {
      const i = g.members.indexOf(tabId);
      if (i !== -1) g.members.splice(i, 1);
      tab.container.classList.remove('in-grid');
      renderGrid(g);
    }
    delete tab.gridOwner;
  }

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
  const t = activeTab();
  if (!t) return;
  const pane = getActivePane(t);
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
  const t = activeTab();
  return t ? (chatTabs.get(t.tabId) || null) : null;
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
  const tab = activeTab();
  if (!tab) {
    treeRootEl.style.display = 'none';
    treeEl.innerHTML = '<div class="wt-empty">No active tab</div>';
    return;
  }
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
  const cwd = tabCwd(activeTab());
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
  const tab = activeTab();
  if (!tab) return;
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
  requestAnimationFrame(() => { agentRenderQueued = false; renderAgentPanel(); updateHybrid(); });
}
function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'k';
  return String(n);
}
// A model can reach 1M two independent ways: it is *natively* a 1M model, or the CLI's
// `[1m]` beta alias extends an older 200k model. `[1m]` shows up as the alias suffix
// (`opus[1m]`, `claude-sonnet-5[1m]`) or as the `(1M context)` label the CLI prints;
// bare "1m" is anchored so it doesn't hit ids that merely contain those characters.
function modelHasOneMFlag(model) {
  return /\[1m\]|\b1m\b|\(1M context\)/i.test(String(model || ''));
}
// Native 1M window by family + version: every current family except Haiku ships 1M by
// default — Opus/Sonnet from 4.6 on, Fable/Mythos from 5 on. Older versions and all
// Haiku stay at 200k. A bare family alias (`opus`, no version) tracks the newest
// release, so it inherits that family's 1M default (again, except haiku).
function modelIsNativeOneM(model) {
  const s = String(model || '').toLowerCase();
  const v = s.match(/(opus|sonnet|haiku|fable|mythos)[-\s]?(\d+)(?:[-.\s](\d+))?/);
  if (v) {
    const family = v[1], maj = +v[2], min = v[3] ? +v[3] : 0;
    if (family === 'haiku') return false;
    if (family === 'fable' || family === 'mythos') return maj >= 5;
    return maj > 4 || (maj === 4 && min >= 6); // opus & sonnet went 1M-native at 4.6
  }
  if (/\bhaiku\b/.test(s)) return false;
  return /\b(opus|sonnet|fable|mythos)\b/.test(s);
}
function contextWindowFor(model) {
  if (!model) return 200000;
  return (modelHasOneMFlag(model) || modelIsNativeOneM(model)) ? 1000000 : 200000;
}
function shortModelLabel(model) {
  if (!model) return '';
  // The window size is shown next to this label, so the 1M marker is dropped here.
  const bare = String(model).replace(/\[1m\]/gi, '');
  if (/^(opus|sonnet|haiku|fable|default)/i.test(bare))
    return bare.replace(/\s*\((?:1M|200k)\s*context\)/i, '').trim();
  const x = bare.toLowerCase().match(/claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/);
  if (x) {
    const family = x[1].charAt(0).toUpperCase() + x[1].slice(1);
    return family + ' ' + (x[3] ? `${x[2]}.${x[3]}` : x[2]);
  }
  return bare;
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

// Terminal is the default resume surface now — it's what's used most. Both types
// resume by relaunching the CLI with --resume in a fresh shell. The native chat view
// stays available for Claude as a secondary choice in the row's context menu.
function resumeSavedSession(s, type) {
  createTab({ cwd: s.cwd, runOnReady: resumeCommandFor(type, s.id) });
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
        { label: 'Resume', hint: 'terminal', badge: type === 'claude' ? 'C' : 'GH',
          action: () => resumeSavedSession(s, type) }
      ];
      if (type === 'claude') {
        items.push({ label: 'Resume in chat', hint: 'chat', badge: 'C',
          action: () => createChatTab({ cwd: s.cwd, resumeSessionId: s.id }) });
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

// ---------- plan limits (5-hour + weekly) ----------
// One poll for the whole window: the main process caches, and every chat pane plus the
// status bar reads the same answer. `null` means "nothing to show" — API-key auth, a
// Bedrock/Vertex setup, or a first request that hasn't landed yet.
let planLimits = null;
let planLimitsAt = 0;

async function refreshPlanLimits(force = false) {
  const now = Date.now();
  // A rate-limit event or a click can jump the queue, but not spam the endpoint.
  if (now - planLimitsAt < (force ? 20000 : 55000)) return;
  planLimitsAt = now;
  let next = null;
  try {
    const res = await window.claudeApi.limits(force);
    if (res && !res.unavailable && (res.session || res.weekly)) next = res;
  } catch (_) {}
  planLimits = next;
  for (const [, view] of chatTabs) view.setLimits(planLimits);
  updateStatusLimits();
}

function limitLevel(entry) {
  if (!entry) return '';
  if (entry.percent >= 90 || entry.severity === 'exhausted') return 'danger';
  if (entry.percent >= 75 || entry.severity === 'warning') return 'warn';
  return '';
}

function updateStatusLimits() {
  if (!statusLimitsEl) return;
  const lim = planLimits;
  if (statusLimitsSepEl) statusLimitsSepEl.style.display = lim ? '' : 'none';
  if (!lim) { statusLimitsEl.textContent = ''; statusLimitsEl.title = ''; return; }
  const parts = [];
  const tips = [];
  const stamp = (entry) => {
    if (!entry || !entry.resetsAt) return '';
    const t = new Date(entry.resetsAt);
    if (isNaN(t.getTime())) return '';
    return ' · resets ' + t.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  };
  if (lim.session) { parts.push(`5h ${lim.session.percent}%`); tips.push(`Session (5h): ${lim.session.percent}% used${stamp(lim.session)}`); }
  if (lim.weekly) { parts.push(`wk ${lim.weekly.percent}%`); tips.push(`Week: ${lim.weekly.percent}% used${stamp(lim.weekly)}`); }
  for (const s of lim.scoped || []) {
    if (!s.percent) continue;
    parts.push(`${s.key} ${s.percent}%`);
    tips.push(`${s.label}: ${s.percent}% used${stamp(s)}`);
  }
  statusLimitsEl.textContent = parts.join(' · ');
  statusLimitsEl.title = tips.join('\n');
  const level = limitLevel(lim.session) === 'danger' || limitLevel(lim.weekly) === 'danger' ? 'danger'
    : limitLevel(lim.session) === 'warn' || limitLevel(lim.weekly) === 'warn' ? 'warn'
    : '';
  statusLimitsEl.className = 'status-limits' + (level ? ' ' + level : '');
}

setInterval(() => { if (!document.hidden) refreshPlanLimits(); }, 60000);
window.addEventListener('focus', () => refreshPlanLimits());
refreshPlanLimits();

setInterval(refreshClaudeUsage, 2000);
setInterval(refreshCopilotUsage, 2000);
// Chat panes count too: their cards mirror pane state that changes between the
// state-change callbacks (and a dropped animation frame would otherwise leave a card
// showing the previous model's context window).
setInterval(() => {
  if (getAllAgentPanes().length > 0 || chatTabs.size > 0) { renderAgentPanel(); checkAgentNotifications(); }
}, 400);
renderAgentPanel();
renderClaudeSessions();

// A minimized or background window can also drop the pinning writes, and unlike a tab
// switch nothing calls setActive when it comes back.
function catchUpActiveChatScroll() {
  const t = activeTab();
  const view = t && chatTabs.get(t.tabId);
  if (view) view.catchUpScroll();
}
window.addEventListener('focus', catchUpActiveChatScroll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) catchUpActiveChatScroll();
});

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

const newGridBtn = document.getElementById('new-grid');
if (newGridBtn) newGridBtn.addEventListener('click', () => createGridTab());

const newTabBtn = document.getElementById('new-tab');
newTabBtn.addEventListener('click', () => createTab());
newTabBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const cwd = tabCwd(activeTab());
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

// Tell main which context has focus. A real text field (composer, rename box) does
// Notepad-style undo/redo natively, so main leaves Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z alone
// there. xterm's own hidden textarea does NOT count — the terminal has already sent its
// keys to the PTY and needs our chunk-undo instead.
function activeIsNativeUndoField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  if (el.classList.contains('xterm-helper-textarea')) return false;
  if (el.closest && el.closest('.xterm')) return false;
  if (el.readOnly || el.disabled) return false;
  return true;
}
function syncTextFieldFocus() {
  window.shortcuts?.setTextFieldFocus?.(activeIsNativeUndoField());
}
document.addEventListener('focusin', syncTextFieldFocus);
// focusout lands before the next focusin, so read the new target on the next frame.
document.addEventListener('focusout', () => requestAnimationFrame(syncTextFieldFocus));
syncTextFieldFocus();

// Ctrl+Z arrives via IPC from the main process (before-input-event), bypassing menu
// accelerators and xterm's textarea. Apply chunk-level undo to the active pane.
// (Only fires when no native-undo text field has focus — main skips it otherwise.)
window.shortcuts?.onCtrlZ?.(() => {
  const tab = activeTab();
  if (!tab || tab.type === 'editor') return;
  if (tab.type === 'chat') {
    const view = chatTabs.get(tab.tabId);
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
  // A pane composer normally keeps Ctrl+Z (main won't forward it), but if it ever
  // arrives here, hand it to that textarea's native undo rather than the pane's PTY.
  for (const [, p] of tab.panes) {
    if (p.hybridBar && document.activeElement === p.hybridBar.input) { p.hybridBar.undo(); return; }
  }
  const pane = getActivePane(tab);
  if (!pane) return;
  const chunk = popUndoChunk(pane);
  if (!chunk) return;
  const n = visibleLength(chunk);
  if (n > 0) window.term.input(pane.ptyId, '\x7f'.repeat(n));
});

// ---------- keyboard shortcuts ----------
// Ctrl+Tab / Ctrl+Shift+Tab cycle tabs. Capture phase so it fires before xterm's
// textarea and the composer swallow the key — otherwise it only works once, until
// focus lands back outside a terminal/chat pane.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'Tab' || e.code === 'Tab')) {
    e.preventDefault();
    e.stopPropagation();
    cycleTab(e.shiftKey ? -1 : 1);
  }
}, true);

window.addEventListener('keydown', (e) => {
  // Ctrl+` toggles a chat pane's terminal drawer. Handled before the field guard so
  // it also works from inside the composer and from the drawer's own shell.
  if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '`' || e.code === 'Backquote')) {
    const t = activeTab();
    if (t && t.type === 'chat') {
      e.preventDefault();
      const view = chatTabs.get(t.tabId);
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
    const cwd = tabCwd(activeTab());
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
    const t = activeTab();
    if (t && t.panes.size) splitPane(t, t.activePaneId, 'v');
  }
});

// Ctrl+Shift+R arrives via IPC from the main process — it preventDefaults the key to
// block Chromium's force-reload, so the DOM keydown above never fires. Mirror the old
// field guard: no split while a text field owns focus.
window.shortcuts?.onSplitH?.(() => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const t = activeTab();
  if (t && t.panes.size) splitPane(t, t.activePaneId, 'h');
});

// ---------- session persistence ----------
let _sessionReady = false;
let saveTimer = null;
function saveSession() {
  const tabsData = [];
  let activeIndex = -1;
  let i = 0;
  for (const [id, t] of tabs) {
    // Grids are a transient layout over other tabs; their members persist on their own,
    // so the grid shell itself is not saved (v1).
    if (t.type === 'grid') continue;
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
  // Same for the model, so a settings.json of `opus[1m]` gives a 1M pane, not a 200k one.
  try {
    const r = await window.claudeApi.defaultModel();
    const id = normalizeChatModel(r && r.model);
    if (id) cliDefaultModel = id;
  } catch (_) {}
  // Not awaited: the menu only needs it by the time it is opened.
  refreshChatModels();
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
            model: t.chatModel || defaultChatModel(),
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
