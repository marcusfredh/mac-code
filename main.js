const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
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
