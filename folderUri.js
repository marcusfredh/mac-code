// Pure validation for OSC 8 file: links clicked in a terminal (no electron, unit-tested).
//
// Any program running in a pane can wrap any text in an OSC 8 hyperlink, so the URI is
// untrusted. It is only ever used to open a local FOLDER in Explorer: opening a file
// would hand an attacker-chosen executable or document to its default handler on a
// single click. Remote targets are refused here as well — a file://host/share or
// \\host\share path makes Windows contact that host over SMB, which leaks the user's
// NTLM credentials. main.js runs both checks below and opens only the canonical path
// checkLocalFolder hands back — directly for a worktree folder, otherwise only after the
// user has confirmed it (folderOpenDecision, at the end).
const path = require('path');
const { fileURLToPath } = require('url');

// A folder named "<anything>.{CLSID}" is a shell-namespace junction: Explorer opens it
// as that shell object rather than as a folder (the Folder Shortcut CLSID follows a
// target.lnk inside it — to \\attacker\share, say). Windows drops trailing dots and
// spaces from a name, so "x.{CLSID}. " is the same folder and is refused too. Other
// spellings of the same folder (8.3 short names, "::$INDEX_ALLOCATION") are caught by
// checkLocalFolder's canonical-path comparison, and the name is checked again there.
const CLSID_SEGMENT_RE = /\.\{[0-9a-f-]{36}\}[. ]*$/i;
// desktop.ini keys that turn a folder (and with it everything below it) into a shell
// object instead of a plain folder.
const DESKTOP_INI_SHELL_RE = /^\s*(CLSID2?|UICLSID)\s*=/im;
const DESKTOP_INI_MAX = 64 * 1024;

// Unicode format characters (bidi overrides and isolates, LRM/RLM, zero-width, BOM),
// controls (NEL and friends) and line/paragraph separators (U+2028/2029, which the
// dialog renders as hard breaks): they make a path shown in the confirm dialog read
// as something else.
const FORMAT_CHAR_RE = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u;

// Case folding for path comparisons: ASCII only. NTFS does not fold e.g. U+212A KELVIN
// SIGN to 'k', but String.toLowerCase does, so "wor\u212Atrees" would match "worktrees".
const foldAscii = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());

// Plain drive-absolute ("C:\…") and local; no UNC, no shell-folder names, no format chars.
function pathProblem(p) {
  if (typeof p !== 'string' || !/^[A-Za-z]:\\/.test(p)) return 'not an absolute drive path';
  if (FORMAT_CHAR_RE.test(p)) return 'format characters not allowed';
  if (p.split(/[\\/]/).some((seg) => CLSID_SEGMENT_RE.test(seg))) return 'shell folder not allowed';
  return null;
}

// Returns { path } for a local file: URI, or { error } when it must not be opened.
function folderPathFromFileUri(uri) {
  if (typeof uri !== 'string' || !/^file:/i.test(uri)) return { error: 'not a file: URI' };
  let url;
  try { url = new URL(uri); } catch (_) { return { error: 'invalid URI' }; }
  if (url.host && url.host.toLowerCase() !== 'localhost') return { error: 'remote host not allowed' };
  let p;
  try { p = fileURLToPath(url); } catch (err) { return { error: err.message }; }
  if (!p || p.startsWith('\\\\') || p.startsWith('//')) return { error: 'network path not allowed' };
  const problem = pathProblem(p);
  return problem ? { error: problem } : { path: p };
}

const stripTrailingSep = (p) => (p.length > 3 ? p.replace(/[\\/]+$/, '') : p);

// The drive root and every folder from there down to p (drive-absolute).
function ancestorsOf(p) {
  const root = path.win32.parse(p).root;
  const out = [root];
  let cur = root;
  for (const part of p.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cur = path.win32.join(cur, part);
    out.push(cur);
  }
  return out;
}

// desktop.ini can be ANSI, UTF-8 or UTF-16LE; it is searched as both, so neither
// encoding can hide a key from the other.
function iniDeclaresShellObject(buf) {
  let wide = buf;
  if (wide.length >= 2 && wide[0] === 0xff && wide[1] === 0xfe) wide = wide.subarray(2);
  return DESKTOP_INI_SHELL_RE.test(buf.toString('latin1')) ||
    DESKTOP_INI_SHELL_RE.test(wide.toString('utf16le'));
}

// The on-disk half, run on a path folderPathFromFileUri accepted. fsp is fs.promises
// (or a fake with lstat, stat, realpath and readFile), so this stays testable; Node's
// fs.promises.realpath is already the native (GetFinalPathNameByHandle) resolver.
// Returns { path: <canonical folder to open> } or { error }. In order:
// - No component may be a symlink. stat and realpath follow them, so a directory
//   symlink to \\host\share would make SMB traffic just by being checked; each
//   component is lstat'ed from the drive root down before anything follows a link.
//   lstat reports junctions as symlinks too, so they are refused as well (fail closed).
// - realpath must give back the same path, apart from letter case and a trailing
//   backslash. Anything else — an 8.3 short name, an "::$INDEX_ALLOCATION" stream
//   suffix, any other alias — is a second spelling that could get a .{CLSID} name past
//   the text check. The canonical path is checked again and is what gets opened.
// - It must be a directory.
// - No desktop.ini in it or in any folder above it may declare CLSID / CLSID2 /
//   UICLSID: that makes Explorer treat the folder and everything below it as a shell
//   object. Ordinary desktop.ini files (Documents, Downloads, …) are fine. A desktop.ini
//   that can't be looked at or read, isn't a plain file, or is too big is a refusal.
async function checkLocalFolder(p, fsp) {
  const problem = pathProblem(p);
  if (problem) return { error: problem };
  let canon;
  try {
    for (const dir of ancestorsOf(p).slice(1)) {
      const lst = await fsp.lstat(dir);
      if (lst.isSymbolicLink()) return { error: 'symlinked path not allowed' };
    }
    canon = await fsp.realpath(p);
  } catch (err) { return { error: err.message }; }
  if (typeof canon !== 'string' ||
      foldAscii(stripTrailingSep(canon)) !== foldAscii(stripTrailingSep(path.win32.resolve(p)))) {
    return { error: 'path is not in canonical form' };
  }
  const canonProblem = pathProblem(canon);
  if (canonProblem) return { error: canonProblem };
  try {
    const st = await fsp.stat(canon);
    if (!st.isDirectory()) return { error: 'not a folder' };
  } catch (err) { return { error: err.message }; }
  for (const dir of ancestorsOf(canon)) {
    const ini = path.win32.join(dir, 'desktop.ini');
    let lst;
    try { lst = await fsp.lstat(ini); }
    catch (err) {
      if (err && err.code === 'ENOENT') continue;
      return { error: 'cannot check desktop.ini' };
    }
    if (lst.isSymbolicLink() || !lst.isFile()) return { error: 'unusual desktop.ini' };
    if (!(lst.size <= DESKTOP_INI_MAX)) return { error: 'desktop.ini too large' };
    let buf;
    try { buf = await fsp.readFile(ini); } catch (_) { return { error: 'cannot read desktop.ini' }; }
    if (!Buffer.isBuffer(buf) || buf.length > DESKTOP_INI_MAX) return { error: 'desktop.ini too large' };
    if (iniDeclaresShellObject(buf)) return { error: 'shell folder (desktop.ini) not allowed' };
  }
  return { path: canon };
}

// ---------- which folders open without asking ----------
// Even a folder that passes every check above is not provably harmless: Explorer renders
// its contents, and icons, .url, .lnk and .library-ms files in there can make it fetch
// from an SMB host (an NTLM leak no check here can rule out). So an OSC 8 folder link
// asks first, with one exception: a folder inside the worktree root, which is what
// Claude Code's statusline links to. That root is the app's default layout
// (C:\dev\worktrees) and, when github.worktreeTemplate is set, the template's path up
// to and including its 'worktrees' segment.
const DEFAULT_WORKTREE_ROOT = 'C:\\dev\\worktrees';

// The root a worktree template puts worktrees under, or null when it has none that is
// fixed text (a {repo}/{branch} placeholder before 'worktrees', not drive-absolute, '..').
function worktreeRootFromTemplate(template) {
  if (typeof template !== 'string') return null;
  const t = template.trim();
  if (!/^[A-Za-z]:[\\/]/.test(t)) return null;
  const segs = t.split(/[\\/]+/).filter(Boolean);
  const wt = segs.findIndex((s) => foldAscii(s) === 'worktrees');
  if (wt < 1) return null;
  const head = segs.slice(0, wt + 1);
  if (head.some((s) => s === '..' || s === '.' || /[{}]/.test(s))) return null;
  return path.win32.join(head[0] + '\\', ...head.slice(1));
}

function worktreeRoots(template) {
  const out = [DEFAULT_WORKTREE_ROOT];
  const t = worktreeRootFromTemplate(template);
  if (t && !out.some((r) => foldAscii(r) === foldAscii(t))) out.push(t);
  return out;
}

// Whether p lies strictly below root: case-insensitive, on a path boundary (so
// C:\dev\worktreesX is not inside C:\dev\worktrees). Both are expected canonical.
function isInsideRoot(p, root) {
  if (typeof p !== 'string' || typeof root !== 'string' || !p || !root) return false;
  const r = foldAscii(path.win32.resolve(root).replace(/\\+$/, ''));
  const q = foldAscii(path.win32.resolve(p).replace(/\\+$/, ''));
  return q.length > r.length + 1 && q.startsWith(r + '\\');
}

// What main does with a folder that passed checkLocalFolder: 'open' when it is inside a
// worktree root, or when the user confirmed this very path (the renderer's second call
// passes back the path it showed; a folder that now resolves elsewhere asks again);
// otherwise 'confirm'.
function folderOpenDecision(canon, roots, opts) {
  if ((roots || []).some((r) => isInsideRoot(canon, r))) return 'open';
  if (opts && opts.confirmed === true && typeof opts.path === 'string' &&
      foldAscii(opts.path) === foldAscii(canon)) return 'open';
  return 'confirm';
}

module.exports = {
  folderPathFromFileUri, checkLocalFolder,
  DEFAULT_WORKTREE_ROOT, worktreeRootFromTemplate, worktreeRoots, isInsideRoot, folderOpenDecision
};
