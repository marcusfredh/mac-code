const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { DEFAULTS, validate, applyPatch, resolveWorktreePath, isValidWorktreeTemplate, parseWorktreeList, isValidCliPath, isDriveAbsolutePath, filterImport } = require('../settings');

test('DEFAULTS: schema v1, reproduces today', () => {
  assert.strictEqual(DEFAULTS.v, 1);
  assert.strictEqual(DEFAULTS.general.shell, 'pwsh');
  assert.strictEqual(DEFAULTS.general.confirmClose, false);
  assert.strictEqual(DEFAULTS.general.restoreTabs, true);
  assert.strictEqual(DEFAULTS.general.startDir, '');
  assert.strictEqual(DEFAULTS.terminal.fontSize, 13);
  assert.strictEqual(DEFAULTS.terminal.cursorStyle, 'bar');
  assert.strictEqual(DEFAULTS.terminal.scrollback, 5000);
  assert.strictEqual(DEFAULTS.terminal.rightClickPaste, false);
  assert.strictEqual(DEFAULTS.claude.model, null);
  assert.strictEqual(DEFAULTS.claude.permissionDefault, null);
  assert.strictEqual(DEFAULTS.claude.cliPath, '');
  assert.strictEqual(DEFAULTS.github.links, 'app');
  assert.strictEqual(DEFAULTS.github.pollSeconds, 60);
  assert.strictEqual(DEFAULTS.github.openAs, 'overlay');
  assert.strictEqual(DEFAULTS.github.mergeMethod, 'merge');
  assert.strictEqual(DEFAULTS.github.deleteBranchOnMerge, false);
  assert.strictEqual(DEFAULTS.editor.tabSize, 2);
  assert.strictEqual(DEFAULTS.explorer.showHidden, true);
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.general));
});

test('validate: garbage input gives defaults (and a fresh, mutable copy)', () => {
  for (const g of [null, undefined, [], 'str', 42, true, { general: [] }, { general: 'x' }]) {
    const s = validate(g);
    assert.deepStrictEqual(s, DEFAULTS);
    assert.ok(!Object.isFrozen(s.general));
  }
});

test('validate: enum rejection, bool type, unknown keys dropped', () => {
  const s = validate({
    general: { shell: 'cmd', restoreTabs: 'yes', bogus: 1 },
    claude: { model: 'gpt', permissionDefault: 'auto', autoClearDays: 14 },
    github: { pollSeconds: '60', links: 'ask' },
    nope: { a: 1 },
    v: 99
  });
  assert.strictEqual(s.general.shell, 'pwsh');
  assert.strictEqual(s.general.restoreTabs, true);
  assert.ok(!('bogus' in s.general));
  assert.ok(!('nope' in s));
  assert.strictEqual(s.v, 1);
  assert.strictEqual(s.claude.model, null);
  assert.strictEqual(s.claude.permissionDefault, 'auto');
  assert.strictEqual(s.claude.autoClearDays, 0);
  assert.strictEqual(s.github.pollSeconds, 60);
  assert.strictEqual(s.github.links, 'ask');
});

test('validate: ints clamped and rounded, non-numbers rejected', () => {
  assert.strictEqual(validate({ terminal: { fontSize: 2 } }).terminal.fontSize, 8);
  assert.strictEqual(validate({ terminal: { fontSize: 99 } }).terminal.fontSize, 32);
  assert.strictEqual(validate({ terminal: { fontSize: 14.6 } }).terminal.fontSize, 15);
  assert.strictEqual(validate({ terminal: { scrollback: -5 } }).terminal.scrollback, 0);
  assert.strictEqual(validate({ terminal: { scrollback: 1e9 } }).terminal.scrollback, 100000);
  assert.strictEqual(validate({ terminal: { fontSize: '20' } }).terminal.fontSize, 13);
  assert.strictEqual(validate({ terminal: { fontSize: NaN } }).terminal.fontSize, 13);
});

test('validate: strings trimmed, multi-line / overlong rejected', () => {
  assert.strictEqual(validate({ general: { startDir: '  C:\\dev  ' } }).general.startDir, 'C:\\dev');
  assert.strictEqual(validate({ general: { startDir: 'C:\\a\nb' } }).general.startDir, '');
  assert.strictEqual(validate({ general: { startDir: 'x'.repeat(2000) } }).general.startDir, '');
  assert.strictEqual(validate({ general: { startDir: 5 } }).general.startDir, '');
});

test('validate with base: invalid key keeps the base (current) value', () => {
  const current = applyPatch(DEFAULTS, { terminal: { fontSize: 20 }, general: { shell: 'powershell' } });
  const s = validate({ terminal: { fontSize: 'big' }, general: { shell: 'powershell' } }, current);
  assert.strictEqual(s.terminal.fontSize, 20);
  assert.strictEqual(s.general.shell, 'powershell');
  // Keys absent from the file also keep the current value.
  assert.strictEqual(validate({}, current).terminal.fontSize, 20);
});

test('applyPatch: partial patch, invalid values leave key unchanged, input not mutated', () => {
  const current = validate({ editor: { tabSize: 4 } });
  const before = JSON.stringify(current);
  const next = applyPatch(current, { editor: { wordWrap: true, tabSize: 3 }, claude: { model: 'sonnet', oneM: 'yes' } });
  assert.strictEqual(next.editor.wordWrap, true);
  assert.strictEqual(next.editor.tabSize, 4);
  assert.strictEqual(next.claude.model, 'sonnet');
  assert.strictEqual(next.claude.oneM, false);
  assert.strictEqual(next.general.shell, 'pwsh');
  assert.strictEqual(JSON.stringify(current), before);
  assert.deepStrictEqual(applyPatch(current, null), current);
  // null is a real value for nullable enums.
  assert.strictEqual(applyPatch(next, { claude: { model: null } }).claude.model, null);
});

test('resolveWorktreePath: substitution', () => {
  const r = resolveWorktreePath('D:\\wt\\worktrees\\{repo}\\{branch}', 'C:\\dev\\Mac-Code', 'feat/a\\b');
  assert.strictEqual(r, path.normalize('D:\\wt\\worktrees\\Mac-Code\\feat-a-b'));
  assert.strictEqual(resolveWorktreePath('C:\\worktrees\\{branch}-{branch}', 'C:\\r', 'x'), path.normalize('C:\\worktrees\\x-x'));
});

test('resolveWorktreePath: rejects missing {branch}, relative, "..", no worktrees segment', () => {
  assert.strictEqual(resolveWorktreePath('', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath(null, 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('C:\\worktrees\\{repo}', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('worktrees\\{branch}', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('{repo}\\worktrees\\{branch}', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('C:\\worktrees\\..\\{branch}', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('C:\\wt\\{repo}\\{branch}', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('C:\\worktrees\\{branch}', 'C:\\r', ''), null);
  if (process.platform === 'win32') {
    // Drive-relative: path.isAbsolute says yes, but it depends on the current drive.
    assert.strictEqual(resolveWorktreePath('\\worktrees\\{branch}', 'C:\\r', 'b'), null);
    // UNC shares, long-path and device prefixes are never accepted (S2).
    assert.strictEqual(resolveWorktreePath('\\\\srv\\share\\worktrees\\{branch}', 'C:\\r', 'b'), null);
    assert.strictEqual(resolveWorktreePath('//srv/share/worktrees/{branch}', 'C:\\r', 'b'), null);
    assert.strictEqual(resolveWorktreePath('\\\\?\\C:\\worktrees\\{branch}', 'C:\\r', 'b'), null);
    assert.strictEqual(resolveWorktreePath('\\\\.\\C:\\worktrees\\{branch}', 'C:\\r', 'b'), null);
    assert.strictEqual(resolveWorktreePath('C:worktrees\\{branch}', 'C:\\r', 'b'), null);
    assert.ok(!isValidWorktreeTemplate('\\\\srv\\share\\worktrees\\{repo}\\{branch}'));
  }
});

test('resolveWorktreePath: worktrees must be followed by another segment', () => {
  // The renderer matches /[\\/]worktrees[\\/]/, so 'worktrees' cannot be the last segment.
  assert.strictEqual(resolveWorktreePath('C:\\x\\{branch}\\worktrees', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('C:\\x\\{branch}\\worktrees\\', 'C:\\r', 'b'), null);
  assert.strictEqual(resolveWorktreePath('C:\\x\\{branch}', 'C:\\r', 'worktrees'), null);
  assert.ok(!isValidWorktreeTemplate('C:\\x\\{branch}\\worktrees'));
  const r = resolveWorktreePath('C:\\Worktrees\\{branch}', 'C:\\r', 'b');
  assert.ok(r && /[\\/]worktrees[\\/]/i.test(r));
  assert.ok(/[\\/]worktrees[\\/]/i.test(resolveWorktreePath('D:\\wt\\worktrees\\{repo}\\{branch}', 'C:\\dev\\app', 'x')));
});

test('isDriveAbsolutePath: drive-letter absolute only', () => {
  assert.ok(isDriveAbsolutePath('C:\\dev'));
  assert.ok(isDriveAbsolutePath('d:/dev/x'));
  assert.ok(!isDriveAbsolutePath(''));
  assert.ok(!isDriveAbsolutePath(null));
  assert.ok(!isDriveAbsolutePath(5));
  assert.ok(!isDriveAbsolutePath('dev\\x'));
  assert.ok(!isDriveAbsolutePath('C:dev'));
  if (process.platform === 'win32') {
    assert.ok(!isDriveAbsolutePath('\\dev'));
    assert.ok(!isDriveAbsolutePath('/dev'));
    assert.ok(!isDriveAbsolutePath('\\\\srv\\share'));
    assert.ok(!isDriveAbsolutePath('//srv/share'));
    assert.ok(!isDriveAbsolutePath('\\\\?\\C:\\dev'));
    assert.ok(!isDriveAbsolutePath('\\\\.\\C:\\dev'));
  }
});

test('general.startDir: validated with the drive-letter rule (S3)', () => {
  assert.strictEqual(validate({ general: { startDir: 'C:\\dev' } }).general.startDir, 'C:\\dev');
  assert.strictEqual(validate({ general: { startDir: 'dev' } }).general.startDir, '');
  assert.strictEqual(validate({ general: { startDir: '' } }).general.startDir, '');
  if (process.platform === 'win32') {
    assert.strictEqual(validate({ general: { startDir: '\\\\srv\\share' } }).general.startDir, '');
    assert.strictEqual(validate({ general: { startDir: '\\dev' } }).general.startDir, '');
    assert.strictEqual(validate({ general: { startDir: '\\\\?\\C:\\dev' } }).general.startDir, '');
    // A bad value keeps the current one.
    const cur = validate({ general: { startDir: 'C:\\dev' } });
    assert.strictEqual(applyPatch(cur, { general: { startDir: '\\\\srv\\x' } }).general.startDir, 'C:\\dev');
  }
});

test('filterImport: protected keys keep the current value and are reported (S1)', () => {
  const current = validate({
    claude: { permissionDefault: 'default', cliPath: 'C:\\tools\\claude.exe' },
    github: { worktreeTemplate: 'C:\\worktrees\\{repo}\\{branch}' },
    general: { startDir: 'C:\\dev' }
  });
  const before = JSON.stringify(current);
  const imported = {
    claude: { permissionDefault: 'bypassPermissions', cliPath: 'C:\\evil\\claude.exe', model: 'opus' },
    github: { worktreeTemplate: 'D:\\worktrees\\{branch}', links: 'browser' },
    general: { startDir: 'D:\\x', shell: 'powershell' },
    terminal: { fontSize: 20 }
  };
  const { settings, skipped } = filterImport(current, imported);
  assert.strictEqual(settings.claude.permissionDefault, 'default');
  assert.strictEqual(settings.claude.cliPath, 'C:\\tools\\claude.exe');
  assert.strictEqual(settings.github.worktreeTemplate, 'C:\\worktrees\\{repo}\\{branch}');
  assert.strictEqual(settings.general.startDir, 'C:\\dev');
  // Everything else is imported.
  assert.strictEqual(settings.claude.model, 'opus');
  assert.strictEqual(settings.github.links, 'browser');
  assert.strictEqual(settings.general.shell, 'powershell');
  assert.strictEqual(settings.terminal.fontSize, 20);
  assert.deepStrictEqual(skipped.sort(), ['claude.cliPath', 'claude.permissionDefault', 'general.startDir', 'github.worktreeTemplate']);
  assert.strictEqual(JSON.stringify(current), before);
});

test('filterImport: unchanged or absent protected keys are not reported', () => {
  const current = validate({ claude: { permissionDefault: 'auto' } });
  assert.deepStrictEqual(filterImport(current, { claude: { permissionDefault: 'auto' } }).skipped, []);
  assert.deepStrictEqual(filterImport(current, { terminal: { fontSize: 9 } }).skipped, []);
  assert.deepStrictEqual(filterImport(current, null).skipped, []);
  assert.deepStrictEqual(filterImport(current, null).settings, current);
  // null is a real value for permissionDefault: still protected.
  const r = filterImport(current, { claude: { permissionDefault: null } });
  assert.strictEqual(r.settings.claude.permissionDefault, 'auto');
  assert.deepStrictEqual(r.skipped, ['claude.permissionDefault']);
});

test('worktreeTemplate is validated on set', () => {
  assert.ok(isValidWorktreeTemplate('C:\\worktrees\\{repo}\\{branch}'));
  assert.ok(!isValidWorktreeTemplate('C:\\x\\{branch}'));
  const ok = applyPatch(DEFAULTS, { github: { worktreeTemplate: 'C:\\worktrees\\{repo}\\{branch}' } });
  assert.strictEqual(ok.github.worktreeTemplate, 'C:\\worktrees\\{repo}\\{branch}');
  assert.strictEqual(applyPatch(ok, { github: { worktreeTemplate: 'C:\\x' } }).github.worktreeTemplate, 'C:\\worktrees\\{repo}\\{branch}');
  assert.strictEqual(applyPatch(ok, { github: { worktreeTemplate: '' } }).github.worktreeTemplate, '');
});

test('isValidCliPath: absolute, existing, claude basename only', () => {
  const yes = () => true;
  const no = () => false;
  assert.ok(isValidCliPath('C:\\tools\\claude.exe', yes));
  assert.ok(isValidCliPath('C:\\tools\\CLAUDE.CMD', yes));
  assert.ok(isValidCliPath('C:\\tools\\claude', yes));
  assert.ok(!isValidCliPath('C:\\tools\\claude.exe', no));
  assert.ok(!isValidCliPath('claude.exe', yes));
  if (process.platform === 'win32') assert.ok(!isValidCliPath('\\tools\\claude.exe', yes));
  assert.ok(!isValidCliPath('C:\\tools\\calc.exe', yes));
  assert.ok(!isValidCliPath('C:\\tools\\claude.ps1', yes));
  assert.ok(!isValidCliPath('C:\\tools\\claude-evil.exe', yes));
  assert.ok(!isValidCliPath('', yes));
  assert.ok(!isValidCliPath(null, yes));
  assert.ok(!isValidCliPath('C:\\tools\\claude.exe', () => { throw new Error('x'); }));
});

test('parseWorktreeList: paths and branches, main clone first, CRLF tolerated', () => {
  const out = 'worktree C:/dev/app\r\nHEAD 1\r\nbranch refs/heads/master\r\n\r\n' +
    'worktree C:/dev/worktrees/app/feat-x\nHEAD 2\nbranch refs/heads/feat/x\n\n' +
    'worktree C:/dev/worktrees/app/rev\nHEAD 3\ndetached\n\n';
  const w = parseWorktreeList(out);
  assert.strictEqual(w.length, 3);
  assert.strictEqual(w[0].path, path.resolve('C:/dev/app'));
  assert.strictEqual(w[0].branch, 'refs/heads/master');
  assert.strictEqual(w[1].branch, 'refs/heads/feat/x');
  assert.strictEqual(w[2].branch, null);
  assert.deepStrictEqual(parseWorktreeList(''), []);
});

test('github open/merge settings: valid values kept, invalid fall back', () => {
  const ok = validate({ github: { openAs: 'tab', mergeMethod: 'rebase', deleteBranchOnMerge: false } });
  assert.strictEqual(ok.github.openAs, 'tab');
  assert.strictEqual(ok.github.mergeMethod, 'rebase');
  assert.strictEqual(ok.github.deleteBranchOnMerge, false);
  const bad = validate({ github: { openAs: 'window', mergeMethod: 'ff', deleteBranchOnMerge: 'yes' } });
  assert.strictEqual(bad.github.openAs, 'overlay');
  assert.strictEqual(bad.github.mergeMethod, 'merge');
  assert.strictEqual(bad.github.deleteBranchOnMerge, false);
});

test('general.appTheme: defaults to default, accepts the 8 themes, invalid falls back', () => {
  assert.strictEqual(DEFAULTS.general.appTheme, 'default');
  for (const id of ['default', 'fjord', 'heather', 'deep', 'graphite', 'contrast', 'cobalt', 'spiris']) {
    assert.strictEqual(validate({ general: { appTheme: id } }).general.appTheme, id);
  }
  assert.strictEqual(validate({ general: { appTheme: 'neon' } }).general.appTheme, 'default');
  assert.strictEqual(validate({ general: { appTheme: 3 } }).general.appTheme, 'default');
  const cur = validate({ general: { appTheme: 'fjord' } });
  assert.strictEqual(applyPatch(cur, { general: { appTheme: 'nope' } }).general.appTheme, 'fjord');
});

test("terminal.theme: 'app' accepted, default unchanged", () => {
  assert.strictEqual(DEFAULTS.terminal.theme, 'windowsTerminal');
  assert.strictEqual(validate({ terminal: { theme: 'app' } }).terminal.theme, 'app');
  assert.strictEqual(validate({ terminal: { theme: 'bogus' } }).terminal.theme, 'windowsTerminal');
});
