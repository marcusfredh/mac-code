// Global Claude Code configuration (~/.claude): agents, skills and the `hooks` key of
// settings.json. Pure (no electron) so it can be unit-tested against a temp folder;
// main.js only wires the IPC and the native confirm dialog around createClaudeConfig().
//
// Safety rules, all enforced here:
// - The renderer never sends paths. Every path is built from a validated name and a
//   fixed base, and must resolve to a direct child of that base (checked on the
//   UN-resolved path: skills are often junctions into ~/.agents/skills).
// - Every write first backs up the previous content to <root>/backups/mac-code/, then
//   writes atomically (tmp + rename). A failed backup aborts the write.
// - Optimistic concurrency: list() returns a rev (sha1 of the file's bytes) per file;
//   a write carrying a different rev than what is on disk gets { conflict: true }.
//   Claude Code rewrites settings.json itself, so this happens.
// - settings.json: only `hooks` changes; every other key is kept. A file that is not
//   valid JSON is never overwritten.
// - Adding a hook, changing its command or re-enabling it runs code on every Claude
//   session, so those go through the injected confirm() (a native dialog in main).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_READ_BYTES = 1024 * 1024;
const KNOWN_EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart',
  'SubagentStop', 'PreCompact'
]);
// '' is not offered: "Ärv" writes `model: inherit` (R4).
const MODELS = Object.freeze(['inherit', 'opus', 'sonnet', 'haiku', 'fable']);
const DESC_MAX = 1000;
const MATCHER_MAX = 1000;
const COMMAND_MAX = 2000;
// Characters that could make the native confirm show something other than what runs:
// line breaks and other C0/C1 controls, bidi overrides/isolates/marks, zero-width chars.
const UNSAFE_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/;
const EVENT_RE = /^[A-Za-z]{1,40}$/;
const BAD_COMMAND = 'Kommandot innehåller otillåtna tecken';
const BAD_MATCHER = 'Matchern innehåller otillåtna tecken';
const ONLY_COMMAND_ENABLE = 'Bara command-hooks kan slås på här';
const BROKEN_DISABLED = 'claude-disabled-hooks.json är trasig — rätta eller ta bort filen';
const TIMEOUT_MAX = 86400;
const DISABLED_FILE = 'claude-disabled-hooks.json';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !RESERVED_RE.test(name);
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,79}$/;
function validModel(m) { return typeof m === 'string' && MODEL_RE.test(m); }

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// ---------------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------------
// Only the subset Claude Code files use: `key: value` lines at column 0 between a
// leading `---` fence and the next `---` line. A key's value may continue on indented
// lines (block scalars `>`/`|`, lists, nested maps); those lines belong to the key and
// are preserved verbatim unless that exact key is replaced.

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*)|[ \t]*)$/;

function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }

// -> { lines, start, end } where lines[start..end) are the lines between the fences, or
// null when the text has no frontmatter.
function splitFence(text) {
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = src.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0])) return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) return { lines, start: 1, end: i };
  }
  return null;
}

// Lines [i+1 ..] that continue the key on line i: indented or blank, trailing blank
// lines excluded. Returns the index after the last continuation line.
function continuationEnd(lines, i, end) {
  let j = i + 1;
  let last = i;
  while (j < end && (lines[j].trim() === '' || /^[ \t]/.test(lines[j]))) {
    if (lines[j].trim() !== '') last = j;
    j++;
  }
  return last + 1;
}

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s); } catch (_) { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function displayValue(first, cont) {
  const block = /^([>|])([-+]?)\d*[ \t]*(#.*)?$/.exec(first);
  if (block) {
    const nonBlank = cont.filter((l) => l.trim() !== '');
    const indent = nonBlank.length ? Math.min(...nonBlank.map((l) => /^[ \t]*/.exec(l)[0].length)) : 0;
    const body = cont.map((l) => l.slice(indent).replace(/[ \t]+$/, ''));
    if (block[1] === '|') return body.join('\n').replace(/\n+$/, '');
    // Folded: lines join with spaces; a blank line is a paragraph break.
    let out = '';
    for (const l of body) {
      if (l === '') out += '\n';
      else out += (out === '' || out.endsWith('\n') ? '' : ' ') + l;
    }
    return out.replace(/\n+$/, '');
  }
  const nonBlank = cont.map((l) => l.trim()).filter(Boolean);
  if (first === '' && nonBlank.length && nonBlank.every((l) => l.startsWith('- '))) {
    return nonBlank.map((l) => unquote(l.slice(2))).join(', ');
  }
  if (first === '' && nonBlank.length) return nonBlank.join(' ');
  return unquote([first, ...nonBlank].join(' '));
}

function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const fence = splitFence(src);
  if (!fence) return { fields: {}, order: [], body: src, hasFm: false };
  const { lines, start, end } = fence;
  const fields = {};
  const order = [];
  for (let i = start; i < end; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;
    const stop = continuationEnd(lines, i, end);
    const key = m[1];
    if (!(key in fields)) order.push(key);
    fields[key] = displayValue((m[2] || '').trim(), lines.slice(i + 1, stop));
    i = stop - 1;
  }
  // Body = everything after the closing fence line, in the original line endings.
  const body = bodyAfterFence(src, end);
  return { fields, order, body, hasFm: true };
}

function bodyAfterFence(src, fenceLineIndex) {
  const s = src.charCodeAt(0) === 0xFEFF ? src.slice(1) : src;
  let pos = 0;
  for (let n = 0; n <= fenceLineIndex; n++) {
    const nl = s.indexOf('\n', pos);
    if (nl < 0) return '';
    pos = nl + 1;
  }
  return s.slice(pos);
}

const PLAIN_RE = /^[A-Za-z0-9 ._,()\/-]+$/;
const YAML_INDICATOR_RE = /^[-?:,\[\]{}#&*!|>'"%@` ]/;
// A single-line YAML scalar: plain when it is obviously safe, else a JSON string
// (valid YAML double-quoted). CR/LF never reach the file.
function formatValue(value) {
  const s = String(value).replace(/[\r\n]+/g, ' ');
  if (s !== '' && PLAIN_RE.test(s) && !YAML_INDICATOR_RE.test(s) && !/ $/.test(s)) return s;
  return JSON.stringify(s);
}

// Replace, add (before the closing fence) or remove (value null) one top-level key.
// Everything else — other keys, their continuation lines, the body, the line endings —
// stays byte-identical.
function setFrontmatterField(text, key, value) {
  const src = String(text == null ? '' : text);
  if (!KEY_RE.test(key + ':')) throw new Error('invalid key');
  const eol = eolOf(src);
  const bom = src.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '';
  const fence = splitFence(src);
  const line = value == null ? null : key + ': ' + formatValue(value);
  if (!fence) {
    if (line == null) return src;
    return bom + '---' + eol + line + eol + '---' + eol + src.slice(bom.length);
  }
  const { lines, start, end } = fence;
  const out = lines.slice(0, start);
  let done = false;
  for (let i = start; i < end; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (m && m[1] === key) {
      const stop = continuationEnd(lines, i, end);
      if (!done && line != null) out.push(line);
      done = true;
      i = stop - 1;
      continue;
    }
    out.push(lines[i]);
  }
  if (!done && line != null) out.push(line);
  for (let i = end; i < lines.length; i++) out.push(lines[i]);
  return bom + out.join(eol);
}

function agentTemplate({ name, description, model }) {
  const m = model && validModel(model) ? model : 'inherit';
  return [
    '---',
    'name: ' + formatValue(name),
    'description: ' + formatValue(description || name),
    'model: ' + m,
    '---',
    '',
    'You are the ' + name + ' agent.',
    '',
    'Describe the role, the rules it follows and the output it returns.',
    ''
  ].join('\n');
}

function skillTemplate({ name, description }) {
  return [
    '---',
    'name: ' + formatValue(name),
    'description: ' + formatValue(description || name),
    '---',
    '',
    '# ' + name,
    '',
    'Describe when this skill applies and the steps to follow.',
    ''
  ].join('\n');
}

// ---------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------
// settings.json `hooks`: { <Event>: [ { matcher?, hooks: [ { type, command, ... } ] } ] }

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function matcherOf(group) { return typeof group.matcher === 'string' ? group.matcher : ''; }

function hookIdBase(event, matcher, hook) {
  return sha1(event + '\0' + matcher + '\0' + JSON.stringify(hook)).slice(0, 12);
}

// -> [{ id, event, matcher, index:{group, hook}, command, timeout, type, statusMessage }]
// id is content-based (stable across reordering); `:n` tells identical hooks apart.
function flattenHooks(hooksObj) {
  const out = [];
  if (!isObj(hooksObj)) return out;
  const seen = new Map();
  for (const event of Object.keys(hooksObj)) {
    const groups = hooksObj[event];
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      if (!isObj(group) || !Array.isArray(group.hooks)) return;
      const matcher = matcherOf(group);
      group.hooks.forEach((hook, hi) => {
        if (!isObj(hook)) return;
        const base = hookIdBase(event, matcher, hook);
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        out.push({
          id: base + ':' + n,
          event,
          matcher,
          index: { group: gi, hook: hi },
          command: typeof hook.command === 'string' ? hook.command : '',
          timeout: typeof hook.timeout === 'number' ? hook.timeout : null,
          type: typeof hook.type === 'string' ? hook.type : '',
          statusMessage: typeof hook.statusMessage === 'string' ? hook.statusMessage : null
        });
      });
    });
  }
  return out;
}

function findHook(hooksObj, id) {
  return flattenHooks(hooksObj).find((h) => h.id === id) || null;
}

function insertHook(hooks, event, matcher, hook) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  // Missing and "" matcher are the same group (R9); "*" is its own.
  const group = hooks[event].find((g) => isObj(g) && Array.isArray(g.hooks) && matcherOf(g) === matcher);
  if (group) group.hooks.push(hook);
  else hooks[event].push(matcher === '' ? { hooks: [hook] } : { matcher, hooks: [hook] });
}

function prune(hooks) {
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.filter((g) => !(isObj(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (hooks[event].length === 0) delete hooks[event];
  }
  return hooks;
}

// Pure: returns a new hooks object. Throws on an unknown id or a forbidden change.
function applyHookOp(hooksObj, op) {
  const hooks = isObj(hooksObj) ? JSON.parse(JSON.stringify(hooksObj)) : {};
  if (!op || typeof op !== 'object') throw new Error('invalid op');
  if (op.op === 'add') {
    if (typeof op.event !== 'string' || !op.event) throw new Error('invalid event');
    if (!isObj(op.hook)) throw new Error('invalid hook');
    insertHook(hooks, op.event, typeof op.matcher === 'string' ? op.matcher : '', JSON.parse(JSON.stringify(op.hook)));
    return prune(hooks);
  }
  const found = findHook(hooks, op.id);
  if (!found) throw new Error('hook not found');
  const group = hooks[found.event][found.index.group];
  const hook = group.hooks[found.index.hook];
  if (op.op === 'remove') {
    group.hooks.splice(found.index.hook, 1);
    return prune(hooks);
  }
  if (op.op === 'update') {
    if (op.command !== undefined && op.command !== hook.command) {
      if (hook.type !== 'command') throw new Error('only command hooks have an editable command');
      hook.command = op.command;
    }
    if (op.timeout === null) delete hook.timeout;
    else if (op.timeout !== undefined) hook.timeout = op.timeout;
    if (op.matcher !== undefined && op.matcher !== found.matcher) {
      group.hooks.splice(found.index.hook, 1);
      insertHook(hooks, found.event, op.matcher, hook);
    }
    return prune(hooks);
  }
  throw new Error('unknown op');
}

// The file under <hooksDir> a hook command runs, or null (R6). Tokens are quoted
// strings or bare words; ~ / $HOME / %USERPROFILE% expand to `home`.
function findHookScript(command, hooksDir, { home, platform = process.platform, isFile = defaultIsFile } = {}) {
  if (typeof command !== 'string' || !command) return null;
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const base = pathMod.resolve(hooksDir);
  const norm = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) {
    let tok = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
    if (!/[\\/]/.test(tok)) continue;
    if (home) tok = tok.replace(/^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=[\\/])/i, home.replace(/\$/g, '$$$$'));
    tok = tok.replace(/[\\/]/g, pathMod.sep);
    if (!pathMod.isAbsolute(tok)) continue;
    const p = pathMod.resolve(tok);
    const rel = pathMod.relative(norm(base), norm(p));
    if (!rel || rel.startsWith('..') || pathMod.isAbsolute(rel)) continue;
    if (isFile(p)) return p;
  }
  return null;
}

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

// ---------------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------------

function readCapped(p) {
  const st = fs.statSync(p);
  if (st.size > MAX_READ_BYTES) throw new Error('file is too large');
  return fs.readFileSync(p);
}

// rev of a file: sha1 of its bytes, null when it does not exist.
function revOf(p) {
  try { return sha1(readCapped(p)); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function atomicWriteText(f, text) {
  // Write through a symlinked file to its target rather than replacing the link.
  let dest = f;
  try { if (fs.lstatSync(f).isSymbolicLink()) dest = fs.realpathSync(f); } catch (_) {}
  const tmp = dest + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// base/<name><ext>, only for a valid name and only when it is a direct child of base.
function childPath(base, name, ext = '') {
  if (!validName(name)) return null;
  const b = path.resolve(base);
  const p = path.resolve(b, name + ext);
  return samePath(path.dirname(p), b) ? p : null;
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function stamp(d) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + pad(d.getMilliseconds(), 3);
}

function countFiles(dir, limit = 10000) {
  let n = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (n >= limit) return;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(path.join(d, ent.name));
      else n++;
    }
  };
  try { walk(dir); } catch (_) {}
  return n;
}

// Copy a real skill folder for backup. Links inside it (symlinks / junctions) are not
// recreated — that needs privileges on Windows and the target is not ours — but
// listed in <dest>/.mac-code-links.json as { path (relative), target }.
const LINKS_MANIFEST = '.mac-code-links.json';
function copyTreeForBackup(src, dest) {
  const links = [];
  const walk = (from, to, rel) => {
    fs.mkdirSync(to);
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, ent.name);
      const t = path.join(to, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(f); } catch (_) {}
        links.push({ path: r, target });
      } else if (st.isDirectory()) walk(f, t, r);
      else if (st.isFile()) fs.copyFileSync(f, t, fs.constants.COPYFILE_EXCL);
    }
  };
  walk(src, dest, '');
  if (links.length) fs.writeFileSync(path.join(dest, LINKS_MANIFEST), JSON.stringify(links, null, 2) + '\n', { flag: 'wx' });
}

function fail(error, extra) { return Object.assign({ ok: false, error }, extra); }
function errMsg(err) { return err && err.message ? err.message : String(err); }

function cleanLine(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function parseTimeout(t) {
  if (t === undefined || t === null || t === '') return { value: null };
  const n = typeof t === 'number' ? t : /^\s*\d+\s*$/.test(String(t)) ? Number(t) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > TIMEOUT_MAX) return { error: 'timeout must be a whole number of seconds (1-' + TIMEOUT_MAX + ')' };
  return { value: n };
}

function parseMatcher(m) {
  if (m === undefined || m === null) return { value: '' };
  if (typeof m !== 'string' || m.length > MATCHER_MAX) return { error: 'invalid matcher' };
  if (UNSAFE_CHARS_RE.test(m)) return { error: BAD_MATCHER };
  return { value: m.trim() };
}

function parseCommand(c) {
  if (typeof c !== 'string' || !c.trim() || c.length > COMMAND_MAX) return { error: 'invalid command' };
  if (UNSAFE_CHARS_RE.test(c)) return { error: BAD_COMMAND };
  return { value: c.trim() };
}

// JSON.stringify, plus \uXXXX for the invisible / bidi characters JSON leaves raw, so
// a native dialog shows exactly what the string holds.
const UNSAFE_CHARS_G = new RegExp(UNSAFE_CHARS_RE.source, 'g');
function quoteForDisplay(s) {
  return JSON.stringify(String(s == null ? '' : s))
    .replace(UNSAFE_CHARS_G, (ch) => '\\u' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
}

function validEvent(e) { return typeof e === 'string' && EVENT_RE.test(e); }

// A disabled-store entry that may be shown in the native confirm and re-inserted:
// only plain command hooks, every shown field passing the same checks as a new hook.
function checkEnableEntry(entry) {
  const hook = entry.hook;
  if (hook.type !== 'command') return ONLY_COMMAND_ENABLE;
  if (!validEvent(entry.event)) return 'invalid event';
  if (entry.matcher !== undefined && entry.matcher !== null) {
    const m = parseMatcher(entry.matcher);
    if (m.error) return m.error;
    if (m.value !== entry.matcher) return 'invalid matcher';
  }
  const c = parseCommand(hook.command);
  if (c.error) return c.error;
  if (c.value !== hook.command) return 'invalid command';
  if (typeof hook.statusMessage === 'string' && UNSAFE_CHARS_RE.test(hook.statusMessage)) return 'invalid statusMessage';
  return null;
}

// ---------------------------------------------------------------------------------
// The store: every operation against one root (~/.claude) and one userData folder.
// confirm({ action: 'add'|'update'|'enable', event, matcher, command }) -> Promise<bool>
// ---------------------------------------------------------------------------------

function createClaudeConfig({ root, userData, confirm, now = () => new Date() }) {
  if (!root || !userData) throw new Error('root and userData are required');
  root = path.resolve(root);
  const agentsDir = path.join(root, 'agents');
  const skillsDir = path.join(root, 'skills');
  const hooksDir = path.join(root, 'hooks');
  const settingsPath = path.join(root, 'settings.json');
  const backupDir = path.join(root, 'backups', 'mac-code');
  const disabledPath = path.join(userData, DISABLED_FILE);
  const home = path.dirname(root);
  const ask = typeof confirm === 'function' ? confirm : async () => false;

  // ---- backups (R10: unique name, never overwrite) ----
  function backupTarget(basename) {
    fs.mkdirSync(backupDir, { recursive: true });
    const st = stamp(now());
    for (let n = 1; n < 1000; n++) {
      const p = path.join(backupDir, st + '-' + n + '-' + basename);
      if (!fs.existsSync(p)) return p;
    }
    throw new Error('no free backup name');
  }
  function backupFile(src, basename) {
    if (!fs.existsSync(src)) return null;
    const dest = backupTarget(basename);
    fs.writeFileSync(dest, readCapped(src), { flag: 'wx' });
    return dest;
  }

  // ---- settings.json ----
  function readSettings() {
    let raw;
    try { raw = readCapped(settingsPath); } catch (err) {
      if (err.code === 'ENOENT') return { obj: {}, rev: null };
      return { error: errMsg(err) };
    }
    let obj;
    try {
      let text = raw.toString('utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      obj = text.trim() ? JSON.parse(text) : {};
    } catch (err) { return { error: 'settings.json is not valid JSON: ' + errMsg(err), rev: sha1(raw) }; }
    if (!isObj(obj)) return { error: 'settings.json is not a JSON object', rev: sha1(raw) };
    if (obj.hooks !== undefined && !isObj(obj.hooks)) return { error: 'settings.json "hooks" is not an object', rev: sha1(raw) };
    return { obj, rev: sha1(raw) };
  }
  function loadSettingsFor(rev) {
    const s = readSettings();
    if (s.error) return { res: fail(s.error) };
    if ((rev == null ? null : rev) !== s.rev) return { res: fail('settings.json changed on disk — reload', { conflict: true }) };
    return { s };
  }
  function writeSettings(obj, hooks) {
    const next = Object.assign({}, obj);
    if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
    backupFile(settingsPath, 'settings.json');
    atomicWriteText(settingsPath, JSON.stringify(next, null, 2) + '\n');
  }

  // ---- disabled-hook store (Mac Code's own file) ----
  // -> { list } or { list: [], error } when the file exists but is unreadable, not JSON,
  // not an array or holds a malformed entry. A broken store is never overwritten.
  function readDisabled() {
    let raw;
    try { raw = readCapped(disabledPath); } catch (err) {
      if (err.code === 'ENOENT') return { list: [] };
      return { list: [], error: BROKEN_DISABLED };
    }
    let arr;
    try { arr = JSON.parse(raw.toString('utf8')); } catch (_) { return { list: [], error: BROKEN_DISABLED }; }
    const okEntry = (e) => isObj(e) && typeof e.id === 'string' && typeof e.event === 'string' && isObj(e.hook) &&
      (e.matcher === undefined || e.matcher === null || typeof e.matcher === 'string');
    if (!Array.isArray(arr) || !arr.every(okEntry)) return { list: [], error: BROKEN_DISABLED };
    return { list: arr };
  }
  function writeDisabled(list) {
    fs.mkdirSync(userData, { recursive: true });
    atomicWriteText(disabledPath, JSON.stringify(list, null, 2) + '\n');
  }

  function scriptFor(command) { return findHookScript(command, hooksDir, { home }); }

  // ---- list ----
  function listAgents() {
    let names;
    try { names = fs.readdirSync(agentsDir); } catch (_) { return []; }
    const out = [];
    for (const file of names.sort()) {
      if (!/\.md$/i.test(file)) continue;
      const p = path.join(agentsDir, file);
      try { if (!fs.statSync(p).isFile()) continue; } catch (_) { continue; }
      const id = file.slice(0, -3);
      const entry = { id, name: id, description: '', model: '', tools: '', rev: null, readonly: !validName(id) };
      try {
        const raw = readCapped(p);
        entry.rev = sha1(raw);
        const fm = parseFrontmatter(raw.toString('utf8'));
        entry.name = fm.fields.name || id;
        entry.description = fm.fields.description || '';
        entry.model = fm.fields.model || '';
        entry.tools = fm.fields.tools || '';
      } catch (err) { entry.readonly = true; entry.error = errMsg(err); }
      out.push(entry);
    }
    return out;
  }

  function listSkills() {
    let names;
    try { names = fs.readdirSync(skillsDir); } catch (_) { return []; }
    const out = [];
    for (const id of names.sort()) {
      const dir = path.join(skillsDir, id);
      const skillMd = path.join(dir, 'SKILL.md');
      try {
        if (!fs.statSync(dir).isDirectory() || !fs.statSync(skillMd).isFile()) continue;
      } catch (_) { continue; }
      let linked = false;
      let target = null;
      try { linked = fs.lstatSync(dir).isSymbolicLink(); } catch (_) {}
      if (linked) { try { target = fs.realpathSync(dir); } catch (_) {} }
      const entry = {
        id, name: id, description: '', rev: null, files: linked ? null : countFiles(dir),
        linked, target, readonly: !validName(id)
      };
      try {
        const raw = readCapped(skillMd);
        entry.rev = sha1(raw);
        const fm = parseFrontmatter(raw.toString('utf8'));
        entry.name = fm.fields.name || id;
        entry.description = fm.fields.description || '';
      } catch (err) { entry.readonly = true; entry.error = errMsg(err); }
      out.push(entry);
    }
    return out;
  }

  function list() {
    const s = readSettings();
    const hooks = s.error ? [] : flattenHooks(s.obj.hooks).map((h) => Object.assign(h, {
      enabled: true,
      editable: h.type === 'command',
      script: h.type === 'command' ? scriptFor(h.command) : null
    }));
    const store = readDisabled();
    const disabled = store.list.map((d) => {
      const h = d.hook;
      const type = typeof h.type === 'string' ? h.type : '';
      const command = typeof h.command === 'string' ? h.command : '';
      return {
        id: d.id,
        event: d.event,
        matcher: typeof d.matcher === 'string' ? d.matcher : '',
        command,
        timeout: typeof h.timeout === 'number' ? h.timeout : null,
        type,
        statusMessage: typeof h.statusMessage === 'string' ? h.statusMessage : null,
        disabledAt: d.disabledAt || null,
        enabled: false,
        editable: false,
        script: type === 'command' ? scriptFor(command) : null
      };
    });
    const res = {
      ok: true,
      agents: listAgents(),
      skills: listSkills(),
      hooks,
      disabled,
      settingsRev: s.rev == null ? null : s.rev,
      paths: { root }
    };
    if (s.error) res.settingsError = s.error;
    if (store.error) res.disabledError = store.error;
    return res;
  }

  // ---- agents ----
  function agentFile(name) { return childPath(agentsDir, name, '.md'); }

  function agentPath({ name } = {}) {
    const p = agentFile(name);
    return p && defaultIsFile(p) ? p : null;
  }

  function agentSetModel({ name, model, rev } = {}) {
    const p = agentFile(name);
    if (!p) return fail('invalid name');
    if (!validModel(model)) return fail('invalid model');
    try {
      const raw = readCapped(p);
      if (sha1(raw) !== rev) return fail('the agent file changed on disk — reload', { conflict: true });
      const next = setFrontmatterField(raw.toString('utf8'), 'model', model);
      backupFile(p, 'agent-' + name + '.md');
      atomicWriteText(p, next);
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT') return fail('agent not found', { conflict: true });
      return fail(errMsg(err));
    }
  }

  function agentCreate({ name, description, model } = {}) {
    const p = agentFile(name);
    if (!p) return fail('invalid name');
    if (model != null && model !== '' && !validModel(model)) return fail('invalid model');
    try {
      fs.mkdirSync(agentsDir, { recursive: true });
      if (fs.existsSync(p)) return fail('an agent with that name already exists');
      fs.writeFileSync(p, agentTemplate({ name, description: cleanLine(description, DESC_MAX), model: model || 'inherit' }), { flag: 'wx' });
      return { ok: true, path: p };
    } catch (err) {
      if (err.code === 'EEXIST') return fail('an agent with that name already exists');
      return fail(errMsg(err));
    }
  }

  function agentDelete({ name, rev } = {}) {
    const p = agentFile(name);
    if (!p) return fail('invalid name');
    try {
      if (sha1(readCapped(p)) !== rev) return fail('the agent file changed on disk — reload', { conflict: true });
      backupFile(p, 'agent-' + name + '.md');
      fs.unlinkSync(p);
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT') return fail('agent not found', { conflict: true });
      return fail(errMsg(err));
    }
  }

  // ---- skills ----
  function skillDir(name) { return childPath(skillsDir, name); }

  function skillPath({ name } = {}) {
    const d = skillDir(name);
    if (!d) return null;
    const p = path.join(d, 'SKILL.md');
    return defaultIsFile(p) ? p : null;
  }

  function skillCreate({ name, description } = {}) {
    const d = skillDir(name);
    if (!d) return fail('invalid name');
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      let exists = false;
      try { fs.lstatSync(d); exists = true; } catch (_) {}
      if (exists) return fail('a skill with that name already exists');
      fs.mkdirSync(d);
      const p = path.join(d, 'SKILL.md');
      fs.writeFileSync(p, skillTemplate({ name, description: cleanLine(description, DESC_MAX) }), { flag: 'wx' });
      return { ok: true, path: p };
    } catch (err) {
      if (err.code === 'EEXIST') return fail('a skill with that name already exists');
      return fail(errMsg(err));
    }
  }

  // A linked skill (junction/symlink): only the link goes; its target stays (R1).
  // A real folder: copied to the backup folder, then removed.
  // Optional rev (of SKILL.md) / linked (bool) from list: a mismatch is a conflict.
  function skillDelete({ name, rev, linked } = {}) {
    const d = skillDir(name);
    if (!d) return fail('invalid name');
    let lst;
    try { lst = fs.lstatSync(d); } catch (_) { return fail('skill not found', { conflict: true }); }
    const changed = fail('skill changed on disk — reload', { conflict: true });
    if (typeof linked === 'boolean' && linked !== lst.isSymbolicLink()) return changed;
    if (rev !== undefined) {
      let cur;
      try { cur = revOf(path.join(d, 'SKILL.md')); } catch (err) { return fail(errMsg(err)); }
      if (cur !== rev) return changed;
    }
    try {
      if (lst.isSymbolicLink()) {
        let target = null;
        try { target = fs.realpathSync(d); } catch (_) {}
        if (target == null) { try { target = fs.readlinkSync(d); } catch (_) {} }
        const dest = backupTarget('skill-' + name + '.link.json');
        fs.writeFileSync(dest, JSON.stringify({ link: d, target }, null, 2) + '\n', { flag: 'wx' });
        try { fs.unlinkSync(d); } catch (err) {
          if (err.code !== 'EPERM' && err.code !== 'EISDIR') throw err;
          fs.rmdirSync(d);
        }
        return { ok: true };
      }
      if (!lst.isDirectory()) return fail('not a skill folder');
      const dest = backupTarget('skill-' + name);
      try {
        copyTreeForBackup(d, dest);
      } catch (err) {
        // A half-copied backup is no backup; dest is our own fresh folder.
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
        throw err;
      }
      // Re-check right before the recursive delete: it must still be a real folder.
      if (fs.lstatSync(d).isSymbolicLink()) return fail('skill changed on disk — reload', { conflict: true });
      fs.rmSync(d, { recursive: true });
      return { ok: true };
    } catch (err) { return fail(errMsg(err)); }
  }

  // ---- hooks ----
  async function hookAdd({ event, matcher, command, timeout, settingsRev } = {}) {
    if (!validEvent(event)) return fail('invalid event');
    const m = parseMatcher(matcher); if (m.error) return fail(m.error);
    const c = parseCommand(command); if (c.error) return fail(c.error);
    const t = parseTimeout(timeout); if (t.error) return fail(t.error);
    const pre = loadSettingsFor(settingsRev); if (pre.res) return pre.res;
    if (!(await ask({ action: 'add', event, matcher: m.value, command: c.value }))) return fail('canceled', { canceled: true });
    const { s, res } = loadSettingsFor(settingsRev); if (res) return res;
    const hook = { type: 'command', command: c.value };
    if (t.value != null) hook.timeout = t.value;
    try {
      writeSettings(s.obj, applyHookOp(s.obj.hooks, { op: 'add', event, matcher: m.value, hook }));
      return { ok: true };
    } catch (err) { return fail(errMsg(err)); }
  }

  async function hookUpdate({ id, matcher, command, timeout, settingsRev } = {}) {
    if (typeof id !== 'string') return fail('invalid id');
    const pre = loadSettingsFor(settingsRev); if (pre.res) return pre.res;
    const cur = findHook(pre.s.obj.hooks, id);
    if (!cur) return fail('hook not found', { conflict: true });
    const op = { op: 'update', id };
    if (matcher !== undefined) { const m = parseMatcher(matcher); if (m.error) return fail(m.error); op.matcher = m.value; }
    if (timeout !== undefined) { const t = parseTimeout(timeout); if (t.error) return fail(t.error); op.timeout = t.value; }
    if (command !== undefined) {
      const c = parseCommand(command); if (c.error) return fail(c.error);
      if (c.value !== cur.command) {
        if (cur.type !== 'command') return fail('only command hooks have an editable command');
        op.command = c.value;
      }
    }
    // A new command, or a new matcher (it widens/narrows where the command runs).
    const matcherChanged = op.matcher !== undefined && op.matcher !== cur.matcher;
    if (op.command !== undefined || matcherChanged) {
      const shownMatcher = op.matcher !== undefined ? op.matcher : cur.matcher;
      const shownCommand = op.command !== undefined ? op.command : cur.command;
      if (!(await ask({ action: 'update', event: cur.event, matcher: shownMatcher, command: shownCommand }))) return fail('canceled', { canceled: true });
    }
    const { s, res } = loadSettingsFor(settingsRev); if (res) return res;
    try {
      writeSettings(s.obj, applyHookOp(s.obj.hooks, op));
      return { ok: true };
    } catch (err) { return fail(errMsg(err)); }
  }

  function hookRemove({ id, settingsRev } = {}) {
    const { s, res } = loadSettingsFor(settingsRev); if (res) return res;
    if (!findHook(s.obj.hooks, id)) return fail('hook not found', { conflict: true });
    try {
      writeSettings(s.obj, applyHookOp(s.obj.hooks, { op: 'remove', id }));
      return { ok: true };
    } catch (err) { return fail(errMsg(err)); }
  }

  // Store first, then settings.json; a failed settings write rolls the store back, so
  // a hook is never lost from both places.
  function hookDisable({ id, settingsRev } = {}) {
    const { s, res } = loadSettingsFor(settingsRev); if (res) return res;
    const cur = findHook(s.obj.hooks, id);
    if (!cur) return fail('hook not found', { conflict: true });
    const hook = s.obj.hooks[cur.event][cur.index.group].hooks[cur.index.hook];
    const disabledAt = now().toISOString();
    const entry = {
      id: sha1(cur.event + '\0' + cur.matcher + '\0' + JSON.stringify(hook) + '\0' + disabledAt).slice(0, 12),
      event: cur.event, matcher: cur.matcher, hook, disabledAt
    };
    const store = readDisabled();
    if (store.error) return fail(store.error);
    const before = store.list;
    let nextHooks;
    try { nextHooks = applyHookOp(s.obj.hooks, { op: 'remove', id }); } catch (err) { return fail(errMsg(err)); }
    try { writeDisabled(before.concat([entry])); } catch (err) { return fail(errMsg(err)); }
    try { writeSettings(s.obj, nextHooks); } catch (err) {
      try { writeDisabled(before); } catch (_) {}
      return fail(errMsg(err));
    }
    return { ok: true };
  }

  async function hookEnable({ disabledId, settingsRev } = {}) {
    const first = readDisabled();
    if (first.error) return fail(first.error);
    const entry = first.list.find((d) => d.id === disabledId) || null;
    if (!entry) return fail('disabled hook not found', { conflict: true });
    // The store is a plain file in userData: check it like a new hook before its
    // content reaches the native confirm or settings.json.
    const bad = checkEnableEntry(entry);
    if (bad) return fail(bad);
    const pre = loadSettingsFor(settingsRev); if (pre.res) return pre.res;
    const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
    const command = typeof entry.hook.command === 'string' ? entry.hook.command : '';
    if (!(await ask({ action: 'enable', event: entry.event, matcher, command }))) return fail('canceled', { canceled: true });
    const { s, res } = loadSettingsFor(settingsRev); if (res) return res;
    const second = readDisabled();
    if (second.error) return fail(second.error);
    const before = second.list;
    const again = before.find((d) => d.id === disabledId);
    if (!again || JSON.stringify(again) !== JSON.stringify(entry)) return fail('disabled hook changed — reload', { conflict: true });
    let nextHooks;
    try { nextHooks = applyHookOp(s.obj.hooks, { op: 'add', event: entry.event, matcher, hook: entry.hook }); } catch (err) { return fail(errMsg(err)); }
    try { writeDisabled(before.filter((d) => d.id !== disabledId)); } catch (err) { return fail(errMsg(err)); }
    try { writeSettings(s.obj, nextHooks); } catch (err) {
      try { writeDisabled(before); } catch (_) {}
      return fail(errMsg(err));
    }
    return { ok: true };
  }

  // id of an active hook or of a disabled one.
  function hookScriptPath({ id } = {}) {
    if (typeof id !== 'string') return null;
    const s = readSettings();
    if (!s.error) {
      const h = findHook(s.obj.hooks, id);
      if (h) return h.type === 'command' ? scriptFor(h.command) : null;
    }
    const d = readDisabled().list.find((e) => e.id === id);
    if (d && d.hook.type === 'command' && typeof d.hook.command === 'string') return scriptFor(d.hook.command);
    return null;
  }

  return {
    paths: { root, agentsDir, skillsDir, hooksDir, settingsPath, backupDir, disabledPath },
    list, agentSetModel, agentCreate, agentDelete, agentPath,
    skillCreate, skillDelete, skillPath,
    hookAdd, hookUpdate, hookRemove, hookDisable, hookEnable, hookScriptPath
  };
}

module.exports = {
  MAX_READ_BYTES, KNOWN_EVENTS, MODELS,
  validName, validModel, parseFrontmatter, setFrontmatterField, formatValue,
  agentTemplate, skillTemplate, flattenHooks, applyHookOp, findHookScript, quoteForDisplay,
  createClaudeConfig
};
