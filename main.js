// ===== Error capture: keep this block FIRST, before any other require =====
// Mac Code's own errors are recorded to errors.log and turned into notes in the Mac-Code
// repo (see errorNotes.js). Registered this early so an error thrown while the remaining
// modules load is still caught. (A SyntaxError inside main.js or errorNotes.js itself
// can't be: nothing has run yet.) Nothing in here may ever throw.
const errorNotes = require('./errorNotes');
const errFs = require('fs');
const errPath = require('path');
const errState = { rendererReady: false, busy: false, wc: null, nameSet: false, childWired: false };
const ERR_LOG_MAX = 1024 * 1024;
const ERR_ENTRY_MAX = 64 * 1024;
const ERR_PENDING_MAX = 50;

function errUserData() {
  try {
    const { app } = require('electron');
    if (errState.nameSet || app.commandLine.hasSwitch('user-data-dir')) return app.getPath('userData');
    // Before app.setName() the default folder is still named after package.json.
    return errPath.join(app.getPath('appData'), 'Mac Code');
  } catch (_) {
    return errPath.join(process.env.APPDATA || require('os').homedir(), 'Mac Code');
  }
}
function errFile(name) { return errPath.join(errUserData(), name); }
function errMkdir() { try { errFs.mkdirSync(errUserData(), { recursive: true }); } catch (_) {} }

function appendErrorLog(rec) {
  try {
    errMkdir();
    const f = errFile('errors.log');
    try { if (errFs.statSync(f).size > ERR_LOG_MAX) errFs.renameSync(f, f + '.1'); } catch (_) {}
    const head = '[' + new Date(Number.isFinite(rec.at) ? rec.at : Date.now()).toISOString() + '] ' +
      rec.source + ' ' + rec.name + ': ' + rec.message;
    let entry = head + (rec.stack ? '\n' + rec.stack : '') + '\n\n';
    if (entry.length > ERR_ENTRY_MAX) entry = entry.slice(0, ERR_ENTRY_MAX - 1) + '\n';
    errFs.appendFileSync(f, entry, 'utf8');
  } catch (_) {}
}
function readPendingErrors() {
  try {
    const v = JSON.parse(errFs.readFileSync(errFile('pending-error-notes.json'), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}
function writePendingErrors(list) {
  try {
    errMkdir();
    const f = errFile('pending-error-notes.json');
    const tmp = f + '.' + process.pid + '.tmp';
    errFs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
    errFs.renameSync(tmp, f);
  } catch (_) {}
}
function addPendingError(rec) {
  const list = readPendingErrors();
  list.push(rec);
  writePendingErrors(list.slice(-ERR_PENDING_MAX));
}
// Live to the renderer when it has signalled ready and is alive; the pending file otherwise.
function deliverError(rec, forcePending) {
  try {
    const wc = errState.wc;
    if (!forcePending && errState.rendererReady && wc && !wc.isDestroyed() && !wc.isCrashed()) {
      wc.send('errors:note', rec);
      return;
    }
  } catch (_) {}
  addPendingError(rec);
}
function recordMainError(source, error, opts) {
  if (errState.busy) return null; // recursion guard
  errState.busy = true;
  try {
    let version, home;
    try { version = require('electron').app.getVersion(); } catch (_) {}
    try { home = require('os').homedir(); } catch (_) {}
    const rec = errorNotes.formatError({ source, error, version, home, now: Date.now() });
    if (errorNotes.shouldIgnore(rec)) return rec;
    appendErrorLog(rec);
    deliverError(rec, !!(opts && opts.forcePending));
    return rec;
  } catch (_) {
    return null;
  } finally {
    errState.busy = false;
  }
}
process.on('uncaughtException', (err) => {
  try { recordMainError('main', err); } catch (_) {}
  // Registering a handler suppresses Electron's own dialog; keep showing it.
  try {
    const stack = err && err.stack ? err.stack : String(err);
    require('electron').dialog.showErrorBox('A JavaScript error occurred in the main process', 'Uncaught Exception:\n' + stack);
  } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { recordMainError('main (promise)', reason); } catch (_) {}
});
// ===== end error capture =====

const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const pty = require('node-pty');
const { deriveFlow } = require('./flowState');
const { autoAllowsCommand } = require('./autoMode');
const { parseSessionFile, parseProcessSnapshot, lastTurnEnd, PaneSessionTracker } = require('./claudeSessions');
const github = require('./github');
const appSettings = require('./settings');
const { createClaudeConfig, quoteForDisplay } = require('./claudeConfig');
const { createFlowStore, skillConfirmText, diffText, writeDiffFile } = require('./flowStore');
const noteImages = require('./noteImages');
const { themeById } = require('./appThemes');

app.setName('Mac Code');
errState.nameSet = true;
// Must equal build.appId: the installer's Start-menu shortcut carries that id, and
// Windows silently drops toasts from an id no shortcut is registered for.
app.setAppUserModelId('com.marcus.mac-code');
let mainWindow = null;
const ptys = new Map();

// The renderer tells us when a real text field (a composer or rename box, NOT xterm's
// own hidden textarea) has focus. There, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z belong to the
// browser's native undo/redo — we must not steal them. Only the terminal, whose keys
// are already down the PTY, needs our chunk-undo.
let textFieldFocused = false;
ipcMain.on('app:text-field-focus', (_e, focused) => { textFieldFocused = !!focused; });

function resolveShell() {
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe'
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  const pathDirs = (process.env.PATH || '').split(';');
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'pwsh.exe');
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
  }
  return 'powershell.exe';
}

// general.shell = 'powershell' picks Windows PowerShell 5.1; a missing exe (or 'pwsh')
// falls back to resolveShell(). Both run PWSH_INIT, so only fixed paths are spawned.
function shellForSettings() {
  if (getSettings().general.shell === 'powershell') {
    const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return resolveShell();
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function defaultCwd() {
  // general.startDir wins when it is an existing folder (full path); else today's choice.
  // Drive-letter paths only: never a UNC share, a \\?\ prefix or a drive-relative '\x'.
  const start = getSettings().general.startDir;
  if (start && appSettings.isDriveAbsolutePath(start) && isDirectory(start)) return start;
  const preferred = 'C:\\dev';
  try {
    if (fs.existsSync(preferred) && fs.statSync(preferred).isDirectory()) return preferred;
  } catch (_) {}
  return os.homedir();
}

// PowerShell init:
//   - Wraps existing prompt to emit OSC 9;9 cwd marker each redraw
//   - Hooks PSReadLine Enter to emit OSC 6633 with command line before submission
const PWSH_INIT = `
$global:__macAwesomeOrigPrompt = $function:prompt
function global:prompt {
  $cwd = $ExecutionContext.SessionState.Path.CurrentLocation.Path
  $OSC = [char]27 + ']'
  $BEL = [char]7
  try { [Console]::Write($OSC + '9;9;"' + $cwd + '"' + $BEL) } catch {}
  if ($global:__macAwesomeOrigPrompt) { & $global:__macAwesomeOrigPrompt } else { "PS $cwd> " }
}
if (Get-Module -ListAvailable -Name PSReadLine) {
  try {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
      $line = $null
      $cursor = $null
      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
      try { [Console]::Write([char]27 + ']6633;' + $line + [char]7) } catch {}
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  } catch {}
}
`.trim().replace(/\r?\n/g, '; ');

function shellArgs(shellPath) {
  return ['-NoLogo', '-NoExit', '-Command', PWSH_INIT];
}

// Crashes and hangs of the main window's renderer, and GPU/utility process crashes. Only the
// main window counts (the GitHub popup is remote content); a dead renderer can't take a
// live note, so those always go to the pending file and are drained on reload.
// The app being shut down or killed from outside (End task, SIGTERM = exit code 143) is
// not a Mac Code error, even though its child processes report reason 'crashed'.
function processKilled(details) {
  return errState.quitting || !details || details.reason === 'killed' || details.exitCode === 143;
}

function wireErrorCapture(win) {
  try {
    const wc = win.webContents;
    errState.wc = wc;
    errState.rendererReady = false;
    // Windows shutdown / logoff skips before-quit.
    win.on('session-end', () => { errState.quitting = true; });
    wc.on('did-start-navigation', (ev, url, isInPlace, isMainFrame) => {
      const mainFrame = ev && ev.isMainFrame !== undefined ? ev.isMainFrame : isMainFrame;
      const sameDoc = ev && ev.isSameDocument !== undefined ? ev.isSameDocument : isInPlace;
      if (mainFrame && !sameDoc) errState.rendererReady = false;
    });
    wc.on('render-process-gone', (_e, details) => {
      errState.rendererReady = false;
      const reason = details && details.reason;
      if (reason === 'clean-exit' || processKilled(details)) return;
      recordMainError('render-process-gone', { name: 'RenderProcessGone', message: 'reason=' + reason + ' exitCode=' + (details && details.exitCode) }, { forcePending: true });
    });
    wc.on('unresponsive', () => {
      recordMainError('unresponsive', { name: 'WindowUnresponsive', message: 'The main window stopped responding' });
    });
    if (!errState.childWired) {
      errState.childWired = true;
      app.on('before-quit', () => { errState.quitting = true; });
      app.on('child-process-gone', (_e, details) => {
        const type = details && details.type, reason = details && details.reason;
        if ((type !== 'GPU' && type !== 'Utility') || reason === 'clean-exit' || processKilled(details)) return;
        recordMainError('child-process-gone', { name: type + 'ProcessGone', message: 'reason=' + reason + ' exitCode=' + details.exitCode });
      });
    }
  } catch (_) {}
}

function createWindow() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;

  const TARGET_W = 1950;
  const TARGET_H = 1268;

  const width = Math.min(TARGET_W, wa.width);
  const height = Math.min(TARGET_H, wa.height);
  const fillsScreen = width >= wa.width - 20 || height >= wa.height - 20;
  const x = Math.round(wa.x + (wa.width - width) / 2);
  const y = Math.round(wa.y + (wa.height - height) / 2);

  mainWindow = new BrowserWindow({
    minWidth: 600,
    minHeight: 400,
    frame: false,
    backgroundColor: startupBackground(),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  wireErrorCapture(mainWindow);

  // Position in two steps: setPosition first so setBounds uses target display DPI.
  // Fixes multi-display sizing bug where constructor uses primary display scale.
  mainWindow.setPosition(x, y);
  mainWindow.setBounds({ x, y, width, height });

  mainWindow.loadFile('renderer.html');

  // Ctrl+Z is intercepted in main process so menu accelerators and xterm's textarea
  // handlers can't swallow it first, then the renderer applies chunk-level undo on the
  // active pane. But a focused text field owns its own Notepad-style undo/redo natively,
  // so leave every editing key alone there — steal nothing while textFieldFocused.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Block Chromium's built-in reload accelerators (Ctrl+R / Ctrl+Shift+R). A stray
    // reload wipes every terminal pane and chat session. This runs even while a text
    // field is focused. Ctrl+Shift+R stays repurposed for horizontal split — forwarded
    // to the renderer over IPC, since preventDefault also swallows the DOM keydown.
    if (input.control && !input.alt && !input.meta &&
        (input.key || '').toLowerCase() === 'r') {
      event.preventDefault();
      if (input.shift) mainWindow.webContents.send('app:split-h');
      return;
    }

    if (textFieldFocused) return;
    if (input.control && !input.shift && !input.alt && !input.meta &&
        (input.key || '').toLowerCase() === 'z') {
      event.preventDefault();
      mainWindow.webContents.send('app:ctrl-z');
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.setBounds({ x, y, width, height });
    if (fillsScreen) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', 'normal'));

  // Closing first lets the renderer end running Claude CLI sessions, so their
  // "claude --resume <id>" line lands in the saved scrollback. The renderer answers
  // with app:close-ready; the timer is a fallback so a hung pane can't block quit.
  mainWindow.on('close', (event) => {
    if (closeReady) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    mainWindow.webContents.send('app:before-close');
    setTimeout(finishClose, 8000);
  });

  mainWindow.on('closed', () => {
    for (const [, p] of ptys) {
      try { p.kill(); } catch (_) {}
    }
    ptys.clear();
    killAllChats();
    stopGateServer();
    stopFlowWatcher();
    github.closeGitHubWindow();
    mainWindow = null;
  });
}

let closeRequested = false;
let closeReady = false;
function finishClose() {
  if (closeReady || !mainWindow || mainWindow.isDestroyed()) return;
  closeReady = true;
  mainWindow.close();
}
ipcMain.on('app:close-ready', finishClose);

app.whenReady().then(() => {
  createWindow();
  startFlowWatcher();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ----- IPC: terminal -----
ipcMain.handle('terminal:create', (event, opts = {}) => {
  const shell = shellForSettings();
  const cols = opts.cols || 80;
  const rows = opts.rows || 24;
  const cwd = opts.cwd || defaultCwd();
  // The orchestrate hook stamps this key into its state file, so a flow can be
  // matched back to the pane whose Claude session produced it.
  const flowKey = crypto.randomUUID();

  const ptyProcess = pty.spawn(shell, shellArgs(shell), {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, MAC_CODE_FLOW_KEY: flowKey },
    useConpty: true
  });

  const id = ptyProcess.pid + ':' + Date.now();
  ptys.set(id, ptyProcess);

  ptyProcess.onData(data => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', id, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', id, exitCode);
    }
    ptys.delete(id);
    forgetPaneClaude(id);
  });

  return { id, shell, cwd, flowKey };
});

ipcMain.on('terminal:input', (event, id, data) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});

ipcMain.on('terminal:resize', (event, id, cols, rows) => {
  const p = ptys.get(id);
  if (p) { try { p.resize(cols, rows); } catch (_) {} }
});

ipcMain.on('terminal:kill', (event, id) => {
  const p = ptys.get(id);
  if (p) {
    try { p.kill(); } catch (_) {}
    ptys.delete(id);
    forgetPaneClaude(id);
  }
});

// ----- Orchestrate flow tracker -----
// The global orchestrate-gate hook writes one JSON state file per Claude session.
// We watch that folder, derive a FlowView per session (flowState.js) and push the
// full list to the renderer, which matches views to panes by flowKey.
const FLOW_DIR = path.join(os.homedir(), '.claude', 'state', 'orchestrate');
const flowStates = new Map(); // sessionId -> parsed state file
let flowWatcher = null;
let flowInterval = null;
let flowDebounce = null;
const flowDirty = new Set();

function flowFileOk(name) {
  // Skip the hook's .lock files and per-process .tmp files mid-rename.
  return typeof name === 'string' && name.endsWith('.json');
}

function readFlowFile(name) {
  const id = name.slice(0, -'.json'.length);
  try {
    flowStates.set(id, JSON.parse(fs.readFileSync(path.join(FLOW_DIR, name), 'utf8')));
  } catch (err) {
    // Gone -> forget it; a partial write -> keep the last good copy.
    if (err && err.code === 'ENOENT') flowStates.delete(id);
  }
}

function currentFlowViews() {
  const now = Date.now();
  const views = [];
  for (const state of flowStates.values()) {
    try {
      const v = deriveFlow(state, now);
      if (v) views.push(v);
    } catch (_) {}
  }
  return views;
}

function pushFlows() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('flow:update', currentFlowViews());
  }
}

function scanFlowDir() {
  let names = [];
  try { names = fs.readdirSync(FLOW_DIR); } catch (_) {}
  flowStates.clear();
  for (const name of names) if (flowFileOk(name)) readFlowFile(name);
}

function startFlowWatcher() {
  try { fs.mkdirSync(FLOW_DIR, { recursive: true }); } catch (_) {}
  scanFlowDir();
  try {
    // Windows fires duplicate and partial events, so batch them for 150 ms.
    flowWatcher = fs.watch(FLOW_DIR, (_type, name) => {
      if (name && !flowFileOk(String(name))) return;
      flowDirty.add(name ? String(name) : '*');
      clearTimeout(flowDebounce);
      flowDebounce = setTimeout(() => {
        if (flowDirty.has('*')) scanFlowDir();
        else for (const n of flowDirty) readFlowFile(n);
        flowDirty.clear();
        pushFlows();
      }, 150);
    });
    flowWatcher.on('error', () => {});
  } catch (_) {}
  // Re-derive on a timer too: elapsed times tick and finished flows expire.
  flowInterval = setInterval(pushFlows, 30000);
  pushFlows();
}

function stopFlowWatcher() {
  clearTimeout(flowDebounce);
  clearInterval(flowInterval);
  flowInterval = null;
  try { if (flowWatcher) flowWatcher.close(); } catch (_) {}
  flowWatcher = null;
}

ipcMain.handle('flow:list', () => currentFlowViews());

// ----- IPC: window -----
ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());

// ----- IPC: filesystem -----
ipcMain.handle('fs:list', async (event, dirPath) => {
  if (!dirPath) return { error: 'no path' };
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('$RECYCLE.BIN'))
      .map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isSymbolicLink: e.isSymbolicLink(),
        path: path.join(dirPath, e.name)
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
    return { entries: items, path: dirPath };
  } catch (err) {
    return { error: err.message, path: dirPath };
  }
});

ipcMain.handle('fs:home', () => os.homedir());

ipcMain.handle('fs:parent', (event, p) => {
  if (!p) return null;
  const parent = path.dirname(p);
  return parent === p ? null : parent;
});

// ----- IPC: git -----
// Run git in `cwd`, never throw: resolve with { code, stdout, stderr }.
function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: (stderr || '') || (err ? err.message : '')
      });
    });
  });
}

// Best guess at the repo's default branch (main/master). Prefer what origin/HEAD
// points at; fall back to whichever of main/master exists on the remote, then locally.
async function detectDefaultBranch(cwd) {
  const head = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0) {
    const name = head.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  }
  for (const cand of ['main', 'master']) {
    const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + cand]);
    if (r.code === 0) return cand;
  }
  for (const cand of ['main', 'master']) {
    const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + cand]);
    if (r.code === 0) return cand;
  }
  return null;
}

async function hasOriginRemote(cwd) {
  const r = await runGit(cwd, ['remote']);
  return r.stdout.split('\n').map((s) => s.trim()).includes('origin');
}

// List local branches + current branch for the repo containing `cwd`.
ipcMain.handle('git:branches', async (event, cwd) => {
  if (!cwd) return { isRepo: false };
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false };
  const cur  = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const list = await runGit(cwd, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']);
  const current = cur.stdout.trim();
  const detached = current === 'HEAD' || current === '';
  const branches = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const defaultBranch = await detectDefaultBranch(cwd);
  const hasRemote = await hasOriginRemote(cwd);
  return { isRepo: true, current: detached ? null : current, detached, branches, defaultBranch, hasRemote };
});

// Fetch the latest default branch (main/master) from origin and fast-forward the
// local branch. If it is the checked-out branch, pull --ff-only; otherwise update
// the local ref directly (fetch origin D:D) without changing the working tree.
ipcMain.handle('git:updateMain', async (event, cwd) => {
  if (!cwd) return { ok: false, error: 'no path' };
  if (!(await hasOriginRemote(cwd))) return { ok: false, error: 'no "origin" remote' };
  const branch = await detectDefaultBranch(cwd);
  if (!branch) return { ok: false, error: 'no main/master branch found' };
  const before = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])).stdout.trim();
  const cur = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const res = cur === branch
    ? await runGit(cwd, ['pull', '--ff-only', 'origin', branch])
    : await runGit(cwd, ['fetch', 'origin', branch + ':' + branch]);
  if (res.code !== 0) {
    return { ok: false, branch, error: (res.stderr || res.stdout || 'fetch failed').trim() };
  }
  const after = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])).stdout.trim();
  return { ok: true, branch, updated: before !== after, message: (res.stdout + '\n' + res.stderr).trim() };
});

// Switch the repo at `cwd` to `branch`. Returns { ok } or { ok:false, error }.
ipcMain.handle('git:switch', async (event, { cwd, branch } = {}) => {
  if (!cwd || !branch) return { ok: false, error: 'missing cwd or branch' };
  const res = await runGit(cwd, ['switch', branch]);
  if (res.code !== 0) return { ok: false, error: (res.stderr || res.stdout || 'git switch failed').trim() };
  return { ok: true };
});

// ----- IPC: GitHub (via gh CLI) -----
github.register(ipcMain, () => mainWindow, () => getSettings());

// ----- IPC: Claude session usage -----
// Claude names project folders by turning every non-alphanumeric character into '-',
// so C:\Users\a.b becomes C--Users-a-b; dots and underscores included.
function encodeCwdForClaude(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// A model's native context window is 1M for every current family except Haiku —
// Opus/Sonnet from 4.6 on, Fable/Mythos from 5 on — so those get a 1M window even
// without the CLI's `[1m]` beta alias. Older versions and all Haiku stay at 200k.
// A bare family alias (`opus`, no version) tracks the newest release of that family.
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

ipcMain.handle('claude:usage', async (event, cwd) => {
  if (!cwd) return null;
  const encoded = encodeCwdForClaude(cwd);
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  try {
    const files = await fs.promises.readdir(dir);
    const jsonls = files.filter(f => f.endsWith('.jsonl'));
    if (jsonls.length === 0) return null;
    const stats = await Promise.all(jsonls.map(async f => {
      const p = path.join(dir, f);
      const st = await fs.promises.stat(p);
      return { p, mtime: st.mtimeMs };
    }));
    stats.sort((a, b) => b.mtime - a.mtime);
    const target = stats[0];
    const content = await fs.promises.readFile(target.p, 'utf8');
    const lines = content.split('\n');

    // Turn info first: it must come back even when no usage entry exists yet.
    const { endedAt: turnEndedAt, active: turnActive } = lastTurnEnd(lines);

    let lastUsage = null;
    let model = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const usage = obj?.message?.usage;
        if (usage) {
          lastUsage = usage;
          model = obj?.message?.model || null;
          break;
        }
      } catch (_) {}
    }
    if (!lastUsage) return { turnEndedAt, turnActive };

    const input = lastUsage.input_tokens || 0;
    const cacheRead = lastUsage.cache_read_input_tokens || 0;
    const cacheCreate = lastUsage.cache_creation_input_tokens || 0;
    const output = lastUsage.output_tokens || 0;
    const contextTokens = input + cacheRead + cacheCreate;

    // Resolve selected model label from latest /model slash-command output.
    // This is authoritative for both display and context window size.
    let selectedModelLabel = null;
    let oneMFromCommand = false;
    // Only match Set model to lines that are real /model command output
    // (wrapped in <local-command-stdout>), not source-code references in file reads.
    const setModelMatches = content.match(/<local-command-stdout>Set model to[^<]*<\/local-command-stdout>/g);
    if (setModelMatches && setModelMatches.length > 0) {
      const last = setModelMatches[setModelMatches.length - 1];
      selectedModelLabel = last
        .replace(/^<local-command-stdout>Set model to\s*/i, '')
        .replace(/<\/local-command-stdout>$/i, '')
        .replace(/\\u001b\[[0-9;]*m/g, '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\s*·.*$/, '')
        .trim();
      oneMFromCommand = /\(1M context\)|\[1m\]/i.test(selectedModelLabel);
    }

    // Only a real beta list counts: a bare `context-1m` can show up in tool output
    // (a grep of this very file, say) and would flip every pane to 1M.
    const oneMFromBeta = /"betas"\s*:\s*\[[^\]]*context-1m/.test(content);
    const oneMFromModel = /\b1m\b|\[1m\]/i.test(model || '');

    let oneMFromSettings = false;
    try {
      const settingsRaw = await fs.promises.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
      const settingsModel = JSON.parse(settingsRaw)?.model || '';
      oneMFromSettings = /\[1m\]|\(1M context\)/i.test(settingsModel);
    } catch (_) {}

    // Opus 4.8 (and Opus/Sonnet 4.6+, Fable 5) are natively 1M — no `[1m]` alias needed.
    const oneMFromNative = modelIsNativeOneM(model) || modelIsNativeOneM(selectedModelLabel);

    const contextWindow = (oneMFromCommand || oneMFromBeta || oneMFromModel || oneMFromSettings || oneMFromNative || contextTokens > 200000)
      ? 1000000 : 200000;

    const displayModel = selectedModelLabel || model;

    return {
      contextTokens,
      input,
      cacheRead,
      cacheCreate,
      output,
      model: displayModel,
      apiModel: model,
      contextWindow,
      sessionFile: path.basename(target.p),
      sessionId: path.basename(target.p, '.jsonl'),
      mtime: target.mtime,
      turnEndedAt,
      turnActive
    };
  } catch (err) {
    return { error: err.code || err.message };
  }
});

// ----- IPC: plan limits (5-hour + weekly), the numbers `/usage` shows -----
//
// The CLI itself reads these off `anthropic-ratelimit-unified-*` response headers,
// which only exist inside its own HTTP calls — nothing lands on disk. The same
// subscription endpoint it uses for `/usage` is reachable with the OAuth token in
// ~/.claude/.credentials.json, so that is what gets polled here. One cache for the
// whole app: every chat pane and the status bar want the same two numbers.
const LIMITS_TTL = 60000;
let limitsCache = { at: 0, data: null };
let limitsInflight = null;

function readClaudeOauth() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return oauth && oauth.accessToken ? oauth : null;
  } catch (_) {
    return null;
  }
}

// GET api.anthropic.com as the CLI's own OAuth session. Never throws: callers get
// {raw} on success, or {unavailable} / {error} to fall back on.
function anthropicGet(token, requestPath, extraHeaders) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'api.anthropic.com',
      path: requestPath,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        ...(extraHeaders || {})
      },
      timeout: 8000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ unavailable: 'unauthorized' });
        } else if (res.statusCode !== 200) {
          resolve({ error: 'HTTP ' + res.statusCode });
        } else {
          try { resolve({ raw: JSON.parse(body) }); }
          catch (_) { resolve({ error: 'unreadable response' }); }
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ error: err.message }));
    req.end();
  });
}

// The response carries both a per-window shape (five_hour/seven_day) and a newer
// `limits` array. The array is what the CLI renders, so prefer it and keep the
// older fields as the fallback.
function normalizePlanLimits(raw, oauth) {
  const pick = (entry) => {
    if (!entry) return null;
    const value = entry.percent != null ? entry.percent : entry.utilization;
    if (value == null) return null;
    return {
      percent: Math.min(100, Math.max(0, Math.round(Number(value)))),
      resetsAt: entry.resets_at || null,
      severity: entry.severity || 'normal'
    };
  };
  const arr = Array.isArray(raw.limits) ? raw.limits : [];
  const scoped = [];
  for (const entry of arr) {
    if (entry.kind !== 'weekly_scoped') continue;
    const parsed = pick(entry);
    if (!parsed) continue;
    const model = entry.scope?.model?.display_name || null;
    scoped.push({
      ...parsed,
      label: model ? model + ' weekly' : 'Scoped weekly',
      key: model ? model.toLowerCase() : 'scoped'
    });
  }
  return {
    session: pick(arr.find((l) => l.kind === 'session')) || pick(raw.five_hour),
    weekly: pick(arr.find((l) => l.kind === 'weekly_all')) || pick(raw.seven_day),
    scoped,
    tier: oauth?.rateLimitTier || null,
    plan: oauth?.subscriptionType || null,
    fetchedAt: Date.now()
  };
}

ipcMain.handle('claude:limits', async (_event, args = {}) => {
  const now = Date.now();
  if (!args.force && limitsCache.data && now - limitsCache.at < LIMITS_TTL) return limitsCache.data;
  if (limitsInflight) return limitsInflight;

  limitsInflight = (async () => {
    const oauth = readClaudeOauth();
    // API-key, Bedrock and Vertex users have no subscription window to report.
    if (!oauth) return { unavailable: 'no-oauth' };
    const res = await anthropicGet(oauth.accessToken, '/api/oauth/usage');
    if (res.raw) {
      const data = normalizePlanLimits(res.raw, oauth);
      limitsCache = { at: Date.now(), data };
      return data;
    }
    // A blip shouldn't blank the meter — keep serving the last good numbers.
    if (limitsCache.data) {
      return { ...limitsCache.data, stale: true, error: res.error || res.unavailable || null };
    }
    return res.unavailable ? { unavailable: res.unavailable } : { error: res.error || 'usage unavailable' };
  })();

  try { return await limitsInflight; }
  finally { limitsInflight = null; }
});

// ----- IPC: selectable models -----
//
// The four names the chat pane offers by default are CLI aliases that always resolve
// to the current model of each family. Pinning an older version means passing its
// exact id, and which ids an account may use is not something to guess — /v1/models
// answers it for this login, newest first, and keeps working when new models ship.
const MODELS_TTL = 10 * 60 * 1000;
let modelsCache = { at: 0, data: null };
let modelsInflight = null;

ipcMain.handle('claude:models', async (_event, args = {}) => {
  const now = Date.now();
  if (!args.force && modelsCache.data && now - modelsCache.at < MODELS_TTL) return modelsCache.data;
  if (modelsInflight) return modelsInflight;

  modelsInflight = (async () => {
    const oauth = readClaudeOauth();
    if (!oauth) return { unavailable: 'no-oauth' };
    const res = await anthropicGet(oauth.accessToken, '/v1/models?limit=100', { 'anthropic-version': '2023-06-01' });
    if (res.raw) {
      const models = (Array.isArray(res.raw.data) ? res.raw.data : [])
        .filter((m) => m && typeof m.id === 'string')
        .map((m) => ({
          id: m.id,
          // "Claude Opus 4.8" reads as "Opus 4.8" next to the alias entries.
          label: String(m.display_name || m.id).replace(/^Claude\s+/i, '')
        }));
      const data = { models, fetchedAt: Date.now() };
      modelsCache = { at: Date.now(), data };
      return data;
    }
    if (modelsCache.data) return { ...modelsCache.data, stale: true };
    return res.unavailable ? { unavailable: res.unavailable } : { error: res.error || 'model list unavailable' };
  })();

  try { return await modelsInflight; }
  finally { modelsInflight = null; }
});

// ============================================================================
// MCP management
//
// Everything goes through `claude mcp …` rather than editing ~/.claude.json
// directly: that file is the CLI's own live state (startup counters, project
// history, ~100KB of it), so a concurrent write from here could lose data.
// Interactive flows (login) are run in a chat pane's terminal drawer instead,
// where there is a real pty for the OAuth prompt.
// ============================================================================

function runClaude(args, opts = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(resolveClaudeBin(), args, {
        cwd: opts.cwd || defaultCwd(),
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ error: err.message, code: -1 });
      return;
    }
    let out = '', err = '';
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      done({ error: 'timed out', stdout: out, stderr: err, code: -1 });
    }, opts.timeout || 60000);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); done({ error: e.message, code: -1 }); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, code, stdout: out, stderr: err });
    });
  });
}

// `claude mcp list` prints "<name>: <target> - <marker> <status>" per server, where
// the marker is one of ✔ ! ✘ ⏸. Anchoring the split on the marker keeps names and
// URLs (both of which contain colons and dashes) intact.
function parseMcpList(stdout) {
  const servers = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^Checking MCP server health/i.test(line)) continue;
    const at = line.search(/\s-\s[✔✓!✘⏸]/);
    if (at < 0) continue;
    const left = line.slice(0, at);
    const rest = line.slice(at + 3);
    const marker = rest[0];
    const statusText = rest.slice(1).trim();
    const colon = left.indexOf(': ');
    const name = colon >= 0 ? left.slice(0, colon) : left;
    let target = colon >= 0 ? left.slice(colon + 2) : '';
    // HTTP/SSE entries carry a trailing transport marker; stdio ones don't.
    let transport = 'stdio';
    const tm = target.match(/\s\((HTTP|SSE|SSE-IDE|WS)\)$/i);
    if (tm) { transport = tm[1].toLowerCase(); target = target.slice(0, tm.index); }
    const state =
      marker === '✔' || marker === '✓' ? 'connected' :
      marker === '!' ? 'needs-auth' :
      marker === '⏸' ? 'pending' : 'failed';
    servers.push({ name, target, transport, state, statusText });
  }
  return servers;
}

// Where every configured server lives, read straight from the CLI's config files.
// Read-only: writes still go through `claude mcp add-json` so the CLI owns the file.
//
// This exists because `claude mcp add` defaults to *local* scope, which is keyed to
// the exact folder — servers added in C:\dev are invisible from C:\dev\project. The
// panel needs to be able to say so, and offer to copy them across.
function normalizeProjectPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

ipcMain.handle('mcp:configured', async (_event, args = {}) => {
  const out = { user: [], projects: [], projectFile: [], errors: [] };
  const cwdKey = normalizeProjectPath(args.cwd || defaultCwd());

  try {
    const raw = await fs.promises.readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
    const cfg = JSON.parse(raw);
    for (const [name, config] of Object.entries(cfg.mcpServers || {})) {
      out.user.push({ name, config });
    }
    for (const [projectPath, project] of Object.entries(cfg.projects || {})) {
      const servers = Object.entries((project && project.mcpServers) || {})
        .map(([name, config]) => ({ name, config }));
      if (!servers.length) continue;
      out.projects.push({
        path: projectPath,
        isCurrent: normalizeProjectPath(projectPath) === cwdKey,
        servers
      });
    }
  } catch (err) {
    out.errors.push('~/.claude.json: ' + (err.code || err.message));
  }

  // A project-scoped .mcp.json is checked in with the repo.
  if (args.cwd) {
    try {
      const raw = await fs.promises.readFile(path.join(args.cwd, '.mcp.json'), 'utf8');
      const cfg = JSON.parse(raw);
      for (const [name, config] of Object.entries(cfg.mcpServers || {})) {
        out.projectFile.push({ name, config });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') out.errors.push('.mcp.json: ' + (err.code || err.message));
    }
  }
  return out;
});

ipcMain.handle('mcp:addJson', async (_event, args = {}) => {
  const name = String(args.name || '').trim();
  if (!name || !args.config) return { error: 'name and config are required' };
  const scope = ['local', 'user', 'project'].includes(args.scope) ? args.scope : 'local';
  const res = await runClaude(
    ['mcp', 'add-json', '--scope', scope, name, JSON.stringify(args.config)],
    { cwd: args.cwd, timeout: 60000 }
  );
  if (res.error) return { error: res.error };
  return { ok: res.ok, text: (res.stdout || '') + (res.stderr || '') };
});

ipcMain.handle('mcp:list', async (_event, args = {}) => {
  const res = await runClaude(['mcp', 'list'], { cwd: args.cwd, timeout: 90000 });
  if (res.error) return { error: res.error, stderr: res.stderr };
  return { servers: parseMcpList(res.stdout), raw: res.stdout, stderr: res.stderr };
});

ipcMain.handle('mcp:get', async (_event, args = {}) => {
  if (!args.name) return { error: 'no name' };
  const res = await runClaude(['mcp', 'get', args.name], { cwd: args.cwd, timeout: 60000 });
  if (res.error) return { error: res.error };
  return { ok: res.ok, text: (res.stdout || '') + (res.stderr || '') };
});

ipcMain.handle('mcp:remove', async (_event, args = {}) => {
  if (!args.name) return { error: 'no name' };
  const argv = ['mcp', 'remove', args.name];
  if (args.scope) argv.push('--scope', args.scope);
  const res = await runClaude(argv, { cwd: args.cwd, timeout: 30000 });
  if (res.error) return { error: res.error };
  return { ok: res.ok, text: (res.stdout || '') + (res.stderr || '') };
});

ipcMain.handle('mcp:logout', async (_event, args = {}) => {
  if (!args.name) return { error: 'no name' };
  const res = await runClaude(['mcp', 'logout', args.name], { cwd: args.cwd, timeout: 30000 });
  if (res.error) return { error: res.error };
  return { ok: res.ok, text: (res.stdout || '') + (res.stderr || '') };
});

ipcMain.handle('mcp:add', async (_event, args = {}) => {
  const name = String(args.name || '').trim();
  const target = String(args.target || '').trim();
  if (!name || !target) return { error: 'name and command/URL are required' };

  const scope = ['local', 'user', 'project'].includes(args.scope) ? args.scope : 'local';
  const argv = ['mcp', 'add', '--scope', scope];
  if (args.transport === 'http' || args.transport === 'sse') {
    argv.push('--transport', args.transport);
  }
  for (const h of (args.headers || [])) {
    if (String(h).trim()) argv.push('--header', String(h).trim());
  }
  for (const e of (args.env || [])) {
    if (String(e).trim()) argv.push('--env', String(e).trim());
  }
  argv.push(name);
  if (args.transport === 'stdio') {
    // Everything after `--` is the subprocess command, so its own flags survive.
    argv.push('--', ...target.split(/\s+/));
  } else {
    argv.push(target);
  }
  const res = await runClaude(argv, { cwd: args.cwd, timeout: 60000 });
  if (res.error) return { error: res.error };
  return { ok: res.ok, text: (res.stdout || '') + (res.stderr || '') };
});

// ----- IPC: the CLI's own default permission mode -----
// Seeds a new chat pane from ~/.claude/settings.json so Mac Code starts where the
// user's CLI does. Modes the gate has no equivalent for fall back to asking.
ipcMain.handle('claude:defaultPermissionMode', async () => {
  try {
    const raw = await fs.promises.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const mode = JSON.parse(raw)?.permissions?.defaultMode;
    if (mode === 'auto' || mode === 'acceptEdits' || mode === 'bypassPermissions') {
      return { mode };
    }
    return { mode: 'default', cliMode: mode || null };
  } catch (err) {
    return { mode: 'default', error: err.code || err.message };
  }
});

// ----- IPC: the CLI's own default model -----
// A chat pane always passes --model, which overrides settings.json. Without reading
// it first, a user whose CLI runs `opus[1m]` would silently get a 200k pane here.
ipcMain.handle('claude:defaultModel', async () => {
  try {
    const raw = await fs.promises.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const model = JSON.parse(raw)?.model;
    return { model: typeof model === 'string' && model.trim() ? model.trim() : null };
  } catch (err) {
    return { model: null, error: err.code || err.message };
  }
});

// ----- IPC: which Claude session runs in a terminal pane -----
// The CLI keeps ~/.claude/sessions/<pid>.json while it runs. Matching one to a pane
// lets the resume button know the session id before Claude exits, and keeps it if the
// app is killed mid-session. Several panes (or an external terminal) can run Claude
// in the same folder, so a file is only taken once a process snapshot shows it
// descends from the pane's shell.
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const paneSessions = new PaneSessionTracker();
let procSnapshot = null;  // { at, promise } shared by every pane

function forgetPaneClaude(ptyId) {
  paneSessions.forget(ptyId);
}

async function readClaudeSessionFile(pid) {
  try {
    return parseSessionFile(await fs.promises.readFile(path.join(CLAUDE_SESSIONS_DIR, pid + '.json'), 'utf8'));
  } catch (_) { return null; }
}

async function readClaudeSessionFiles() {
  let names;
  try { names = await fs.promises.readdir(CLAUDE_SESSIONS_DIR); } catch (_) { return []; }
  const pids = names.map(n => n.match(/^(\d+)\.json$/)).filter(Boolean).map(m => m[1]);
  return (await Promise.all(pids.map(readClaudeSessionFile))).filter(Boolean);
}

// One PowerShell for all panes, reused for a few seconds: polls from several panes
// land in the same tick. windowsHide keeps it from flashing a console.
function processSnapshot() {
  if (procSnapshot && Date.now() - procSnapshot.at < 3000) return procSnapshot.promise;
  const cmd = "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2},{3}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() }),$_.Name }";
  const promise = new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseProcessSnapshot(stdout)));
  });
  procSnapshot = { at: Date.now(), promise };
  // A failed snapshot shouldn't block retries for the full cache window.
  promise.then(p => { if (!p && procSnapshot?.promise === promise) procSnapshot = null; });
  return promise;
}

ipcMain.handle('claude:paneSession', async (_event, ptyId, sinceMs, cwd) => {
  const shell = ptys.get(ptyId);
  if (!shell || !Number.isFinite(sinceMs) || typeof cwd !== 'string') return null;
  let s;
  const cached = paneSessions.cached(ptyId, sinceMs);
  if (cached) {
    s = paneSessions.verifyCached(ptyId, await readClaudeSessionFile(cached.claudePid));
    if (!s) return null;
  } else {
    if (paneSessions.givenUp(ptyId, sinceMs)) return null;
    const candidates = paneSessions.candidates(ptyId, await readClaudeSessionFiles(), { sinceMs, cwd });
    // Nothing yet is normal while the CLI starts up; that costs a readdir, so it isn't
    // counted against the give-up limit.
    if (!candidates.length) return null;
    const procs = await processSnapshot();
    // The pty may have exited while the snapshot ran.
    if (!ptys.has(ptyId)) return null;
    s = paneSessions.resolve(ptyId, candidates, procs, { sinceMs, shellPid: shell.pid });
    if (!s) return null;
  }
  // A session with no transcript yet (Claude opened, nothing sent) can't be resumed.
  // sessionId is a validated UUID, so the path stays inside the project folder.
  let hasTranscript = false;
  try {
    await fs.promises.access(path.join(os.homedir(), '.claude', 'projects', encodeCwdForClaude(s.cwd), s.sessionId + '.jsonl'));
    hasTranscript = true;
  } catch (_) {}
  return { sessionId: s.sessionId, cwd: s.cwd, hasTranscript };
});

// ----- IPC: Claude → Copilot session handoff -----
// Extracts a compact brief from the latest Claude jsonl session for the
// given cwd and writes it to <cwd>/.mac-code/handoff.md so the Copilot
// CLI can ingest it via `Read .mac-code/handoff.md`.
ipcMain.handle('claude:handoff', async (event, args) => {
  const cwd = args?.cwd;
  const targetTokens = Math.max(500, Math.min(40000, args?.targetTokens || 6000));
  if (!cwd) return { error: 'no cwd' };

  const encoded = encodeCwdForClaude(cwd);
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  let files;
  try { files = await fs.promises.readdir(dir); }
  catch (err) { return { error: err.code || err.message }; }
  const jsonls = files.filter(f => f.endsWith('.jsonl'));
  if (!jsonls.length) return { error: 'no session found' };
  const stats = await Promise.all(jsonls.map(async f => {
    const p = path.join(dir, f);
    const st = await fs.promises.stat(p);
    return { p, mtime: st.mtimeMs };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  const sessionPath = stats[0].p;
  const content = await fs.promises.readFile(sessionPath, 'utf8');
  const lines = content.split('\n');

  const userPrompts = [];
  const assistantTexts = [];
  const fileEdits = new Map();
  let latestTodos = null;
  let firstTimestamp = null, lastTimestamp = null;
  let model = null;

  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.timestamp) {
      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }
    if (obj.message?.model) model = obj.message.model;

    if (obj.type === 'user' && obj.message?.role === 'user') {
      const c = obj.message.content;
      if (typeof c === 'string') {
        const stripped = c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        if (stripped && !stripped.startsWith('<local-command-stdout>') && !stripped.startsWith('<command-')) {
          userPrompts.push({ ts: obj.timestamp, text: stripped });
        }
      }
    }

    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item.type === 'text' && item.text) {
          assistantTexts.push({ ts: obj.timestamp, text: item.text });
        }
        if (item.type === 'tool_use') {
          const name = item.name;
          const input = item.input || {};
          if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
            const fp = input.file_path;
            if (fp) fileEdits.set(fp, (fileEdits.get(fp) || 0) + 1);
          }
          if (name === 'TodoWrite' && Array.isArray(input.todos)) {
            latestTodos = input.todos;
          }
        }
      }
    }
  }

  const out = [];
  out.push('# Claude → Copilot session handoff');
  out.push('');
  out.push(`**Project:** ${cwd}`);
  if (model) out.push(`**Source model:** ${model}`);
  if (firstTimestamp) out.push(`**Session started:** ${firstTimestamp}`);
  if (lastTimestamp) out.push(`**Last activity:** ${lastTimestamp}`);
  out.push(`**Source file:** ${sessionPath}`);
  out.push(`**Generated:** ${new Date().toISOString()}`);
  out.push('');
  out.push('You (Copilot) are picking up a session that was running in Claude Code. The user ran out of Claude tokens and is continuing here. Below is the relevant context — read it, then ask the user where they want to continue.');
  out.push('');

  const lastUserPrompts = userPrompts.slice(-10);
  if (lastUserPrompts.length) {
    out.push('## Recent user prompts (oldest → newest)');
    for (const p of lastUserPrompts) {
      const t = (p.text.length > 600 ? p.text.slice(0, 600) + '…' : p.text).replace(/\r?\n/g, ' ');
      out.push(`- ${t}`);
    }
    out.push('');
  }

  if (fileEdits.size) {
    out.push('## Files modified this session');
    const entries = Array.from(fileEdits.entries()).sort((a, b) => b[1] - a[1]);
    for (const [fp, count] of entries.slice(0, 30)) {
      out.push(`- \`${fp}\` — ${count} edit${count === 1 ? '' : 's'}`);
    }
    out.push('');
  }

  if (latestTodos && latestTodos.length) {
    out.push('## Latest TODO state');
    for (const t of latestTodos) {
      const status = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      out.push(`- ${status} ${t.content || t.activeForm || ''}`);
    }
    out.push('');
  }

  const lastAssistant = assistantTexts.length ? assistantTexts[assistantTexts.length - 1].text : '';
  const earlierAssistant = assistantTexts.slice(0, -1).slice(-8);

  if (lastAssistant) {
    out.push('## Last Claude reply (most recent — likely where work stopped)');
    out.push('');
    out.push(lastAssistant.length > 4000 ? lastAssistant.slice(0, 4000) + '\n\n[truncated]' : lastAssistant);
    out.push('');
  }

  if (earlierAssistant.length) {
    out.push('## Earlier Claude replies (chronological, condensed)');
    for (const a of earlierAssistant) {
      const t = a.text.length > 700 ? a.text.slice(0, 700) + '…' : a.text;
      out.push('---');
      out.push(t);
    }
    out.push('');
  }

  out.push('---');
  out.push('When you reply, confirm with the user what they want next before making changes. Don\'t redo work that\'s already done above.');

  let md = out.join('\n');
  const charBudget = targetTokens * 4;
  if (md.length > charBudget) md = md.slice(0, charBudget) + '\n\n[truncated to fit handoff budget]\n';

  const outDir = path.join(cwd, '.mac-code');
  const outPath = path.join(outDir, 'handoff.md');
  try {
    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.writeFile(outPath, md, 'utf8');
  } catch (err) {
    return { error: err.message };
  }

  return {
    path: outPath,
    relPath: path.relative(cwd, outPath).replace(/\\/g, '/'),
    bytes: md.length,
    approxTokens: Math.round(md.length / 4),
    sessionId: path.basename(sessionPath, '.jsonl'),
    userPromptCount: userPrompts.length,
    assistantReplyCount: assistantTexts.length,
    fileEditCount: fileEdits.size
  };
});

// ----- IPC: File API -----
ipcMain.handle('file:read', async (_, p) => {
  try { return { content: await fs.promises.readFile(p, 'utf8') }; }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('file:write', async (_, p, content) => {
  try { await fs.promises.writeFile(p, content, 'utf8'); return { ok: true }; }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('file:openExternal', async (_, p) => {
  const s = String(p == null ? '' : p);
  // URLs must go through shell.openExternal — shell.openPath only resolves
  // filesystem paths and silently fails (or opens the wrong thing) on a URL.
  if (/^(https?:\/\/|mailto:)/i.test(s)) {
    try { await shell.openExternal(s); return { ok: true }; }
    catch (err) { return { error: err.message }; }
  }
  if (/^www\./i.test(s)) {
    try { await shell.openExternal('https://' + s); return { ok: true }; }
    catch (err) { return { error: err.message }; }
  }
  const err = await shell.openPath(s);
  return err ? { error: err } : { ok: true };
});

// ----- IPC: Copilot CLI usage -----
function copilotSessionsDir() {
  return path.join(os.homedir(), '.copilot', 'session-state');
}

// Minimal flat-YAML parser: top-level "key: value" pairs only.
// workspace.yaml is small + flat in practice; full YAML lib overkill.
function parseWorkspaceYaml(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.+?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1].toLowerCase()] = v;
  }
  return out;
}

function normalizeCwd(p) {
  if (!p) return '';
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

ipcMain.handle('copilot:usage', async (event, cwd) => {
  if (!cwd) return null;
  const dir = copilotSessionsDir();
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (err) { return { error: err.code || err.message }; }

  const target = normalizeCwd(cwd);
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sdir = path.join(dir, e.name);
    try {
      const efPath = path.join(sdir, 'events.jsonl');
      const wfPath = path.join(sdir, 'workspace.yaml');
      const [wsRaw, eStat] = await Promise.all([
        fs.promises.readFile(wfPath, 'utf8').catch(() => ''),
        fs.promises.stat(efPath)
      ]);
      const ws = wsRaw ? parseWorkspaceYaml(wsRaw) : {};
      const sessionCwd = ws.cwd || ws.working_directory || ws.workspace || ws.path || '';
      const match = sessionCwd && normalizeCwd(sessionCwd) === target;
      candidates.push({ id: e.name, dir: sdir, mtime: eStat.mtimeMs, match, sessionCwd });
    } catch (_) {}
  }
  if (!candidates.length) return null;

  const matched = candidates.filter(c => c.match);
  const pool = matched.length ? matched : candidates;
  pool.sort((a, b) => b.mtime - a.mtime);
  const t = pool[0];

  let content;
  try { content = await fs.promises.readFile(path.join(t.dir, 'events.jsonl'), 'utf8'); }
  catch { return null; }

  const lines = content.split('\n');
  let model = null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]; if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const metrics = obj?.data?.modelMetrics;
      if (metrics && typeof metrics === 'object') {
        const keys = Object.keys(metrics);
        if (keys.length) {
          model = keys[keys.length - 1];
          const u = metrics[model]?.usage || {};
          inputTokens     = u.inputTokens             ?? u.input_tokens             ?? 0;
          outputTokens    = u.outputTokens            ?? u.output_tokens            ?? 0;
          cacheReadTokens = u.cacheReadInputTokens    ?? u.cache_read_input_tokens  ?? 0;
          cacheCreateTokens = u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0;
          break;
        }
      }
    } catch (_) {}
  }

  const contextTokens = inputTokens + cacheReadTokens + cacheCreateTokens;
  // Copilot models: GPT-4.1 = 1M, GPT-5 family large too. Default conservative.
  const contextWindow = /gpt-5|gpt-4\.1|claude-sonnet-4|claude-opus/i.test(model || '') ? 1000000 : 128000;

  return {
    contextTokens,
    input: inputTokens,
    cacheRead: cacheReadTokens,
    cacheCreate: cacheCreateTokens,
    output: outputTokens,
    model,
    apiModel: model,
    contextWindow,
    sessionFile: 'events.jsonl',
    sessionId: t.id,
    mtime: t.mtime,
    cwd: t.sessionCwd
  };
});

// ============================================================================
// Claude chat panes
//
// A chat pane drives `claude -p --input-format stream-json --output-format
// stream-json`, which keeps one long-lived process per pane: we write user
// messages as JSON lines on stdin and parse agent events off stdout.
//
// Permission prompts don't exist in print mode — a tool that needs approval is
// auto-denied. To get the UI's Allow/Deny card we install a PreToolUse hook
// (hooks/permission-gate.js) that calls back into the loopback gate server
// below and blocks until the renderer answers.
// ============================================================================

const chats = new Map(); // chatId -> { proc, cwd, sessionId, model, permissionMode, rules, buf, pending:Set<permId> }

// Tools that cannot change anything, so they never need a prompt. The hook fires
// for every tool call, not only the ones the CLI would have asked about, so
// without this list a plain Read would pop a card.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'WebSearch', 'TodoWrite',
  'Skill', 'ToolSearch', 'BashOutput', 'ListMcpResourcesTool',
  'ReadMcpResourceTool', 'ReadMcpResourceDirTool'
]);

// Auto-allowed on top of the read-only set when the pane is in acceptEdits mode.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Auto-mode command gate lives in autoMode.js (pure, unit-tested).

function resolveClaudeBin() {
  // claude.cliPath is only used when it names an existing claude(.exe|.cmd|.bat).
  const custom = getSettings().claude.cliPath;
  if (custom && appSettings.isValidCliPath(custom, isFile)) return custom;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.cmd'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd')
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['claude.exe', 'claude.cmd', 'claude.bat']) {
      const candidate = path.join(dir, name);
      try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
    }
  }
  return 'claude';
}

// ----- Permission gate server (loopback only, token-checked) -----
let gateServer = null;
let gatePort = 0;
let gateToken = null;
let permSeq = 0;
const pendingPerms = new Map(); // permId -> { res, chatId }

function bashRuleKey(command) {
  // "npm test -- --runInBand" -> "npm". Good enough for an "always allow npm"
  // rule; anything more clever would imply a guarantee we can't make.
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() || '';
}

function ruleMatches(rule, toolName, input) {
  if (rule.tool !== toolName) return false;
  if (!rule.prefix) return true;
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return bashRuleKey(input && input.command) === rule.prefix;
  }
  return false;
}

function autoDecision(chat, toolName, input) {
  if (chat.permissionMode === 'bypassPermissions') {
    return { decision: 'allow', reason: 'Mac Code: permissions bypassed for this pane' };
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: 'Mac Code: read-only tool' };
  }
  const acceptsEdits = chat.permissionMode === 'acceptEdits' || chat.permissionMode === 'auto';
  if (acceptsEdits && EDIT_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: 'Mac Code: edits accepted for this pane' };
  }
  if (chat.permissionMode === 'auto' &&
      (toolName === 'Bash' || toolName === 'PowerShell') &&
      autoAllowsCommand(input && input.command)) {
    return { decision: 'allow', reason: 'Mac Code: auto mode allows this command' };
  }
  for (const rule of chat.rules) {
    if (ruleMatches(rule, toolName, input)) {
      return { decision: 'allow', reason: 'Mac Code: matched an always-allow rule' };
    }
  }
  return null;
}

function startGateServer() {
  if (gateServer) return Promise.resolve();
  gateToken = crypto.randomBytes(24).toString('hex');
  return new Promise((resolve, reject) => {
    gateServer = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/permission') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers['x-mac-code-token'] !== gateToken) {
        res.writeHead(403).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d) => {
        body += d;
        if (body.length > 4 * 1024 * 1024) { req.destroy(); }
      });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        handlePermissionRequest(payload, res);
      });
    });
    gateServer.on('error', reject);
    // 127.0.0.1 only — never reachable from another machine.
    gateServer.listen(0, '127.0.0.1', () => {
      gatePort = gateServer.address().port;
      resolve();
    });
  });
}

function stopGateServer() {
  for (const [, p] of pendingPerms) {
    try { respondPerm(p.res, 'deny', 'Mac Code closed'); } catch (_) {}
  }
  pendingPerms.clear();
  if (gateServer) {
    try { gateServer.close(); } catch (_) {}
    gateServer = null;
  }
}

function respondPerm(res, decision, reason) {
  if (res.writableEnded) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ decision, reason }));
}

function handlePermissionRequest(payload, res) {
  const chat = chats.get(payload.chatId);
  const event = payload.event || {};
  const toolName = event.tool_name || 'unknown';
  const input = event.tool_input || {};

  if (!chat) { respondPerm(res, 'deny', 'Mac Code: chat pane is gone'); return; }

  const auto = autoDecision(chat, toolName, input);
  if (auto) { respondPerm(res, auto.decision, auto.reason); return; }

  if (!mainWindow || mainWindow.isDestroyed()) {
    respondPerm(res, 'deny', 'Mac Code: no window to ask in');
    return;
  }

  const permId = 'perm-' + (++permSeq);
  pendingPerms.set(permId, { res, chatId: payload.chatId });
  chat.pending.add(permId);

  mainWindow.webContents.send('chat:permission-request', {
    chatId: payload.chatId,
    permId,
    toolName,
    toolUseId: event.tool_use_id || null,
    cwd: event.cwd || chat.cwd,
    input,
    ruleKey: (toolName === 'Bash' || toolName === 'PowerShell')
      ? bashRuleKey(input.command)
      : null
  });
}

ipcMain.on('chat:permission-response', (_event, args = {}) => {
  const entry = pendingPerms.get(args.permId);
  if (!entry) return;
  pendingPerms.delete(args.permId);
  const chat = chats.get(entry.chatId);
  if (chat) chat.pending.delete(args.permId);

  const decision = args.decision === 'allow' ? 'allow' : 'deny';
  if (decision === 'allow' && chat && args.alwaysRule && args.alwaysRule.tool) {
    chat.rules.push({ tool: args.alwaysRule.tool, prefix: args.alwaysRule.prefix || null });
  }
  respondPerm(entry.res, decision, args.reason || (decision === 'allow'
    ? 'Approved in Mac Code'
    : 'Denied in Mac Code'));
});

// ----- Chat process lifecycle -----
function hookSettings() {
  return {
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `node "${path.join(__dirname, 'hooks', 'permission-gate.js')}"`,
          // Generous: the ceiling is how long a human may take to answer the card.
          timeout: 3600
        }]
      }]
    }
  };
}

function releaseChatPerms(chat) {
  for (const permId of chat.pending) {
    const entry = pendingPerms.get(permId);
    if (entry) {
      pendingPerms.delete(permId);
      respondPerm(entry.res, 'deny', 'Mac Code: chat pane closed');
    }
  }
  chat.pending.clear();
}

// `silent` is for a process being replaced on purpose (a model switch): its exit is
// not news the pane should react to, and reporting it would mark a live pane dead.
function killChat(chatId, opts = {}) {
  const chat = chats.get(chatId);
  if (!chat) return;
  if (opts.silent) chat.silentExit = true;
  releaseChatPerms(chat);
  chats.delete(chatId);
  try { chat.proc.stdin.end(); } catch (_) {}
  try { chat.proc.kill(); } catch (_) {}
}

function killAllChats() {
  for (const id of Array.from(chats.keys())) killChat(id);
}

ipcMain.handle('chat:start', async (_event, opts = {}) => {
  const cwd = opts.cwd || defaultCwd();
  const chatId = opts.chatId;
  if (!chatId) return { error: 'no chatId' };
  if (chats.has(chatId)) {
    // A model change relaunches the CLI for the same pane; anything else asking twice
    // is a bug worth surfacing.
    if (!opts.replace) return { error: 'chat already running' };
    killChat(chatId, { silent: true });
  }

  try { await startGateServer(); }
  catch (err) { return { error: 'permission gate failed to start: ' + err.message }; }

  const bin = resolveClaudeBin();
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // --verbose is required alongside -p with stream-json output.
    '--verbose',
    '--include-partial-messages',
    '--settings', JSON.stringify(hookSettings())
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  // Same role as in terminal:create: lets the flow tracker find this chat pane.
  const flowKey = crypto.randomUUID();

  let proc;
  try {
    proc = spawn(bin, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        MAC_CODE_GATE_URL: `http://127.0.0.1:${gatePort}/permission`,
        MAC_CODE_GATE_TOKEN: gateToken,
        MAC_CODE_CHAT_ID: chatId,
        MAC_CODE_FLOW_KEY: flowKey
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    return { error: 'could not launch claude: ' + err.message };
  }

  const chat = {
    proc, cwd, chatId,
    sessionId: opts.resumeSessionId || null,
    model: opts.model || null,
    permissionMode: opts.permissionMode || 'default',
    rules: [],
    buf: '',
    pending: new Set()
  };
  chats.set(chatId, chat);

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (data) => {
    chat.buf += data;
    // stream-json is newline-delimited; a chunk can split mid-line.
    let idx;
    while ((idx = chat.buf.indexOf('\n')) >= 0) {
      const line = chat.buf.slice(0, idx).trim();
      chat.buf = chat.buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); }
      catch { send('chat:stderr', { chatId, text: line }); continue; }
      if (obj.session_id) chat.sessionId = obj.session_id;
      send('chat:event', { chatId, event: obj });
    }
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (text) => send('chat:stderr', { chatId, text }));

  // A replaced process can exit after its successor is already registered, so the map
  // is only cleaned up when the entry is still this process — otherwise the restart
  // would tear down the pane it just brought up.
  const finish = (payload) => {
    if (!chat.silentExit) send('chat:exit', { chatId, ...payload });
    if (chats.get(chatId) === chat) killChat(chatId);
    else releaseChatPerms(chat);
  };

  proc.on('error', (err) => {
    if (!chat.silentExit) send('chat:stderr', { chatId, text: 'spawn error: ' + err.message });
    finish({ code: -1 });
  });

  proc.on('exit', (code) => finish({ code, sessionId: chat.sessionId }));

  return { ok: true, chatId, cwd, bin, pid: proc.pid, flowKey };
});

ipcMain.handle('chat:send', (_event, args = {}) => {
  const chat = chats.get(args.chatId);
  if (!chat) return { error: 'chat not running' };
  const content = Array.isArray(args.content) ? args.content : [];
  if (!content.length) return { error: 'empty message' };
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  try { chat.proc.stdin.write(line); }
  catch (err) { return { error: err.message }; }
  return { ok: true };
});

ipcMain.handle('chat:setPermissionMode', (_event, args = {}) => {
  const chat = chats.get(args.chatId);
  if (!chat) return { error: 'chat not running' };
  chat.permissionMode = args.mode || 'default';
  return { ok: true, mode: chat.permissionMode };
});

ipcMain.handle('chat:interrupt', (_event, args = {}) => {
  const chat = chats.get(args.chatId);
  if (!chat) return { error: 'chat not running' };

  // Deny anything waiting on a card first, or the CLI stays blocked on the hook.
  for (const permId of Array.from(chat.pending)) {
    const entry = pendingPerms.get(permId);
    if (entry) {
      pendingPerms.delete(permId);
      chat.pending.delete(permId);
      respondPerm(entry.res, 'deny', 'Interrupted in Mac Code');
    }
  }

  // An interrupt control request aborts the turn in flight. The process stays up
  // and the session keeps its history, so the pane is usable straight after.
  try {
    chat.proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: 'interrupt-' + Date.now(),
      request: { subtype: 'interrupt' }
    }) + '\n');
  } catch (err) {
    return { error: err.message };
  }
  return { ok: true, sessionId: chat.sessionId };
});

ipcMain.on('chat:stop', (_event, chatId) => killChat(chatId));

// Pasted screenshots land here so the composer has a real path to show and the
// agent has a file it can re-read later in the session.
ipcMain.handle('chat:saveAttachment', async (_event, args = {}) => {
  const dir = path.join(app.getPath('userData'), 'attachments');
  const ext = (args.ext || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const name = `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const target = path.join(dir, name);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(target, Buffer.from(args.base64 || '', 'base64'));
  } catch (err) {
    return { error: err.message };
  }
  return { path: target, name };
});

// ----- IPC: age of a saved session -----
// The saved-session library only started recording savedAt recently, so "how old is
// this session" comes from the CLI's own transcript on disk. Returns null when the
// transcript is gone, which the caller treats as "age unknown" rather than "old".
ipcMain.handle('session:ages', async (_event, entries = []) => {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    let file = null;
    if (entry && entry.id && entry.type === 'copilot') {
      file = path.join(os.homedir(), '.copilot', 'session-state', entry.id, 'events.jsonl');
    } else if (entry && entry.id && entry.cwd) {
      file = path.join(os.homedir(), '.claude', 'projects', encodeCwdForClaude(entry.cwd), entry.id + '.jsonl');
    }
    if (!file) { out.push({ id: entry && entry.id, mtime: null, exists: false }); continue; }
    try {
      const st = await fs.promises.stat(file);
      out.push({ id: entry.id, mtime: st.mtimeMs, exists: true });
    } catch (_) {
      out.push({ id: entry.id, mtime: null, exists: false });
    }
  }
  return out;
});

// ----- IPC: Session persistence -----
function sessionFile() { return path.join(app.getPath('userData'), 'session.json'); }
ipcMain.handle('session:load', async () => {
  const f = sessionFile();
  // Try the live file, then the last-good backup. A direct writeFile truncates the
  // target to 0 before writing, so a quit mid-write leaves an empty/half file; the
  // backup lets us recover instead of booting into a wiped session.
  for (const p of [f, f + '.bak']) {
    try {
      const raw = await fs.promises.readFile(p, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    } catch (_) {}
  }
  return null;
});
ipcMain.on('session:save', (_, data) => {
  // Atomic write: fill a temp file, keep the previous good copy as .bak, then rename
  // over the target. rename() is atomic on the same volume, so a reader never sees a
  // truncated file — it gets either the whole old or the whole new one. Sync so the
  // write completes inside the handler before the app tears down on quit.
  atomicWriteJson(sessionFile(), data);
});

function atomicWriteJson(f, data, space) {
  try {
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, space), 'utf8');
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch (_) {}
    fs.renameSync(tmp, f);
    return true;
  } catch (_) { return false; }
}
async function readJsonWithBackup(f) {
  for (const p of [f, f + '.bak']) {
    try {
      const raw = await fs.promises.readFile(p, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    } catch (_) {}
  }
  return null;
}

// ----- IPC: repo notes -----
// Personal notes per repository (ideas, todo items, which stage a change has reached).
// They live only in Mac Code's own data folder — never in the repo, so nothing here can
// end up in a commit.
function notesFile() { return path.join(app.getPath('userData'), 'repo-notes.json'); }
ipcMain.handle('notes:load', () => readJsonWithBackup(notesFile()));
ipcMain.on('notes:save', (_, data) => { atomicWriteJson(notesFile(), data); });
ipcMain.handle('notes:path', () => notesFile());
// Lets the renderer tell "no notes file yet" from "file there but unreadable" (a failed
// load must never be saved over).
ipcMain.handle('notes:status', () => {
  try { return { exists: fs.existsSync(notesFile()) || fs.existsSync(notesFile() + '.bak') }; } catch (_) { return { exists: false }; }
});

// ----- IPC: note images -----
// Images attached to notes live in userData/note-images, never in the repo. noteImages.js
// validates ids, extensions and bytes; a file name is always `${id}.${ext}` from validated
// parts, and the resolved path must stay inside the folder. Main window only.
function noteImageDir() { return path.join(app.getPath('userData'), 'note-images'); }
function noteImagePath(ref) {
  const name = noteImages.imageFileName(ref);
  if (!name) return null;
  const dir = path.resolve(noteImageDir());
  const p = path.resolve(dir, name);
  return path.dirname(p) === dir ? p : null;
}
ipcMain.handle('notes:imageDir', (e) => (fromMainWindow(e) ? noteImageDir() : { ok: false, error: 'not allowed' }));
ipcMain.handle('notes:saveImage', async (e, args) => {
  if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
  try {
    const { base64, mediaType } = args || {};
    const checked = noteImages.checkImageData(base64, mediaType);
    if (!checked.ok) return checked;
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
    const p = noteImagePath({ id, ext: checked.ext });
    if (!p) return { ok: false, error: 'invalid image name' };
    await fs.promises.mkdir(noteImageDir(), { recursive: true });
    await fs.promises.writeFile(p, checked.buf);
    return { ok: true, image: { id, ext: checked.ext } };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});
ipcMain.handle('notes:readImage', async (e, args) => {
  if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
  try {
    const p = noteImagePath(args);
    if (!p) return { ok: false, error: 'invalid image' };
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    if (st.size > noteImages.MAX_BYTES) return { ok: false, error: 'image is too large' };
    const buf = await fs.promises.readFile(p);
    return { ok: true, base64: buf.toString('base64'), mediaType: noteImages.EXTS[args.ext] };
  } catch (err) { return { ok: false, error: err.code === 'ENOENT' ? 'image not found' : (err.message || String(err)) }; }
});
ipcMain.handle('notes:deleteImage', async (e, args) => {
  if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
  try {
    const p = noteImagePath(args);
    if (!p) return { ok: false, error: 'invalid image' };
    await fs.promises.unlink(p);
    return { ok: true };
  } catch (err) { return err.code === 'ENOENT' ? { ok: true } : { ok: false, error: err.message || String(err) }; }
});
// Removes image files no note refers to. Only plain files named like ours, never recursive.
ipcMain.handle('notes:pruneImages', async (e, keepNames) => {
  if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
  if (!Array.isArray(keepNames) || !keepNames.every((n) => typeof n === 'string')) return { ok: false, error: 'invalid keep list' };
  try {
    const keep = new Set(keepNames);
    const dir = noteImageDir();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, removed: 0 };
      throw err;
    }
    let removed = 0;
    for (const ent of entries) {
      if (!ent.isFile() || !noteImages.isImageFileName(ent.name) || keep.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      // A file saved in the last 10 minutes may just not be referenced yet (a save in flight
      // at startup, or another Mac Code window whose debounced notes save hasn't flushed).
      try { if (Date.now() - (await fs.promises.stat(p)).mtimeMs < 10 * 60 * 1000) continue; } catch (_) { continue; }
      try { await fs.promises.unlink(p); removed++; } catch (_) {}
    }
    return { ok: true, removed };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// ----- IPC: error notes (see the capture block at the top of this file) -----
// Only the main window's webContents may use these. main never writes repo-notes.json —
// the renderer owns that file and rewrites it whole.
ipcMain.on('errors:log', (e, rec) => {
  try {
    if (!fromMainWindow(e) || !rec || typeof rec !== 'object') return;
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const clean = { source: s(rec.source, 100) || 'renderer', name: s(rec.name, 100) || 'Error',
      message: s(rec.message, 4000), stack: s(rec.stack, ERR_ENTRY_MAX), at: Number.isFinite(rec.at) ? rec.at : Date.now() };
    appendErrorLog(clean);
  } catch (_) {}
});
// Returns the queued records, clears them, and from now on main sends errors:note live.
ipcMain.handle('errors:takePending', (e) => {
  try {
    if (!fromMainWindow(e)) return [];
    const list = readPendingErrors();
    writePendingErrors([]);
    errState.rendererReady = true;
    return list;
  } catch (_) { return []; }
});

// ----- IPC: settings -----
// One JSON file in userData, validated by settings.js and cached here. Every change is
// written atomically (pretty-printed: the user may open it in the editor) and pushed to
// the renderer as settings:changed. Only the main window may read or change settings;
// the GitHub popup loads remote pages and must never reach these.
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
const SETTINGS_MAX_BYTES = 256 * 1024;
let settingsCache = null;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function readSettingsFileSync(f) {
  for (const p of [f, f + '.bak']) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    } catch (_) {}
  }
  return null;
}

// Window background before the renderer paints: the saved app theme's --bg.
function startupBackground() {
  try { return themeById(getSettings().general.appTheme).vars['--bg'] || '#0c0c0c'; } catch (_) { return '#0c0c0c'; }
}

function getSettings() {
  if (!settingsCache) settingsCache = appSettings.validate(readSettingsFileSync(settingsFile()));
  return settingsCache;
}

// settings.json.bak is the last-good copy: rewritten after every successful commit
// (including a reload of a hand-edited file), so a settings.json broken later falls back
// to the latest working settings rather than to the state before the last change.
// atomicWriteJson's own pre-rename copy would hold the previous version instead.
function writeLastGoodSettings(next) {
  const bak = settingsFile() + '.bak';
  try {
    const tmp = bak + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, bak);
  } catch (_) {}
}

function commitSettings(next, { write = true } = {}) {
  // A no-op (rejected value, reset while on defaults) must not rewrite the file: it may
  // hold unparsed hand edits the settings.json editor tab is still waiting to reload.
  if (settingsCache && JSON.stringify(next) === JSON.stringify(settingsCache)) return next;
  settingsCache = next;
  if (!write || atomicWriteJson(settingsFile(), next, 2)) writeLastGoodSettings(next);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', next);
  return next;
}

function fromMainWindow(e) {
  return !!(mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents &&
    (!e.senderFrame || e.senderFrame === mainWindow.webContents.mainFrame));
}

// fresh = no settings file yet, so the renderer migrates its legacy localStorage keys.
function settingsSnapshot() {
  const f = settingsFile();
  const fresh = !fs.existsSync(f) && !fs.existsSync(f + '.bak');
  return { settings: getSettings(), fresh };
}

function readJsonFileLimited(p) {
  if (fs.statSync(p).size > SETTINGS_MAX_BYTES) throw new Error('file is too large');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

ipcMain.handle('settings:get', (e) => (fromMainWindow(e) ? settingsSnapshot() : null));
ipcMain.on('settings:getSync', (e) => { e.returnValue = fromMainWindow(e) ? settingsSnapshot() : null; });
ipcMain.handle('settings:set', (e, patch) => {
  if (!fromMainWindow(e)) return null;
  return commitSettings(appSettings.applyPatch(getSettings(), patch));
});
ipcMain.on('settings:setSync', (e, patch) => {
  e.returnValue = fromMainWindow(e) ? commitSettings(appSettings.applyPatch(getSettings(), patch)) : null;
});
ipcMain.handle('settings:reset', (e) => (fromMainWindow(e) ? commitSettings(appSettings.validate(null)) : null));
// After the user saved settings.json in the editor. A parse error keeps the current
// settings and never touches the file; a bad key keeps its current value. The file is
// not rewritten, so the user's own formatting stays.
ipcMain.handle('settings:reload', (e) => {
  if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
  let parsed;
  try { parsed = readJsonFileLimited(settingsFile()); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, settings: commitSettings(appSettings.validate(parsed, getSettings()), { write: false }) };
});
ipcMain.handle('settings:path', (e) => (fromMainWindow(e) ? settingsFile() : null));
// Whether the path-like settings point at something real (null = not set), so the
// settings view can show "hittades inte".
ipcMain.handle('settings:check', (e) => {
  if (!fromMainWindow(e)) return null;
  const s = getSettings();
  return {
    cliPath: s.claude.cliPath ? appSettings.isValidCliPath(s.claude.cliPath, isFile) : null,
    startDir: s.general.startDir ? appSettings.isDriveAbsolutePath(s.general.startDir) && isDirectory(s.general.startDir) : null
  };
});
ipcMain.handle('settings:export', async (e) => {
  if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportera inställningar',
    defaultPath: path.join(app.getPath('documents'), 'mac-code-settings.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify(getSettings(), null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});
// Import goes through the same validator, onto the current settings. The keys in
// settings.js IMPORT_PROTECTED (cliPath, permissionDefault, worktreeTemplate, startDir)
// are never taken from an imported file: a shared file must not pick the binary we
// spawn, its permission mode, or where folders are created and shells start. The
// result's `skipped` lists the ones the file tried to change.
ipcMain.handle('settings:import', async (e) => {
  if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Importera inställningar',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  let parsed;
  try { parsed = readJsonFileLimited(r.filePaths[0]); } catch (err) { return { ok: false, error: err.message }; }
  const { settings, skipped } = appSettings.filterImport(getSettings(), parsed);
  return { ok: true, settings: commitSettings(settings), skipped };
});
ipcMain.handle('app:version', () => app.getVersion());

// ----- IPC: Claude config -----
// The global Claude Code agents, skills and settings.json hooks under ~/.claude. All
// file logic (path building, backups, revs/conflicts, the disabled-hook store) lives in
// claudeConfig.js; here only the main-window gate and the native confirm. The renderer
// never sends a path — only names, ids and the revs it was given by ccfg:list.
let claudeCfg = null;
function claudeConfigStore() {
  if (!claudeCfg) {
    claudeCfg = createClaudeConfig({
      root: path.join(os.homedir(), '.claude'),
      userData: app.getPath('userData'),
      confirm: confirmHookCommand
    });
  }
  return claudeCfg;
}

// A hook command runs as code on every Claude session, so adding one, changing its
// command or re-enabling it is confirmed here in main, never only in the renderer.
const HOOK_CONFIRM = {
  add:    { button: 'Lägg till', message: 'Lägga till en Claude-hook?' },
  update: { button: 'Spara',     message: 'Ändra kommandot för en Claude-hook?' },
  enable: { button: 'Aktivera',  message: 'Aktivera en Claude-hook igen?' }
};
async function confirmHookCommand({ action, event, matcher, command }) {
  const c = HOOK_CONFIRM[action];
  if (!c || !mainWindow || mainWindow.isDestroyed()) return false;
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Claude-hook',
    message: c.message,
    // JSON-quoted so control / invisible characters show as escapes, never as layout.
    detail: 'Kommandot körs vid varje Claude-session.\n\n' +
      'Event: ' + quoteForDisplay(event) + '\n' +
      'Matcher: ' + quoteForDisplay(matcher || '') + (matcher ? '' : ' (alla)') + '\n' +
      'Kommando:\n' + quoteForDisplay(command),
    buttons: [c.button, 'Avbryt'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  return r.response === 0;
}

// Path lookups answer null when refused; everything else { ok:false, error }.
function ccfgHandle(channel, fn, denied = { ok: false, error: 'not allowed' }) {
  ipcMain.handle(channel, async (e, args) => {
    if (!fromMainWindow(e)) return denied;
    try { return await fn(claudeConfigStore(), args && typeof args === 'object' ? args : {}); }
    catch (err) { return denied === null ? null : { ok: false, error: err && err.message ? err.message : String(err) }; }
  });
}
ccfgHandle('ccfg:list',           (c) => c.list());
ccfgHandle('ccfg:agentSetModel',  (c, a) => c.agentSetModel(a));
ccfgHandle('ccfg:agentCreate',    (c, a) => c.agentCreate(a));
ccfgHandle('ccfg:agentDelete',    (c, a) => c.agentDelete(a));
ccfgHandle('ccfg:agentPath',      (c, a) => c.agentPath(a), null);
ccfgHandle('ccfg:skillCreate',    (c, a) => c.skillCreate(a));
ccfgHandle('ccfg:skillDelete',    (c, a) => c.skillDelete(a));
ccfgHandle('ccfg:skillPath',      (c, a) => c.skillPath(a), null);
ccfgHandle('ccfg:hookAdd',        (c, a) => c.hookAdd(a));
ccfgHandle('ccfg:hookUpdate',     (c, a) => c.hookUpdate(a));
ccfgHandle('ccfg:hookRemove',     (c, a) => c.hookRemove(a));
ccfgHandle('ccfg:hookDisable',    (c, a) => c.hookDisable(a));
ccfgHandle('ccfg:hookEnable',     (c, a) => c.hookEnable(a));
ccfgHandle('ccfg:hookScriptPath', (c, a) => c.hookScriptPath(a), null);

// ----- IPC: Claude flows (Settings → Flöden) -----
// ~/.claude/flows/<slug>.json and the skills/<slug>/SKILL.md compiled from them. File
// logic lives in flowStore.js; here only the main-window gate and the native confirm
// before SKILL.md is written. Channels are flowcfg:* because flow:* belongs to the live
// /orchestrate flow-state view (flowState.js).
let flowStoreInst = null;
function flowStore() {
  if (!flowStoreInst) {
    flowStoreInst = createFlowStore({
      root: path.join(os.homedir(), '.claude'),
      userData: app.getPath('userData'),
      confirm: confirmSkillWrite,
      claudeConfig: claudeConfigStore()
    });
  }
  return flowStoreInst;
}

// The SKILL.md text is loaded into every Claude session that uses the skill, so the
// write is confirmed here in main, never only in the renderer (R7).
// When the dialog cannot show every changed line, a third button writes the full diff
// to userData/flow-preview/ and opens it; then the same dialog comes back, until the
// user picks Skriv or Avbryt.
async function confirmSkillWrite(info) {
  const t = skillConfirmText(info);
  const buttons = t.truncated ? [t.button, 'Visa alla ändringar', 'Avbryt'] : [t.button, 'Avbryt'];
  const cancel = buttons.length - 1;
  for (;;) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Claude-skill',
      message: t.message,
      detail: t.detail,
      buttons,
      defaultId: cancel,
      cancelId: cancel,
      noLink: true
    });
    if (r.response === 0) return true;
    if (!t.truncated || r.response !== 1) return false;
    try {
      const file = writeDiffFile({ userData: app.getPath('userData'), slug: info.slug, text: diffText(info) });
      const err = await shell.openPath(file);
      if (err) await dialog.showMessageBox(mainWindow, { type: 'error', title: 'Claude-skill', message: 'Kunde inte öppna diffen', detail: file + '\n' + err, buttons: ['OK'], noLink: true });
    } catch (err) {
      await dialog.showMessageBox(mainWindow, { type: 'error', title: 'Claude-skill', message: 'Kunde inte skriva diffen', detail: err && err.message ? err.message : String(err), buttons: ['OK'], noLink: true });
    }
  }
}

function flowHandle(channel, fn) {
  ipcMain.handle(channel, async (e, args) => {
    if (!fromMainWindow(e)) return { ok: false, error: 'not allowed' };
    try { return await fn(flowStore(), args && typeof args === 'object' ? args : {}); }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  });
}
flowHandle('flowcfg:list',       (s) => s.flowList());
flowHandle('flowcfg:get',        (s, a) => s.flowGet(a));
flowHandle('flowcfg:save',       (s, a) => s.flowSave(a));
flowHandle('flowcfg:delete',     (s, a) => s.flowDelete(a));
flowHandle('flowcfg:preview',    (s, a) => s.flowPreview(a));
flowHandle('flowcfg:writeSkill', (s, a) => s.flowWriteSkill(a));
