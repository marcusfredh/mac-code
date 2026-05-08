const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

let mainWindow = null;
const ptys = new Map();

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

function defaultCwd() {
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
    backgroundColor: '#0c0c0c',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Position in two steps: setPosition first so setBounds uses target display DPI.
  // Fixes multi-display sizing bug where constructor uses primary display scale.
  mainWindow.setPosition(x, y);
  mainWindow.setBounds({ x, y, width, height });

  mainWindow.loadFile('renderer.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.setBounds({ x, y, width, height });
    if (fillsScreen) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', 'normal'));

  mainWindow.on('closed', () => {
    for (const [, p] of ptys) {
      try { p.kill(); } catch (_) {}
    }
    ptys.clear();
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ----- IPC: terminal -----
ipcMain.handle('terminal:create', (event, opts = {}) => {
  const shell = resolveShell();
  const cols = opts.cols || 80;
  const rows = opts.rows || 24;
  const cwd = opts.cwd || defaultCwd();

  const ptyProcess = pty.spawn(shell, shellArgs(shell), {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env,
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
  });

  return { id, shell, cwd };
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
  }
});

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

// ----- IPC: Claude session usage -----
function encodeCwdForClaude(cwd) {
  return cwd.replace(/[:\\/\s]/g, '-');
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
    if (!lastUsage) return null;

    const input = lastUsage.input_tokens || 0;
    const cacheRead = lastUsage.cache_read_input_tokens || 0;
    const cacheCreate = lastUsage.cache_creation_input_tokens || 0;
    const output = lastUsage.output_tokens || 0;
    const contextTokens = input + cacheRead + cacheCreate;

    // Resolve selected model label from latest /model slash-command output.
    // This is authoritative for both display and context window size.
    let selectedModelLabel = null;
    let oneMFromCommand = false;
    const setModelLines = content.match(/Set model to[^\n]*/g);
    if (setModelLines && setModelLines.length > 0) {
      const last = setModelLines[setModelLines.length - 1];
      selectedModelLabel = last
        .replace(/^Set model to\s*/i, '')
        .replace(/\\u001b\[[0-9;]*m/g, '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/<\/?[a-z-]+>/g, '')
        .replace(/["{\\<].*$/, '')
        .trim();
      oneMFromCommand = /\(1M context\)|\[1m\]/i.test(selectedModelLabel);
    }

    const oneMFromBeta = /context-1m/.test(content);
    const oneMFromModel = /\b1m\b|\[1m\]/i.test(model || '');

    let oneMFromSettings = false;
    try {
      const settingsRaw = await fs.promises.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
      const settingsModel = JSON.parse(settingsRaw)?.model || '';
      oneMFromSettings = /\[1m\]|\(1M context\)/i.test(settingsModel);
    } catch (_) {}

    const contextWindow = (oneMFromCommand || oneMFromBeta || oneMFromModel || oneMFromSettings || contextTokens > 200000)
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
      mtime: target.mtime
    };
  } catch (err) {
    return { error: err.code || err.message };
  }
});
