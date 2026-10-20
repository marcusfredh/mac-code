const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  folderPathFromFileUri, checkLocalFolder,
  DEFAULT_WORKTREE_ROOT, worktreeRootFromTemplate, worktreeRoots, isInsideRoot, folderOpenDecision
} = require('../folderUri');

const KELVIN = '\u212A'; // KELVIN SIGN: toLowerCase() gives 'k', NTFS does not fold it

test('case folding is ASCII-only: a KELVIN SIGN is not a k', async () => {
  const root = 'C:\\dev\\worktrees';
  assert.strictEqual(isInsideRoot(`C:\\dev\\wor${KELVIN}trees\\x`, root), false);
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees\\x', `C:\\dev\\wor${KELVIN}trees`), false);
  assert.strictEqual(folderOpenDecision(`C:\\dev\\wor${KELVIN}trees\\x`, worktreeRoots('')), 'confirm');
  assert.strictEqual(folderOpenDecision('C:\\a\\k', [], { confirmed: true, path: `C:\\a\\${KELVIN}` }), 'confirm');
  assert.strictEqual(worktreeRootFromTemplate(`D:\\src\\wor${KELVIN}trees\\{branch}`), null);
  assert.deepStrictEqual(worktreeRoots(`C:\\dev\\wor${KELVIN}trees\\x\\worktrees\\{branch}`).length, 2);
  // The canonical-equality check: realpath giving the ASCII 'k' for a KELVIN spelling.
  const f = fakeFs({ 'C:\\a': 'dir', 'C:\\a\\k': 'dir', [`C:\\a\\${KELVIN}`]: 'dir' }, { [`C:\\a\\${KELVIN}`]: 'C:\\a\\k' });
  assert.ok((await checkLocalFolder(`C:\\a\\${KELVIN}`, f)).error);
});

test('Unicode format characters (bidi, zero-width, BOM) are refused', async () => {
  for (const enc of ['%E2%80%AE', '%E2%80%8F', '%E2%81%A6', '%EF%BB%BF', '%E2%80%8B',
    '%E2%80%A8', '%E2%80%A9', '%C2%85', '%0A', '%09']) {
    assert.ok(folderPathFromFileUri(`file:///C:/dev/x${enc}y`).error, enc);
  }
  for (const ch of ['\u202E', '\u200E', '\u2069', '\uFEFF', '\u2028', '\u2029', '\u0085']) {
    assert.ok((await checkLocalFolder(`C:\\a${ch}`, fakeFs({ [`C:\\a${ch}`]: 'dir' }))).error);
    // ... including when only the canonical path has one.
    const f = fakeFs({ 'C:\\a': 'dir', [`C:\\a\\b${ch}`]: 'dir' }, { 'C:\\a\\b': `C:\\a\\b${ch}` });
    assert.ok((await checkLocalFolder('C:\\a\\b', f)).error);
  }
});

test('isInsideRoot: below the root, on a path boundary, any case', () => {
  const root = 'C:\\dev\\worktrees';
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees\\Mac-Code\\feat-x', root), true);
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees\\x', root), true);
  assert.strictEqual(isInsideRoot('c:\\DEV\\Worktrees\\Mac-Code\\feat-x', root), true);
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees\\x\\', root + '\\'), true);
  // The root itself, its parent, siblings and lookalike prefixes are outside.
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees', root), false);
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees\\', root), false);
  assert.strictEqual(isInsideRoot('C:\\dev', root), false);
  assert.strictEqual(isInsideRoot('C:\\dev\\worktreesX\\a', root), false);
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees-evil\\a', root), false);
  assert.strictEqual(isInsideRoot('D:\\dev\\worktrees\\a', root), false);
  assert.strictEqual(isInsideRoot('C:\\Users\\me\\Downloads', root), false);
  assert.strictEqual(isInsideRoot('', root), false);
  assert.strictEqual(isInsideRoot(null, root), false);
  assert.strictEqual(isInsideRoot('C:\\dev\\worktrees\\a', ''), false);
});

test('worktreeRootFromTemplate: the fixed path up to and including worktrees', () => {
  assert.strictEqual(worktreeRootFromTemplate('D:\\src\\worktrees\\{repo}\\{branch}'), 'D:\\src\\worktrees');
  assert.strictEqual(worktreeRootFromTemplate('  E:/code/Worktrees/{branch}  '), 'E:\\code\\Worktrees');
  assert.strictEqual(worktreeRootFromTemplate('C:\\worktrees\\{branch}'), 'C:\\worktrees');
  // No fixed root: a placeholder before 'worktrees', no 'worktrees', not drive-absolute, '..'.
  assert.strictEqual(worktreeRootFromTemplate('D:\\{repo}\\worktrees\\{branch}'), null);
  assert.strictEqual(worktreeRootFromTemplate('D:\\src\\wt\\{branch}'), null);
  assert.strictEqual(worktreeRootFromTemplate('\\\\host\\share\\worktrees\\{branch}'), null);
  assert.strictEqual(worktreeRootFromTemplate('worktrees\\{branch}'), null);
  assert.strictEqual(worktreeRootFromTemplate('D:\\a\\..\\worktrees\\{branch}'), null);
  assert.strictEqual(worktreeRootFromTemplate(''), null);
  assert.strictEqual(worktreeRootFromTemplate(undefined), null);
});

test('worktreeRoots: the default layout, plus the template root when there is one', () => {
  assert.deepStrictEqual(worktreeRoots(''), [DEFAULT_WORKTREE_ROOT]);
  assert.deepStrictEqual(worktreeRoots('D:\\src\\worktrees\\{repo}\\{branch}'), [DEFAULT_WORKTREE_ROOT, 'D:\\src\\worktrees']);
  assert.deepStrictEqual(worktreeRoots('c:\\DEV\\worktrees\\{repo}\\{branch}'), [DEFAULT_WORKTREE_ROOT]);
  assert.strictEqual(DEFAULT_WORKTREE_ROOT, 'C:\\dev\\worktrees');
});

test('folderOpenDecision: worktree folders open, others ask unless this very path was confirmed', () => {
  const roots = worktreeRoots('D:\\src\\worktrees\\{repo}\\{branch}');
  assert.strictEqual(folderOpenDecision('C:\\dev\\worktrees\\Mac-Code\\feat-x', roots), 'open');
  assert.strictEqual(folderOpenDecision('D:\\src\\worktrees\\r\\b', roots), 'open');
  assert.strictEqual(folderOpenDecision('C:\\dev\\worktreesX\\r', roots), 'confirm');
  assert.strictEqual(folderOpenDecision('C:\\Users\\me\\Downloads', roots), 'confirm');
  assert.strictEqual(folderOpenDecision('C:\\Users\\me\\Downloads', roots, {}), 'confirm');
  assert.strictEqual(folderOpenDecision('C:\\Users\\me\\Downloads', roots, { confirmed: 'yes', path: 'C:\\Users\\me\\Downloads' }), 'confirm');
  assert.strictEqual(folderOpenDecision('C:\\Users\\me\\Downloads', roots, { confirmed: true }), 'confirm');
  // Confirmed for a path that now resolves elsewhere: ask again.
  assert.strictEqual(folderOpenDecision('C:\\Users\\me\\Other', roots, { confirmed: true, path: 'C:\\Users\\me\\Downloads' }), 'confirm');
  assert.strictEqual(folderOpenDecision('C:\\Users\\me\\Downloads', roots, { confirmed: true, path: 'c:\\users\\me\\downloads' }), 'open');
});

const CLSID = '{0AFACED1-E828-11D1-9187-B532F1E9575D}';

// fileURLToPath is platform-specific; the app only runs on Windows.
const win = process.platform === 'win32';

test('local drive URI decodes to a path', { skip: !win }, () => {
  assert.deepStrictEqual(folderPathFromFileUri('file:///C:/x'), { path: 'C:\\x' });
  assert.deepStrictEqual(folderPathFromFileUri('file:///C:/dev/worktrees/Mac-Code/feat-x'),
    { path: 'C:\\dev\\worktrees\\Mac-Code\\feat-x' });
  assert.deepStrictEqual(folderPathFromFileUri('file://localhost/C:/x'), { path: 'C:\\x' });
});

test('percent-encoding is decoded', { skip: !win }, () => {
  assert.deepStrictEqual(folderPathFromFileUri('file:///C:/My%20Folder'), { path: 'C:\\My Folder' });
});

test('remote hosts and UNC paths are rejected', () => {
  assert.ok(folderPathFromFileUri('file://host/share').error);
  assert.ok(folderPathFromFileUri('file://host/share/dir').error);
  assert.ok(folderPathFromFileUri('file://10.0.0.1/c$').error);
  assert.ok(folderPathFromFileUri('file:////host/share').error);
  assert.ok(folderPathFromFileUri('file://///host/share').error);
});

test('non-file schemes and non-strings are rejected', () => {
  for (const u of ['https://example.com', 'http://x/y', 'javascript:alert(1)', 'C:\\x', '', 'fil:///C:/x']) {
    assert.ok(folderPathFromFileUri(u).error, u);
  }
  for (const u of [null, undefined, 42, {}, ['file:///C:/x']]) {
    assert.ok(folderPathFromFileUri(u).error);
  }
});

test('encoded separators are rejected', { skip: !win }, () => {
  assert.ok(folderPathFromFileUri('file:///C:/a%5C..%5Cb').error);
  assert.ok(folderPathFromFileUri('file:///C:/a%2Fb').error);
});

test('shell-namespace .{CLSID} folders are rejected, in any segment', () => {
  assert.ok(folderPathFromFileUri(`file:///C:/x.${CLSID}`).error);
  assert.ok(folderPathFromFileUri(`file:///C:/x.${CLSID.toLowerCase()}/sub`).error);
  assert.ok(folderPathFromFileUri(`file:///C:/a/.${CLSID}`).error);
  // Windows strips trailing dots and spaces, so these name the same folder.
  assert.ok(folderPathFromFileUri(`file:///C:/x.${CLSID}.`).error);
  assert.ok(folderPathFromFileUri(`file:///C:/x.${CLSID}%20`).error);
});

test('braces that are not a .{CLSID} suffix are fine', { skip: !win }, () => {
  assert.ok(folderPathFromFileUri('file:///C:/x/%7Bnot-a-guid%7D').path);
  assert.ok(folderPathFromFileUri(`file:///C:/x${CLSID}`).path);
});

test('a drive with no root (relative to the drive cwd) is rejected', { skip: !win }, () => {
  assert.ok(folderPathFromFileUri('file:///C:').error);
  assert.ok(folderPathFromFileUri('file:///C:').error.includes('absolute'));
  assert.deepStrictEqual(folderPathFromFileUri('file:///C:/'), { path: 'C:\\' });
});

// Fake fs.promises. entries maps a path to 'dir' | 'file' | 'link', or to a string,
// which is a file with that content. aliases maps another spelling of a path to its
// canonical one (what realpath returns). Anything else is ENOENT.
function fakeFs(entries, aliases = {}) {
  const norm = (p) => { const q = path.win32.normalize(p); return q.length > 3 ? q.replace(/\\+$/, '') : q; };
  const enoent = (p) => { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; return e; };
  const get = (p) => {
    const q = norm(aliases[norm(p)] || p);
    if (!(q in entries)) throw enoent(p);
    return entries[q];
  };
  const stats = (v) => {
    const kind = typeof v === 'string' && !['dir', 'file', 'link'].includes(v) ? 'file' : v;
    return {
      isSymbolicLink: () => kind === 'link',
      isDirectory: () => kind === 'dir' || kind === 'link',
      isFile: () => kind === 'file',
      size: typeof v === 'string' ? Buffer.byteLength(v) : 0
    };
  };
  const calls = [];
  return {
    calls,
    lstat: async (p) => { calls.push('lstat ' + norm(p)); return stats(get(p)); },
    stat: async (p) => { calls.push('stat ' + norm(p)); const v = get(p); return stats(v === 'link' ? 'dir' : v); },
    realpath: async (p) => { calls.push('realpath ' + norm(p)); get(p); return norm(aliases[norm(p)] || p); },
    readFile: async (p) => {
      const v = get(p);
      if (typeof v !== 'string' || v === 'dir' || v === 'link') throw enoent(p);
      return Buffer.from(v === 'file' ? '' : v);
    }
  };
}

test('checkLocalFolder: a plain folder is ok and its canonical path is returned', async () => {
  const f = fakeFs({ 'C:\\a': 'dir', 'C:\\a\\b': 'dir', 'C:\\a\\f.txt': 'file' });
  assert.deepStrictEqual(await checkLocalFolder('C:\\a\\b', f), { path: 'C:\\a\\b' });
  assert.deepStrictEqual(await checkLocalFolder('C:\\a\\b\\', f), { path: 'C:\\a\\b' });
  assert.ok((await checkLocalFolder('C:\\a\\f.txt', f)).error);
  assert.ok((await checkLocalFolder('C:\\a\\nope', f)).error);
});

test('checkLocalFolder: a drive with no root is rejected', async () => {
  const f = fakeFs({ 'C:\\a': 'dir' });
  assert.ok((await checkLocalFolder('C:', f)).error);
  assert.ok((await checkLocalFolder('C:a', f)).error);
  assert.ok((await checkLocalFolder('\\\\host\\share', f)).error);
  assert.deepStrictEqual(f.calls, []);
});

test('checkLocalFolder: letter case alone is not a different spelling', async () => {
  const f = fakeFs({ 'C:\\Dev': 'dir', 'C:\\Dev\\Wt': 'dir' }, { 'C:\\dev\\wt': 'C:\\Dev\\Wt', 'C:\\dev': 'C:\\Dev' });
  assert.deepStrictEqual(await checkLocalFolder('C:\\dev\\wt', f), { path: 'C:\\Dev\\Wt' });
});

test('checkLocalFolder: a short name or stream suffix for a .{CLSID} folder is rejected', async () => {
  const shell = `C:\\a\\x.${CLSID}`;
  const f = fakeFs({ 'C:\\a': 'dir', [shell]: 'dir' }, {
    'C:\\a\\X7525~1.{0A': shell,
    'C:\\a\\x::$INDEX_ALLOCATION': 'C:\\a\\x',
    'C:\\a\\LONGNA~1': 'C:\\a\\long name'
  });
  assert.ok((await checkLocalFolder('C:\\a\\X7525~1.{0A', f)).error);
  // Any non-canonical spelling is refused, even one that leads to a harmless folder.
  const g = fakeFs({ 'C:\\a': 'dir', 'C:\\a\\x': 'dir', 'C:\\a\\long name': 'dir' }, {
    'C:\\a\\x::$INDEX_ALLOCATION': 'C:\\a\\x',
    'C:\\a\\LONGNA~1': 'C:\\a\\long name'
  });
  assert.ok((await checkLocalFolder('C:\\a\\x::$INDEX_ALLOCATION', g)).error);
  assert.ok((await checkLocalFolder('C:\\a\\LONGNA~1', g)).error);
  assert.deepStrictEqual(await checkLocalFolder('C:\\a\\long name', g), { path: 'C:\\a\\long name' });
});

test('checkLocalFolder: a symlink or junction anywhere on the path is rejected before anything follows it', async () => {
  const f = fakeFs({ 'C:\\a': 'dir', 'C:\\a\\link': 'link', 'C:\\a\\link\\sub': 'dir' });
  assert.ok((await checkLocalFolder('C:\\a\\link', f)).error);
  assert.ok((await checkLocalFolder('C:\\a\\link\\sub', f)).error);
  assert.ok(!f.calls.some((c) => /^(stat|realpath) /.test(c)));
  // Walked from the drive root down; the root itself is not lstat'ed.
  assert.deepStrictEqual(f.calls.slice(0, 2), ['lstat C:\\a', 'lstat C:\\a\\link']);
});

test('checkLocalFolder: a desktop.ini declaring a shell object, here or above, is rejected', async () => {
  for (const key of ['CLSID2', 'CLSID', 'UICLSID', '  clsid2 ']) {
    const ini = `[.ShellClassInfo]\r\n${key}={0AFACED1-E828-11D1-9187-B532F1E9575D}\r\n`;
    const here = fakeFs({ 'C:\\a': 'dir', 'C:\\a\\b': 'dir', 'C:\\a\\b\\desktop.ini': ini });
    assert.ok((await checkLocalFolder('C:\\a\\b', here)).error, key);
    const above = fakeFs({ 'C:\\a': 'dir', 'C:\\a\\desktop.ini': ini, 'C:\\a\\b': 'dir', 'C:\\a\\b\\c': 'dir' });
    assert.ok((await checkLocalFolder('C:\\a\\b\\c', above)).error, key);
    const atRoot = fakeFs({ 'C:\\desktop.ini': ini, 'C:\\a': 'dir' });
    assert.ok((await checkLocalFolder('C:\\a', atRoot)).error, key);
  }
});

test('checkLocalFolder: a UTF-16LE desktop.ini cannot hide the key', async () => {
  const ini = '\ufeff[.ShellClassInfo]\r\nCLSID2={0AFACED1-E828-11D1-9187-B532F1E9575D}\r\n';
  const f = fakeFs({ 'C:\\a': 'dir' });
  const buf = Buffer.from(ini, 'utf16le');
  const g = { ...f,
    lstat: async (p) => (/desktop\.ini$/i.test(p) && path.win32.dirname(p) === 'C:\\a'
      ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: buf.length }
      : f.lstat(p)),
    readFile: async () => buf };
  assert.ok((await checkLocalFolder('C:\\a', g)).error);
});

test('checkLocalFolder: an ordinary desktop.ini (Documents, Downloads) is fine', async () => {
  const ini = '[.ShellClassInfo]\r\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21798\r\n' +
    'IconResource=%SystemRoot%\\system32\\imageres.dll,-184\r\n';
  const f = fakeFs({ 'C:\\u': 'dir', 'C:\\u\\desktop.ini': ini, 'C:\\u\\Downloads': 'dir', 'C:\\u\\Downloads\\desktop.ini': ini });
  assert.deepStrictEqual(await checkLocalFolder('C:\\u\\Downloads', f), { path: 'C:\\u\\Downloads' });
});

test('checkLocalFolder: a desktop.ini that cannot be checked, is odd or is huge refuses', async () => {
  const f = fakeFs({ 'C:\\a': 'dir' });
  const eperm = { ...f, lstat: async (p) => {
    if (/desktop\.ini$/i.test(p)) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    return f.lstat(p);
  } };
  assert.ok((await checkLocalFolder('C:\\a', eperm)).error);
  assert.ok((await checkLocalFolder('C:\\a', fakeFs({ 'C:\\a': 'dir', 'C:\\a\\desktop.ini': 'link' }))).error);
  assert.ok((await checkLocalFolder('C:\\a', fakeFs({ 'C:\\a': 'dir', 'C:\\a\\desktop.ini': 'dir' }))).error);
  assert.ok((await checkLocalFolder('C:\\a', fakeFs({ 'C:\\a': 'dir', 'C:\\a\\desktop.ini': 'x'.repeat(64 * 1024 + 1) }))).error);
});

test('checkLocalFolder on the real filesystem', { skip: !win }, async () => {
  // realpath, because the temp dir itself may be reached through a short name.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'folderuri-')));
  try {
    assert.deepStrictEqual(await checkLocalFolder(dir, fs.promises), { path: dir });
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    assert.ok((await checkLocalFolder(file, fs.promises)).error);
    const sub = path.join(dir, 'a long folder name');
    fs.mkdirSync(sub);
    assert.deepStrictEqual(await checkLocalFolder(sub, fs.promises), { path: sub });
    assert.ok((await checkLocalFolder(sub + '::$INDEX_ALLOCATION', fs.promises)).error);
    fs.writeFileSync(path.join(dir, 'desktop.ini'), '[.ShellClassInfo]\r\nIconResource=x.dll,0\r\n');
    assert.deepStrictEqual(await checkLocalFolder(sub, fs.promises), { path: sub });
    fs.writeFileSync(path.join(dir, 'desktop.ini'), '[.ShellClassInfo]\r\nCLSID2={0AFACED1-E828-11D1-9187-B532F1E9575D}\r\n');
    assert.ok((await checkLocalFolder(sub, fs.promises)).error);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
