const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const pty = require('node-pty');

app.setName('Mac Code');
app.setAppUserModelId('Mac Code');
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

  // Ctrl+Z is intercepted in main process so menu accelerators, browser textarea
  // undo, and xterm's textarea handlers can't swallow it first. Renderer applies
  // chunk-level undo on the active pane.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
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

  mainWindow.on('closed', () => {
    for (const [, p] of ptys) {
      try { p.kill(); } catch (_) {}
    }
    ptys.clear();
    killAllChats();
    stopGateServer();
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
      sessionId: path.basename(target.p, '.jsonl'),
      mtime: target.mtime
    };
  } catch (err) {
    return { error: err.code || err.message };
  }
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
  const err = await shell.openPath(p);
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

// ----- Auto mode -----
// Auto mode = accept edits, plus shell commands that only inspect state or run the
// project's own checks. Everything else still asks. The allowlist is on the command
// head (plus a second word for subcommand-scoped tools like git), and any command
// containing a risky token is asked about regardless of its head, so an allowlisted
// head can't smuggle something through a pipe or a chained `&&`.
const AUTO_SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'type', 'head', 'tail', 'wc',
  'find', 'findstr', 'grep', 'rg', 'where', 'which', 'tree', 'stat',
  'date', 'whoami', 'hostname', 'env', 'printenv', 'set',
  'node', 'python', 'python3', 'py', 'dotnet', 'go', 'cargo', 'tsc',
  'eslint', 'prettier', 'pytest', 'jest', 'vitest'
]);

// Command heads whose safety depends on the subcommand.
const AUTO_SAFE_SUBCOMMANDS = {
  git: new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'blame',
                'describe', 'rev-parse', 'ls-files', 'shortlog', 'stash']),
  npm: new Set(['test', 'run', 'ls', 'list', 'view', 'outdated', 'why', 'audit']),
  pnpm: new Set(['test', 'run', 'ls', 'list', 'why', 'outdated']),
  yarn: new Set(['test', 'run', 'list', 'why', 'outdated']),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'api'])
};

// Substrings that force a prompt wherever they appear in the command line.
const AUTO_RISKY = [
  /\brm\b/i, /\brmdir\b/i, /\bdel\b/i, /\berase\b/i, /remove-item/i,
  /\bmv\b/i, /\bmove\b/i, /\bformat\b/i, /\bdd\b/i, /\bmkfs/i,
  /\bsudo\b/i, /\brunas\b/i, /\bicacls\b/i, /\bchmod\b/i, /\bchown\b/i,
  /\bcurl\b/i, /\bwget\b/i, /invoke-webrequest/i, /invoke-restmethod/i,
  /\bssh\b/i, /\bscp\b/i, /\bftp\b/i, /\bnc\b/i,
  /\bshutdown\b/i, /\brestart-computer\b/i, /\breg\b\s/i, /\bschtasks\b/i,
  /\bsc\b\s/i, /\btaskkill\b/i, /stop-process/i, /\bkill\b/i,
  /\bnpm\s+(i|install|publish|link|unpublish)\b/i,
  /\bgit\s+(push|reset|clean|rebase|checkout|switch|restore|filter-branch)\b/i,
  />\s*\S/, />>/,               // output redirection writes files
  /\biex\b/i, /invoke-expression/i, /\beval\b/i,
  /\|\s*(sh|bash|pwsh|powershell|cmd)\b/i
];

function autoAllowsCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (AUTO_RISKY.some((re) => re.test(cmd))) return false;

  // Every segment of a chained command has to clear the bar on its own.
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;

  return segments.every((seg) => {
    const words = seg.split(/\s+/);
    const head = (words[0] || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop()
      .replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
    const subs = AUTO_SAFE_SUBCOMMANDS[head];
    if (subs) {
      const sub = (words[1] || '').toLowerCase();
      return subs.has(sub);
    }
    return AUTO_SAFE_COMMANDS.has(head);
  });
}

function resolveClaudeBin() {
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

function killChat(chatId) {
  const chat = chats.get(chatId);
  if (!chat) return;
  for (const permId of chat.pending) {
    const entry = pendingPerms.get(permId);
    if (entry) {
      pendingPerms.delete(permId);
      respondPerm(entry.res, 'deny', 'Mac Code: chat pane closed');
    }
  }
  chat.pending.clear();
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
  if (chats.has(chatId)) return { error: 'chat already running' };

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

  let proc;
  try {
    proc = spawn(bin, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        MAC_CODE_GATE_URL: `http://127.0.0.1:${gatePort}/permission`,
        MAC_CODE_GATE_TOKEN: gateToken,
        MAC_CODE_CHAT_ID: chatId
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

  proc.on('error', (err) => {
    send('chat:stderr', { chatId, text: 'spawn error: ' + err.message });
    send('chat:exit', { chatId, code: -1 });
    killChat(chatId);
  });

  proc.on('exit', (code) => {
    send('chat:exit', { chatId, code, sessionId: chat.sessionId });
    killChat(chatId);
  });

  return { ok: true, chatId, cwd, bin, pid: proc.pid };
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
  try { return JSON.parse(await fs.promises.readFile(sessionFile(), 'utf8')); }
  catch (_) { return null; }
});
ipcMain.on('session:save', async (_, data) => {
  try { await fs.promises.writeFile(sessionFile(), JSON.stringify(data), 'utf8'); }
  catch (_) {}
});
