// App settings: schema, defaults and validation. Pure (no electron) so it can be
// unit-tested; main.js owns the file on disk and the IPC around it.
//
// Every value that reaches the app goes through checkValue(): a key with the wrong
// type, an unknown enum value or an out-of-range number never lands in the store —
// it falls back (to the default, or to the current value when patching/reloading).
// Unknown sections and keys are dropped.
const fs = require('fs');
const path = require('path');

const STR_MAX = 1024;

// section -> key -> spec. `def` is the default and must reproduce today's behavior
// (one deliberate exception: github.openAs defaults to 'overlay', a requested change).
const SCHEMA = {
  general: {
    restoreTabs:  { type: 'bool', def: true },
    shell:        { type: 'enum', values: ['pwsh', 'powershell'], def: 'pwsh' },
    startDir:     { type: 'string', def: '', check: (s) => s === '' || isDriveAbsolutePath(s) },
    confirmClose: { type: 'bool', def: false }
  },
  terminal: {
    fontFamily:      { type: 'enum', values: ['Cascadia Code', 'Consolas', 'JetBrains Mono'], def: 'Cascadia Code' },
    fontSize:        { type: 'int', min: 8, max: 32, def: 13 },
    theme:           { type: 'enum', values: ['windowsTerminal', 'oneHalfDark', 'solarizedDark'], def: 'windowsTerminal' },
    cursorStyle:     { type: 'enum', values: ['block', 'bar', 'underline'], def: 'bar' },
    scrollback:      { type: 'int', min: 0, max: 100000, def: 5000 },
    copyOnSelect:    { type: 'bool', def: false },
    rightClickPaste: { type: 'bool', def: false }
  },
  claude: {
    hybridInput:       { type: 'bool', def: false },
    autosaveChats:     { type: 'enum', values: ['off', 'onClose', 'continuous'], def: 'off' },
    autoClearDays:     { type: 'enum', values: [0, 7, 30], def: 0 },
    model:             { type: 'enum', values: [null, 'opus', 'sonnet', 'haiku', 'fable'], def: null },
    oneM:              { type: 'bool', def: false },
    permissionDefault: { type: 'enum', values: [null, 'default', 'auto', 'acceptEdits', 'bypassPermissions'], def: null },
    notify:            { type: 'bool', def: true },
    showUsage:         { type: 'bool', def: true },
    cliPath:           { type: 'string', def: '' }
  },
  github: {
    links:            { type: 'enum', values: ['app', 'browser', 'ask'], def: 'app' },
    ctrlFlips:        { type: 'bool', def: true },
    worktreeTemplate: { type: 'string', def: '', check: (s) => s === '' || isValidWorktreeTemplate(s) },
    draftPr:          { type: 'bool', def: false },
    pollSeconds:      { type: 'enum', values: [60, 300, 0], def: 60 },
    openAs:           { type: 'enum', values: ['overlay', 'tab'], def: 'overlay' },
    mergeMethod:      { type: 'enum', values: ['squash', 'merge', 'rebase'], def: 'squash' },
    deleteBranchOnMerge: { type: 'bool', def: true }
  },
  editor: {
    autosave: { type: 'enum', values: ['off', 'blur', 'delay'], def: 'off' },
    wordWrap: { type: 'bool', def: false },
    minimap:  { type: 'bool', def: false },
    tabSize:  { type: 'enum', values: [2, 4, 8], def: 2 }
  },
  explorer: {
    showHidden: { type: 'bool', def: true }
  }
};

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

function buildDefaults() {
  const out = { v: 1 };
  for (const [sec, keys] of Object.entries(SCHEMA)) {
    out[sec] = {};
    for (const [k, spec] of Object.entries(keys)) out[sec][k] = spec.def;
  }
  return out;
}

const DEFAULTS = deepFreeze(buildDefaults());

// Stricter: a drive-letter absolute path only ('C:\x'). No UNC share ('\\srv\x'), no
// device or long-path prefix ('\\?\', '\\.\'), no drive-relative '\x'. For paths the app
// creates folders in or starts shells in, which must never reach a network share.
function isDriveAbsolutePath(p) {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return false;
  return process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(p);
}

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o);
}

// -> { ok: true, value } for an acceptable value (ints come back clamped), else { ok: false }.
function checkValue(spec, value) {
  switch (spec.type) {
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
    case 'enum':
      return spec.values.includes(value) ? { ok: true, value } : { ok: false };
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false };
      return { ok: true, value: Math.min(spec.max, Math.max(spec.min, Math.round(value))) };
    }
    case 'string': {
      // Paths and templates only: one line, no NULs, bounded length.
      if (typeof value !== 'string' || value.length > STR_MAX || /[\0\r\n]/.test(value)) return { ok: false };
      const v = value.trim();
      if (spec.check && !spec.check(v)) return { ok: false };
      return { ok: true, value: v };
    }
    default:
      return { ok: false };
  }
}

// Full settings object from anything (parsed JSON, garbage, null). Each key takes the
// value from `obj` when valid, else from `base` (DEFAULTS unless given — reload passes
// the current settings so a bad hand edit keeps what was there).
function validate(obj, base) {
  const b = base === undefined || base === DEFAULTS ? DEFAULTS : validate(base);
  const src = isPlainObject(obj) ? obj : {};
  const out = { v: 1 };
  for (const [sec, keys] of Object.entries(SCHEMA)) {
    const s = isPlainObject(src[sec]) ? src[sec] : {};
    out[sec] = {};
    for (const [k, spec] of Object.entries(keys)) {
      const r = Object.prototype.hasOwnProperty.call(s, k) ? checkValue(spec, s[k]) : { ok: false };
      out[sec][k] = r.ok ? r.value : b[sec][k];
    }
  }
  return out;
}

// Patch shape { section: { key: value } }; untouched or invalid keys keep `current`.
function applyPatch(current, patch) {
  return validate(patch, current);
}

// Expand a worktree template. null means "use the default layout". The result must be
// a drive-letter absolute path (no UNC, \\?\ or \\.\), contain no '..' segment, and keep
// a segment named 'worktrees' with at least one segment after it (the renderer
// recognises worktree paths by /[\\/]worktrees[\\/]/).
function resolveWorktreePath(template, mainRoot, branch) {
  if (typeof template !== 'string' || !template.trim() || !template.includes('{branch}')) return null;
  if (typeof branch !== 'string' || !branch) return null;
  const repo = path.basename(String(mainRoot || ''));
  const br = branch.replace(/[\\/]/g, '-');
  const out = template.trim().split('{repo}').join(repo).split('{branch}').join(br);
  if (!isDriveAbsolutePath(out)) return null;
  const segs = out.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s === '..')) return null;
  const wt = segs.findIndex((s) => s.toLowerCase() === 'worktrees');
  if (wt === -1 || wt === segs.length - 1) return null;
  return path.normalize(out);
}

// `git worktree list --porcelain` -> [{ path, branch }] (branch = 'refs/heads/x', or
// null when detached/bare). The first entry is the main clone.
function parseWorktreeList(stdout) {
  const out = [];
  let cur = null;
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9).trim()), branch: null };
      out.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim();
    }
  }
  return out;
}

function isValidWorktreeTemplate(t) {
  return resolveWorktreePath(t, 'repo', 'branch') !== null;
}

// A user-chosen claude binary is only spawned when it is a drive-letter absolute path
// (never a network share) to an existing file named claude / claude.exe / claude.cmd /
// claude.bat.
function isValidCliPath(p, fsExists) {
  if (!isDriveAbsolutePath(p)) return false;
  if (!/^claude(\.exe|\.cmd|\.bat)?$/i.test(path.basename(p))) return false;
  const exists = fsExists || ((f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
  try { return !!exists(p); } catch (_) { return false; }
}

// Keys an imported file never sets: they pick what runs (the CLI binary, its permission
// mode) or where the app creates folders and starts shells. They keep the current value.
const IMPORT_PROTECTED = [
  ['claude', 'permissionDefault'],
  ['claude', 'cliPath'],
  ['github', 'worktreeTemplate'],
  ['general', 'startDir']
];

// Imported settings onto `current` -> { settings, skipped }. skipped lists the protected
// keys ('section.key') the file tried to change; each keeps its current value.
function filterImport(current, imported) {
  const cur = validate(current);
  const settings = validate(imported, cur);
  const skipped = [];
  for (const [sec, key] of IMPORT_PROTECTED) {
    const s = isPlainObject(imported) && isPlainObject(imported[sec]) ? imported[sec] : null;
    if (s && Object.prototype.hasOwnProperty.call(s, key) && s[key] !== cur[sec][key]) skipped.push(sec + '.' + key);
    settings[sec][key] = cur[sec][key];
  }
  return { settings, skipped };
}

module.exports = { DEFAULTS, SCHEMA, validate, applyPatch, resolveWorktreePath, isValidWorktreeTemplate, parseWorktreeList, isValidCliPath, isDriveAbsolutePath, filterImport, IMPORT_PROTECTED };
