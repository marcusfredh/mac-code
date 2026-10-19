const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  KNOWN_EVENTS, MODELS, validName, validModel, parseFrontmatter, setFrontmatterField, formatValue,
  agentTemplate, skillTemplate, flattenHooks, applyHookOp, findHookScript, quoteForDisplay, createClaudeConfig
} = require('../claudeConfig');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// A fresh fake home: <tmp>/home/.claude and <tmp>/userData. Never the real ~/.claude.
function sandbox({ confirm = async () => true, settings } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfg-test-'));
  const root = path.join(base, 'home', '.claude');
  const userData = path.join(base, 'userData');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  if (settings !== undefined) {
    fs.writeFileSync(path.join(root, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  const asked = [];
  const cfg = createClaudeConfig({ root, userData, confirm: async (info) => { asked.push(info); return confirm(info); } });
  return { base, root, userData, cfg, asked, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function backups(root) {
  const d = path.join(root, 'backups', 'mac-code');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
}
function readSettings(root) { return JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')); }

// ---------------------------------------------------------------------------------
// names / models
// ---------------------------------------------------------------------------------

test('validName: accepts simple names, rejects traversal, separators, reserved', () => {
  for (const ok of ['a', 'backend-dev', 'A_1', 'x'.repeat(64)]) assert.ok(validName(ok), ok);
  for (const bad of ['', '-a', '_a', '..', '.', 'a/b', 'a\\b', '../x', 'a.md', 'a b', 'x'.repeat(65), 'CON', 'nul', 'com1', 'LPT9', null, 3, 'å']) {
    assert.ok(!validName(bad), String(bad));
  }
});

test('validModel / MODELS / KNOWN_EVENTS', () => {
  for (const ok of ['inherit', 'opus', 'claude-opus-5-5', 'opus[1m]', 'a.b']) assert.ok(validModel(ok), ok);
  for (const bad of ['', '-x', '[x', 'a b', 'a\nb', 'a:b', 'x'.repeat(81)]) assert.ok(!validModel(bad), bad);
  assert.deepStrictEqual([...MODELS], ['inherit', 'opus', 'sonnet', 'haiku', 'fable']);
  assert.ok(KNOWN_EVENTS.includes('PermissionRequest') && KNOWN_EVENTS.includes('SubagentStart'));
  assert.strictEqual(KNOWN_EVENTS.length, 12);
});

// ---------------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------------

test('parseFrontmatter: simple keys, body, order', () => {
  const t = '---\nname: skeptic\ndescription: Finds bugs.\ntools: Read, Grep\nmodel: opus\n---\n\nYou are the Skeptic.\n';
  const fm = parseFrontmatter(t);
  assert.strictEqual(fm.hasFm, true);
  assert.deepStrictEqual(fm.order, ['name', 'description', 'tools', 'model']);
  assert.strictEqual(fm.fields.model, 'opus');
  assert.strictEqual(fm.fields.tools, 'Read, Grep');
  assert.strictEqual(fm.body, '\nYou are the Skeptic.\n');
});

test('parseFrontmatter: no frontmatter / unclosed fence', () => {
  assert.deepStrictEqual(parseFrontmatter('# hi\n'), { fields: {}, order: [], body: '# hi\n', hasFm: false });
  assert.strictEqual(parseFrontmatter('---\nname: x\n').hasFm, false);
  assert.strictEqual(parseFrontmatter('').hasFm, false);
});

test('parseFrontmatter: folded and literal block scalars, chomping, quotes', () => {
  const t = [
    '---',
    'name: cavecrew',
    'description: >',
    '  Decision guide for delegating',
    '  to caveman subagents.',
    'notes: |-',
    '  line one',
    '    indented two',
    'q1: "say \\"hi\\" \\u00e5"',
    "q2: 'it''s'",
    'folded2: >+',
    '  a',
    '',
    '  b',
    '---',
    'body'
  ].join('\r\n');
  const fm = parseFrontmatter(t);
  assert.strictEqual(fm.fields.description, 'Decision guide for delegating to caveman subagents.');
  assert.strictEqual(fm.fields.notes, 'line one\n  indented two');
  assert.strictEqual(fm.fields.q1, 'say "hi" å');
  assert.strictEqual(fm.fields.q2, "it's");
  assert.strictEqual(fm.fields.folded2, 'a\nb');
  assert.strictEqual(fm.body, 'body');
});

test('parseFrontmatter: only column-0 keys; lists and nested maps belong to their key', () => {
  const t = '---\nname: a\ntools:\n  - Read\n  - "Grep"\nhooks:\n  model: nested\n  PreToolUse: x\nmodel: sonnet\n---\n';
  const fm = parseFrontmatter(t);
  assert.strictEqual(fm.fields.tools, 'Read, Grep');
  assert.strictEqual(fm.fields.model, 'sonnet');
  assert.ok(!('PreToolUse' in fm.fields));
  assert.deepStrictEqual(fm.order, ['name', 'tools', 'hooks', 'model']);
});

test('setFrontmatterField: replace keeps every other byte (LF)', () => {
  const t = '---\nname: a\ndescription: >\n  long\n  text\nmodel: opus\nx-unknown: [1, 2]\n# comment\n---\n\nBody --- with fence-like text\n---\n';
  const out = setFrontmatterField(t, 'model', 'sonnet');
  assert.strictEqual(out, t.replace('model: opus', 'model: sonnet'));
});

test('setFrontmatterField: CRLF preserved, add before fence, remove', () => {
  const t = '---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n';
  const added = setFrontmatterField(t, 'model', 'inherit');
  assert.strictEqual(added, '---\r\nname: a\r\ndescription: d\r\nmodel: inherit\r\n---\r\nbody\r\n');
  assert.strictEqual(setFrontmatterField(added, 'model', null), t);
  assert.strictEqual(setFrontmatterField(t, 'nope', null), t);
});

test('setFrontmatterField: replacing a block-scalar key drops only its continuation lines', () => {
  const t = '---\nname: a\ndescription: >\n  one\n  two\n\nmodel: opus\n---\nb';
  assert.strictEqual(setFrontmatterField(t, 'description', 'new'), '---\nname: a\ndescription: new\n\nmodel: opus\n---\nb');
});

test('setFrontmatterField: nested "  model:" never matches (R5)', () => {
  const t = '---\nname: a\nhooks:\n  model: nested\ntools:\n  - model: x\n---\nb';
  const out = setFrontmatterField(t, 'model', 'haiku');
  assert.strictEqual(out, '---\nname: a\nhooks:\n  model: nested\ntools:\n  - model: x\nmodel: haiku\n---\nb');
});

test('setFrontmatterField: no frontmatter gets one; values cannot inject lines or fences', () => {
  assert.strictEqual(setFrontmatterField('body\n', 'model', 'opus'), '---\nmodel: opus\n---\nbody\n');
  const out = setFrontmatterField('---\nname: a\n---\nb', 'description', 'x\n---\nevil: 1');
  assert.strictEqual(out, '---\nname: a\ndescription: "x --- evil: 1"\n---\nb');
  assert.strictEqual(parseFrontmatter(out).fields.description, 'x --- evil: 1');
  assert.ok(!('evil' in parseFrontmatter(out).fields));
  assert.throws(() => setFrontmatterField('', 'bad key', 'x'));
});

test('formatValue: plain when safe, JSON-quoted otherwise (R3)', () => {
  assert.strictEqual(formatValue('Reviews diffs (read-only), fast.'), 'Reviews diffs (read-only), fast.');
  for (const v of ['a: b', '- item', '#x', 'it\'s', 'x # y', '"q"', '>fold', '', 'trailing ', 'å']) {
    const f = formatValue(v);
    assert.strictEqual(f, JSON.stringify(v), v);
  }
  assert.strictEqual(formatValue('a\r\nb'), 'a b');
});

test('agentTemplate / skillTemplate round-trip through parseFrontmatter', () => {
  const a = parseFrontmatter(agentTemplate({ name: 'my-agent', description: 'Does: things', model: 'sonnet' }));
  assert.deepStrictEqual(a.fields, { name: 'my-agent', description: 'Does: things', model: 'sonnet' });
  assert.strictEqual(parseFrontmatter(agentTemplate({ name: 'x', description: '' })).fields.model, 'inherit');
  assert.strictEqual(parseFrontmatter(agentTemplate({ name: 'x', model: 'bad model' })).fields.model, 'inherit');
  const s = parseFrontmatter(skillTemplate({ name: 'sk', description: 'When "x"' }));
  assert.deepStrictEqual(s.fields, { name: 'sk', description: 'When "x"' });
  assert.ok(s.body.includes('# sk'));
});

// ---------------------------------------------------------------------------------
// hooks (pure)
// ---------------------------------------------------------------------------------

const HOOKS = {
  SessionStart: [{ hooks: [
    { type: 'command', command: 'node a.js', timeout: 5, statusMessage: 'Loading' },
    { type: 'command', command: 'node b.js' }
  ] }],
  PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node g.js', extra: { keep: 1 } }] },
    { matcher: 'Edit', hooks: [{ type: 'prompt', prompt: 'Check it' }] }
  ]
};

test('flattenHooks: shape, matcher, index, defaults', () => {
  const f = flattenHooks(HOOKS);
  assert.strictEqual(f.length, 4);
  assert.deepStrictEqual(Object.keys(f[0]).sort(), ['command', 'event', 'id', 'index', 'matcher', 'statusMessage', 'timeout', 'type']);
  assert.deepStrictEqual(f[0].index, { group: 0, hook: 0 });
  assert.strictEqual(f[0].matcher, '');
  assert.strictEqual(f[0].timeout, 5);
  assert.strictEqual(f[1].timeout, null);
  assert.strictEqual(f[2].matcher, 'Bash');
  assert.strictEqual(f[3].type, 'prompt');
  assert.strictEqual(f[3].command, '');
  assert.match(f[0].id, /^[0-9a-f]{12}:0$/);
  assert.deepStrictEqual(flattenHooks(null), []);
  assert.deepStrictEqual(flattenHooks({ X: 'nope', Y: [null, { hooks: 'x' }, { hooks: [null] }] }), []);
});

test('flattenHooks: id stable across reordering; duplicates get an occurrence', () => {
  const a = flattenHooks(HOOKS);
  const reordered = { PreToolUse: [HOOKS.PreToolUse[1], HOOKS.PreToolUse[0]], SessionStart: [{ hooks: [HOOKS.SessionStart[0].hooks[1], HOOKS.SessionStart[0].hooks[0]] }] };
  const b = flattenHooks(reordered);
  assert.deepStrictEqual(a.map((h) => h.id).sort(), b.map((h) => h.id).sort());
  const dup = flattenHooks({ Stop: [{ hooks: [{ type: 'command', command: 'x' }, { type: 'command', command: 'x' }] }] });
  assert.strictEqual(dup[0].id.split(':')[0], dup[1].id.split(':')[0]);
  assert.deepStrictEqual(dup.map((h) => h.id.split(':')[1]), ['0', '1']);
});

test('applyHookOp: pure (input untouched)', () => {
  const before = JSON.stringify(HOOKS);
  const id = flattenHooks(HOOKS)[0].id;
  applyHookOp(HOOKS, { op: 'remove', id });
  applyHookOp(HOOKS, { op: 'update', id, command: 'x' });
  applyHookOp(HOOKS, { op: 'add', event: 'Stop', matcher: '', hook: { type: 'command', command: 'y' } });
  assert.strictEqual(JSON.stringify(HOOKS), before);
});

test('applyHookOp add: joins an existing group (missing == ""), else new group without matcher key', () => {
  const h = applyHookOp(HOOKS, { op: 'add', event: 'SessionStart', matcher: '', hook: { type: 'command', command: 'c' } });
  assert.strictEqual(h.SessionStart.length, 1);
  assert.strictEqual(h.SessionStart[0].hooks[2].command, 'c');
  const h2 = applyHookOp(HOOKS, { op: 'add', event: 'Stop', matcher: '', hook: { type: 'command', command: 'c' } });
  assert.deepStrictEqual(h2.Stop, [{ hooks: [{ type: 'command', command: 'c' }] }]);
  const h3 = applyHookOp(HOOKS, { op: 'add', event: 'PreToolUse', matcher: '*', hook: { type: 'command', command: 'c' } });
  assert.strictEqual(h3.PreToolUse.length, 3);
  assert.strictEqual(h3.PreToolUse[2].matcher, '*');
  const h4 = applyHookOp({ Stop: [{ matcher: '', hooks: [] }] }, { op: 'add', event: 'Stop', matcher: '', hook: { type: 'command', command: 'z' } });
  assert.deepStrictEqual(h4.Stop, [{ matcher: '', hooks: [{ type: 'command', command: 'z' }] }]);
});

test('applyHookOp remove: prunes empty groups and events', () => {
  const f = flattenHooks(HOOKS);
  let h = applyHookOp(HOOKS, { op: 'remove', id: f[2].id });
  assert.strictEqual(h.PreToolUse.length, 1);
  h = applyHookOp(h, { op: 'remove', id: flattenHooks(h).find((x) => x.type === 'prompt').id });
  assert.ok(!('PreToolUse' in h));
  assert.throws(() => applyHookOp(HOOKS, { op: 'remove', id: 'nope:0' }), /not found/);
  assert.throws(() => applyHookOp(HOOKS, { op: 'bogus', id: f[0].id }), /unknown op/);
});

test('applyHookOp update: keeps unknown fields, timeout null removes, matcher moves group', () => {
  const f = flattenHooks(HOOKS);
  let h = applyHookOp(HOOKS, { op: 'update', id: f[2].id, command: 'node g2.js', timeout: 9 });
  assert.deepStrictEqual(h.PreToolUse[0].hooks[0], { type: 'command', command: 'node g2.js', extra: { keep: 1 }, timeout: 9 });
  h = applyHookOp(HOOKS, { op: 'update', id: f[0].id, timeout: null });
  assert.deepStrictEqual(h.SessionStart[0].hooks[0], { type: 'command', command: 'node a.js', statusMessage: 'Loading' });
  h = applyHookOp(HOOKS, { op: 'update', id: f[2].id, matcher: 'Edit' });
  assert.strictEqual(h.PreToolUse.length, 1);
  assert.strictEqual(h.PreToolUse[0].matcher, 'Edit');
  assert.strictEqual(h.PreToolUse[0].hooks.length, 2);
  h = applyHookOp(HOOKS, { op: 'update', id: f[0].id, matcher: 'X' });
  assert.strictEqual(h.SessionStart.length, 2);
  assert.strictEqual(h.SessionStart[1].matcher, 'X');
});

test('applyHookOp update: refuses a command change on non-command hooks (R8)', () => {
  const p = flattenHooks(HOOKS)[3];
  assert.throws(() => applyHookOp(HOOKS, { op: 'update', id: p.id, command: 'rm -rf /' }), /only command hooks/);
  const h = applyHookOp(HOOKS, { op: 'update', id: p.id, timeout: 3 });
  assert.strictEqual(h.PreToolUse[1].hooks[0].timeout, 3);
});

test('findHookScript: quoted, bare, forward slashes, case, ~, outside, missing', () => {
  const s = sandbox();
  try {
    const hooksDir = path.join(s.root, 'hooks');
    const script = path.join(hooksDir, 'gate.js');
    fs.writeFileSync(script, '');
    const home = path.dirname(s.root);
    const fwd = script.replace(/\\/g, '/');
    assert.strictEqual(findHookScript(`"C:\\Program Files\\nodejs\\node.exe" "${script}"`, hooksDir, { home }), script);
    assert.strictEqual(findHookScript(`node ${fwd} pre`, hooksDir, { home }), path.resolve(script));
    assert.strictEqual(findHookScript("node '~/.claude/hooks/gate.js'", hooksDir, { home }), script);
    if (process.platform === 'win32') {
      assert.strictEqual(findHookScript(`node ${fwd.toLowerCase()}`, hooksDir, { home }).toLowerCase(), script.toLowerCase());
    }
    assert.strictEqual(findHookScript('node ' + path.join(hooksDir, 'missing.js'), hooksDir, { home }), null);
    assert.strictEqual(findHookScript('node ' + path.join(hooksDir, '..', 'settings.json'), hooksDir, { home }), null);
    assert.strictEqual(findHookScript('node gate.js', hooksDir, { home }), null);
    assert.strictEqual(findHookScript('node ' + hooksDir, hooksDir, { home }), null);
    assert.strictEqual(findHookScript(null, hooksDir, { home }), null);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------
// store: list
// ---------------------------------------------------------------------------------

test('list: empty root', () => {
  const s = sandbox();
  try {
    const r = s.cfg.list();
    assert.deepStrictEqual(r, { ok: true, agents: [], skills: [], hooks: [], disabled: [], settingsRev: null, paths: { root: s.root } });
  } finally { s.cleanup(); }
});

test('list: agents keyed by stem, readonly for bad stems, rev = sha1 of bytes', () => {
  const s = sandbox();
  try {
    const txt = '---\nname: Pretty Name\ndescription: >\n  multi\n  line\ntools: Read, Bash\nmodel: opus\n---\nbody';
    fs.writeFileSync(path.join(s.root, 'agents', 'rev.md'), txt);
    fs.writeFileSync(path.join(s.root, 'agents', 'bad name.md'), 'x');
    fs.writeFileSync(path.join(s.root, 'agents', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(s.root, 'agents', 'big.md'), Buffer.alloc(1024 * 1024 + 1, 0x61));
    const { agents } = s.cfg.list();
    assert.deepStrictEqual(agents.map((a) => a.id), ['bad name', 'big', 'rev']);
    const a = agents.find((x) => x.id === 'rev');
    assert.deepStrictEqual(a, { id: 'rev', name: 'Pretty Name', description: 'multi line', model: 'opus', tools: 'Read, Bash', rev: sha1(txt), readonly: false });
    assert.strictEqual(agents[0].readonly, true);
    assert.strictEqual(agents[1].readonly, true);
    assert.match(agents[1].error, /too large/);
  } finally { s.cleanup(); }
});

test('list: skills only with SKILL.md; real dir counts files; junction is linked (R1)', () => {
  const s = sandbox();
  try {
    const real = path.join(s.root, 'skills', 'real');
    fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(real, 'SKILL.md'), '---\nname: real\ndescription: R\n---\n');
    fs.writeFileSync(path.join(real, 'sub', 'a.md'), 'a');
    fs.mkdirSync(path.join(s.root, 'skills', 'noskill'));
    const target = path.join(s.base, 'agents-skills', 'lnk');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: lnk\ndescription: L\n---\n');
    fs.symlinkSync(target, path.join(s.root, 'skills', 'lnk'), 'junction');
    const { skills } = s.cfg.list();
    assert.deepStrictEqual(skills.map((x) => x.id), ['lnk', 'real']);
    const [l, r] = skills;
    assert.strictEqual(l.linked, true);
    assert.strictEqual(l.target.toLowerCase(), fs.realpathSync(target).toLowerCase());
    assert.strictEqual(l.files, null);
    assert.strictEqual(l.description, 'L');
    assert.deepStrictEqual(Object.keys(r).sort(), ['description', 'files', 'id', 'linked', 'name', 'readonly', 'rev', 'target']);
    assert.strictEqual(r.linked, false);
    assert.strictEqual(r.target, null);
    assert.strictEqual(r.files, 2);
  } finally { s.cleanup(); }
});

test('list: hooks with enabled/editable/script, settingsRev, disabled entries', () => {
  const s = sandbox();
  try {
    const script = path.join(s.root, 'hooks', 'g.js');
    fs.writeFileSync(script, '');
    const settings = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${script}"` }, { type: 'agent', prompt: 'x' }] }] } };
    const raw = JSON.stringify(settings, null, 2);
    fs.writeFileSync(path.join(s.root, 'settings.json'), raw);
    fs.mkdirSync(s.userData, { recursive: true });
    fs.writeFileSync(path.join(s.userData, 'claude-disabled-hooks.json'), JSON.stringify([
      { id: 'abc', event: 'Stop', matcher: 'Bash', hook: { type: 'command', command: 'node ' + script, timeout: 4 }, disabledAt: '2026-01-01T00:00:00.000Z' }
    ]));
    const r = s.cfg.list();
    assert.strictEqual(r.settingsRev, sha1(raw));
    assert.strictEqual(r.hooks.length, 2);
    assert.deepStrictEqual([r.hooks[0].enabled, r.hooks[0].editable, r.hooks[0].script], [true, true, script]);
    assert.deepStrictEqual([r.hooks[1].editable, r.hooks[1].script], [false, null]);
    assert.strictEqual(r.disabled.length, 1);
    assert.deepStrictEqual(r.disabled[0], {
      id: 'abc', event: 'Stop', matcher: 'Bash', command: 'node ' + script, timeout: 4, type: 'command',
      statusMessage: null, disabledAt: '2026-01-01T00:00:00.000Z', enabled: false, editable: false, script
    });
  } finally { s.cleanup(); }
});

test('list: invalid settings.json reports settingsError, other groups still listed', () => {
  const s = sandbox({ settings: '{ broken' });
  try {
    fs.writeFileSync(path.join(s.root, 'agents', 'a.md'), '---\nname: a\n---\n');
    const r = s.cfg.list();
    assert.strictEqual(r.ok, true);
    assert.match(r.settingsError, /not valid JSON/);
    assert.deepStrictEqual(r.hooks, []);
    assert.strictEqual(r.agents.length, 1);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------
// store: agents
// ---------------------------------------------------------------------------------

test('agentCreate: template, refuses existing / invalid names, returns path', () => {
  const s = sandbox();
  try {
    const r = s.cfg.agentCreate({ name: 'new-one', description: 'Line1\nLine2: x', model: 'sonnet' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, path.join(s.root, 'agents', 'new-one.md'));
    const fm = parseFrontmatter(fs.readFileSync(r.path, 'utf8'));
    assert.deepStrictEqual(fm.fields, { name: 'new-one', description: 'Line1 Line2: x', model: 'sonnet' });
    assert.match(s.cfg.agentCreate({ name: 'new-one' }).error, /already exists/);
    if (process.platform === 'win32') assert.match(s.cfg.agentCreate({ name: 'NEW-ONE' }).error, /already exists/);
    for (const bad of ['../evil', 'a/b', 'con', '', undefined]) assert.strictEqual(s.cfg.agentCreate({ name: bad }).error, 'invalid name');
    assert.strictEqual(s.cfg.agentCreate({ name: 'm', model: 'bad model' }).error, 'invalid model');
    assert.ok(!fs.existsSync(path.join(s.root, '..', 'evil.md')));
    assert.deepStrictEqual(backups(s.root), []);
  } finally { s.cleanup(); }
});

test('agentSetModel: rewrites only the model line, backs up, conflict on stale rev', () => {
  const s = sandbox();
  try {
    const p = path.join(s.root, 'agents', 'x.md');
    const txt = '---\r\nname: x\r\ndescription: >\r\n  d\r\nmodel: opus\r\nfoo: bar\r\n---\r\n\r\nbody\r\n';
    fs.writeFileSync(p, txt);
    const rev = s.cfg.list().agents[0].rev;
    assert.deepStrictEqual(s.cfg.agentSetModel({ name: 'x', model: 'inherit', rev }), { ok: true });
    assert.strictEqual(fs.readFileSync(p, 'utf8'), txt.replace('model: opus', 'model: inherit'));
    const b = backups(s.root);
    assert.strictEqual(b.length, 1);
    assert.match(b[0], /^\d{8}-\d{6}-\d{3}-1-agent-x\.md$/);
    assert.strictEqual(fs.readFileSync(path.join(s.root, 'backups', 'mac-code', b[0]), 'utf8'), txt);
    const stale = s.cfg.agentSetModel({ name: 'x', model: 'haiku', rev });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.conflict, true);
    assert.strictEqual(s.cfg.agentSetModel({ name: 'x', model: 'a b', rev }).error, 'invalid model');
    assert.strictEqual(s.cfg.agentSetModel({ name: 'gone', model: 'opus', rev }).conflict, true);
    assert.ok(!fs.readdirSync(path.join(s.root, 'agents')).some((f) => f.endsWith('.tmp')));
  } finally { s.cleanup(); }
});

test('agentDelete: rev-checked, backed up; agentPath', () => {
  const s = sandbox();
  try {
    const p = path.join(s.root, 'agents', 'x.md');
    fs.writeFileSync(p, 'hello');
    assert.strictEqual(s.cfg.agentPath({ name: 'x' }), p);
    assert.strictEqual(s.cfg.agentPath({ name: '../x' }), null);
    assert.strictEqual(s.cfg.agentPath({ name: 'missing' }), null);
    assert.strictEqual(s.cfg.agentDelete({ name: 'x', rev: 'wrong' }).conflict, true);
    assert.ok(fs.existsSync(p));
    assert.deepStrictEqual(s.cfg.agentDelete({ name: 'x', rev: sha1('hello') }), { ok: true });
    assert.ok(!fs.existsSync(p));
    assert.strictEqual(fs.readFileSync(path.join(s.root, 'backups', 'mac-code', backups(s.root)[0]), 'utf8'), 'hello');
  } finally { s.cleanup(); }
});

test('backups never overwrite: same timestamp gets a counter (R10)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfg-test-'));
  try {
    const root = path.join(base, '.claude');
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    const fixed = new Date(2026, 9, 19, 8, 7, 6, 5);
    const cfg = createClaudeConfig({ root, userData: path.join(base, 'ud'), now: () => fixed });
    const p = path.join(root, 'agents', 'x.md');
    fs.writeFileSync(p, '---\nmodel: a\n---\n');
    for (const m of ['b', 'c', 'd']) {
      const rev = cfg.list().agents[0].rev;
      assert.strictEqual(cfg.agentSetModel({ name: 'x', model: m, rev }).ok, true);
    }
    assert.deepStrictEqual(backups(root), ['20261019-080706-005-1-agent-x.md', '20261019-080706-005-2-agent-x.md', '20261019-080706-005-3-agent-x.md']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------
// store: skills
// ---------------------------------------------------------------------------------

test('skillCreate / skillPath', () => {
  const s = sandbox();
  try {
    const r = s.cfg.skillCreate({ name: 'my-skill', description: 'Use when X' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, path.join(s.root, 'skills', 'my-skill', 'SKILL.md'));
    assert.strictEqual(parseFrontmatter(fs.readFileSync(r.path, 'utf8')).fields.description, 'Use when X');
    assert.strictEqual(s.cfg.skillPath({ name: 'my-skill' }), r.path);
    assert.strictEqual(s.cfg.skillPath({ name: '..' }), null);
    assert.match(s.cfg.skillCreate({ name: 'my-skill' }).error, /already exists/);
    assert.strictEqual(s.cfg.skillCreate({ name: '../x' }).error, 'invalid name');
  } finally { s.cleanup(); }
});

test('skillDelete real dir: copies the folder to backups, then removes it', () => {
  const s = sandbox();
  try {
    const d = path.join(s.root, 'skills', 'real');
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), 'S');
    fs.writeFileSync(path.join(d, 'sub', 'a.txt'), 'A');
    assert.deepStrictEqual(s.cfg.skillDelete({ name: 'real' }), { ok: true });
    assert.ok(!fs.existsSync(d));
    const [b] = backups(s.root);
    assert.match(b, /-1-skill-real$/);
    assert.strictEqual(fs.readFileSync(path.join(s.root, 'backups', 'mac-code', b, 'sub', 'a.txt'), 'utf8'), 'A');
    assert.strictEqual(s.cfg.skillDelete({ name: 'real' }).conflict, true);
    assert.strictEqual(s.cfg.skillDelete({ name: '..' }).error, 'invalid name');
  } finally { s.cleanup(); }
});

test('skillDelete junction: removes only the link, target content stays (R1)', () => {
  const s = sandbox();
  try {
    const target = path.join(s.base, 'agents-skills', 'lnk');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'keep me');
    fs.writeFileSync(path.join(target, 'other.txt'), 'and me');
    const link = path.join(s.root, 'skills', 'lnk');
    fs.symlinkSync(target, link, 'junction');
    assert.strictEqual(s.cfg.skillPath({ name: 'lnk' }), path.join(link, 'SKILL.md'));
    assert.deepStrictEqual(s.cfg.skillDelete({ name: 'lnk' }), { ok: true });
    assert.ok(!fs.existsSync(link));
    assert.strictEqual(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'keep me');
    assert.strictEqual(fs.readFileSync(path.join(target, 'other.txt'), 'utf8'), 'and me');
    const [b] = backups(s.root);
    assert.match(b, /-1-skill-lnk\.link\.json$/);
    const rec = JSON.parse(fs.readFileSync(path.join(s.root, 'backups', 'mac-code', b), 'utf8'));
    assert.strictEqual(rec.link, link);
    assert.strictEqual(rec.target.toLowerCase(), fs.realpathSync(target).toLowerCase());
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------
// store: hooks
// ---------------------------------------------------------------------------------

const BASE_SETTINGS = {
  permissions: { allow: ['Bash(git:*)'] },
  model: 'opus',
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.js', timeout: 5 }] }] },
  statusLine: { type: 'command', command: 'x' }
};

test('hookAdd: confirm shown with event/matcher/command; only hooks change; backup; pretty + newline', async () => {
  const s = sandbox({ settings: BASE_SETTINGS });
  try {
    const rev = s.cfg.list().settingsRev;
    const r = await s.cfg.hookAdd({ event: 'PreToolUse', matcher: 'Bash', command: 'node guard.js', timeout: '7', settingsRev: rev });
    assert.deepStrictEqual(r, { ok: true });
    assert.deepStrictEqual(s.asked, [{ action: 'add', event: 'PreToolUse', matcher: 'Bash', command: 'node guard.js' }]);
    const raw = fs.readFileSync(path.join(s.root, 'settings.json'), 'utf8');
    const obj = JSON.parse(raw);
    assert.strictEqual(raw, JSON.stringify(obj, null, 2) + '\n');
    assert.deepStrictEqual(Object.keys(obj), ['permissions', 'model', 'hooks', 'statusLine']);
    assert.deepStrictEqual(obj.permissions, BASE_SETTINGS.permissions);
    assert.deepStrictEqual(obj.statusLine, BASE_SETTINGS.statusLine);
    assert.deepStrictEqual(obj.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js', timeout: 7 }] }]);
    const b = backups(s.root);
    assert.strictEqual(b.length, 1);
    assert.match(b[0], /-1-settings\.json$/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.root, 'backups', 'mac-code', b[0]), 'utf8')), BASE_SETTINGS);
  } finally { s.cleanup(); }
});

test('hookAdd: canceled confirm writes nothing', async () => {
  const s = sandbox({ settings: BASE_SETTINGS, confirm: async () => false });
  try {
    const before = fs.readFileSync(path.join(s.root, 'settings.json'), 'utf8');
    const r = await s.cfg.hookAdd({ event: 'Stop', command: 'x', settingsRev: s.cfg.list().settingsRev });
    assert.deepStrictEqual(r, { ok: false, error: 'canceled', canceled: true });
    assert.strictEqual(fs.readFileSync(path.join(s.root, 'settings.json'), 'utf8'), before);
    assert.deepStrictEqual(backups(s.root), []);
  } finally { s.cleanup(); }
});

test('hookAdd: validation, and no confirm when invalid', async () => {
  const s = sandbox({ settings: BASE_SETTINGS });
  try {
    const rev = s.cfg.list().settingsRev;
    assert.strictEqual((await s.cfg.hookAdd({ event: 'Bad-Event', command: 'x', settingsRev: rev })).error, 'invalid event');
    assert.strictEqual((await s.cfg.hookAdd({ event: 'Stop', command: '  ', settingsRev: rev })).error, 'invalid command');
    assert.match((await s.cfg.hookAdd({ event: 'Stop', command: 'x', timeout: 0, settingsRev: rev })).error, /timeout/);
    assert.match((await s.cfg.hookAdd({ event: 'Stop', command: 'x', timeout: '1.5', settingsRev: rev })).error, /timeout/);
    assert.strictEqual((await s.cfg.hookAdd({ event: 'Stop', matcher: 'a\nb', command: 'x', settingsRev: rev })).error, 'Matchern innehåller otillåtna tecken');
    assert.deepStrictEqual(s.asked, []);
  } finally { s.cleanup(); }
});

test('hookAdd: conflict when settings.json changed (before or during the confirm)', async () => {
  const s = sandbox({ settings: BASE_SETTINGS });
  try {
    const f = path.join(s.root, 'settings.json');
    const rev = s.cfg.list().settingsRev;
    fs.writeFileSync(f, JSON.stringify({ ...BASE_SETTINGS, model: 'sonnet' }));
    let r = await s.cfg.hookAdd({ event: 'Stop', command: 'x', settingsRev: rev });
    assert.strictEqual(r.conflict, true);
    assert.deepStrictEqual(s.asked, []);
    // Changed while the dialog was open.
    const rev2 = s.cfg.list().settingsRev;
    const s2 = createClaudeConfig({ root: s.root, userData: s.userData, confirm: async () => { fs.writeFileSync(f, '{"x":1}'); return true; } });
    r = await s2.hookAdd({ event: 'Stop', command: 'x', settingsRev: rev2 });
    assert.strictEqual(r.conflict, true);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"x":1}');
  } finally { s.cleanup(); }
});

test('hook ops refuse an invalid settings.json (never clobbered)', async () => {
  const s = sandbox({ settings: '{ "model": "opus", ' });
  try {
    const rev = s.cfg.list().settingsRev;
    const r = await s.cfg.hookAdd({ event: 'Stop', command: 'x', settingsRev: rev });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not valid JSON/);
    assert.strictEqual(fs.readFileSync(path.join(s.root, 'settings.json'), 'utf8'), '{ "model": "opus", ');
    const s2 = sandbox({ settings: '[1,2]' });
    try { assert.match(s2.cfg.hookRemove({ id: 'x:0', settingsRev: s2.cfg.list().settingsRev }).error, /not a JSON object/); } finally { s2.cleanup(); }
  } finally { s.cleanup(); }
});

test('hookAdd: creates settings.json when missing (rev null)', async () => {
  const s = sandbox();
  try {
    const r = await s.cfg.hookAdd({ event: 'Stop', command: 'x', settingsRev: null });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(readSettings(s.root), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    assert.deepStrictEqual(backups(s.root), []);
  } finally { s.cleanup(); }
});

test('hookUpdate: confirm when the command or the matcher changes; timeout-only edits do not ask', async () => {
  const s = sandbox({ settings: BASE_SETTINGS });
  try {
    let l = s.cfg.list();
    let r = await s.cfg.hookUpdate({ id: l.hooks[0].id, matcher: '', timeout: '', settingsRev: l.settingsRev });
    assert.deepStrictEqual(r, { ok: true });
    assert.deepStrictEqual(s.asked, [], 'same matcher + timeout only: no confirm');
    l = s.cfg.list();
    r = await s.cfg.hookUpdate({ id: l.hooks[0].id, matcher: 'Bash', settingsRev: l.settingsRev });
    assert.deepStrictEqual(r, { ok: true });
    assert.deepStrictEqual(s.asked, [{ action: 'update', event: 'Stop', matcher: 'Bash', command: 'node stop.js' }]);
    assert.deepStrictEqual(readSettings(s.root).hooks, { Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node stop.js' }] }] });
    s.asked.length = 0;
    l = s.cfg.list();
    r = await s.cfg.hookUpdate({ id: l.hooks[0].id, command: 'node other.js', matcher: 'Bash', timeout: 3, settingsRev: l.settingsRev });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(s.asked, [{ action: 'update', event: 'Stop', matcher: 'Bash', command: 'node other.js' }]);
    assert.deepStrictEqual(readSettings(s.root).hooks.Stop[0].hooks[0], { type: 'command', command: 'node other.js', timeout: 3 });
    l = s.cfg.list();
    assert.strictEqual((await s.cfg.hookUpdate({ id: 'nope:0', settingsRev: l.settingsRev })).conflict, true);
    assert.strictEqual((await s.cfg.hookUpdate({ id: l.hooks[0].id, settingsRev: 'stale' })).conflict, true);
  } finally { s.cleanup(); }
});

test('hookUpdate: refuses a command change on a non-command hook (R8)', async () => {
  const s = sandbox({ settings: { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'p' }] }] } } });
  try {
    const l = s.cfg.list();
    const r = await s.cfg.hookUpdate({ id: l.hooks[0].id, command: 'evil', settingsRev: l.settingsRev });
    assert.match(r.error, /only command hooks/);
    assert.deepStrictEqual(s.asked, []);
  } finally { s.cleanup(); }
});

test('hookUpdate: canceled confirm writes nothing', async () => {
  const s = sandbox({ settings: BASE_SETTINGS, confirm: async () => false });
  try {
    const l = s.cfg.list();
    const r = await s.cfg.hookUpdate({ id: l.hooks[0].id, command: 'new', settingsRev: l.settingsRev });
    assert.strictEqual(r.canceled, true);
    assert.deepStrictEqual(readSettings(s.root), BASE_SETTINGS);
  } finally { s.cleanup(); }
});

test('hookRemove: last hook removes the hooks key; no confirm', () => {
  const s = sandbox({ settings: BASE_SETTINGS });
  try {
    const l = s.cfg.list();
    assert.deepStrictEqual(s.cfg.hookRemove({ id: l.hooks[0].id, settingsRev: l.settingsRev }), { ok: true });
    const obj = readSettings(s.root);
    assert.ok(!('hooks' in obj));
    assert.deepStrictEqual(Object.keys(obj), ['permissions', 'model', 'statusLine']);
    assert.deepStrictEqual(s.asked, []);
    assert.strictEqual(s.cfg.hookRemove({ id: l.hooks[0].id, settingsRev: s.cfg.list().settingsRev }).conflict, true);
  } finally { s.cleanup(); }
});

test('hookDisable -> hookEnable round-trip through the disabled store', async () => {
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node g.js', timeout: 5, custom: true }, { type: 'command', command: 'node h.js' }] }] } };
  const s = sandbox({ settings });
  try {
    let l = s.cfg.list();
    const target = l.hooks[0];
    assert.deepStrictEqual(s.cfg.hookDisable({ id: target.id, settingsRev: l.settingsRev }), { ok: true });
    assert.deepStrictEqual(s.asked, []);
    assert.deepStrictEqual(readSettings(s.root).hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'node h.js' }]);
    const store = JSON.parse(fs.readFileSync(path.join(s.userData, 'claude-disabled-hooks.json'), 'utf8'));
    assert.strictEqual(store.length, 1);
    assert.deepStrictEqual(Object.keys(store[0]).sort(), ['disabledAt', 'event', 'hook', 'id', 'matcher']);
    assert.match(store[0].id, /^[0-9a-f]{12}$/);
    assert.deepStrictEqual(store[0].hook, { type: 'command', command: 'node g.js', timeout: 5, custom: true });
    l = s.cfg.list();
    assert.strictEqual(l.disabled.length, 1);
    assert.strictEqual(l.disabled[0].matcher, 'Bash');
    assert.strictEqual(l.hooks.length, 1);

    assert.strictEqual((await s.cfg.hookEnable({ disabledId: store[0].id, settingsRev: 'stale' })).conflict, true);
    const r = await s.cfg.hookEnable({ disabledId: store[0].id, settingsRev: l.settingsRev });
    assert.deepStrictEqual(r, { ok: true });
    assert.deepStrictEqual(s.asked.at(-1), { action: 'enable', event: 'PreToolUse', matcher: 'Bash', command: 'node g.js' });
    const hooks = readSettings(s.root).hooks.PreToolUse;
    assert.strictEqual(hooks.length, 1, 'rejoins the existing Bash group');
    assert.deepStrictEqual(hooks[0].hooks[1], { type: 'command', command: 'node g.js', timeout: 5, custom: true });
    assert.deepStrictEqual(s.cfg.list().disabled, []);
    assert.strictEqual((await s.cfg.hookEnable({ disabledId: store[0].id, settingsRev: s.cfg.list().settingsRev })).conflict, true);
  } finally { s.cleanup(); }
});

test('hookDisable of the only hook, then enable into a new group without matcher key', async () => {
  const s = sandbox({ settings: { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] } } });
  try {
    let l = s.cfg.list();
    assert.strictEqual(s.cfg.hookDisable({ id: l.hooks[0].id, settingsRev: l.settingsRev }).ok, true);
    assert.deepStrictEqual(readSettings(s.root), { model: 'x' });
    l = s.cfg.list();
    assert.strictEqual((await s.cfg.hookEnable({ disabledId: l.disabled[0].id, settingsRev: l.settingsRev })).ok, true);
    assert.deepStrictEqual(readSettings(s.root), { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] } });
  } finally { s.cleanup(); }
});

test('hookEnable: canceled confirm leaves both files untouched', async () => {
  const s = sandbox({ settings: BASE_SETTINGS, confirm: async () => false });
  try {
    let l = s.cfg.list();
    s.cfg.hookDisable({ id: l.hooks[0].id, settingsRev: l.settingsRev });
    l = s.cfg.list();
    const storeBefore = fs.readFileSync(path.join(s.userData, 'claude-disabled-hooks.json'), 'utf8');
    const r = await s.cfg.hookEnable({ disabledId: l.disabled[0].id, settingsRev: l.settingsRev });
    assert.strictEqual(r.canceled, true);
    assert.strictEqual(fs.readFileSync(path.join(s.userData, 'claude-disabled-hooks.json'), 'utf8'), storeBefore);
    assert.ok(!('hooks' in readSettings(s.root)));
  } finally { s.cleanup(); }
});

test('hookScriptPath: active and disabled ids', () => {
  const s = sandbox();
  try {
    const script = path.join(s.root, 'hooks', 'x.js');
    fs.writeFileSync(script, '');
    fs.writeFileSync(path.join(s.root, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${script}"` }, { type: 'command', command: 'echo hi' }] }] } }));
    let l = s.cfg.list();
    assert.strictEqual(s.cfg.hookScriptPath({ id: l.hooks[0].id }), script);
    assert.strictEqual(s.cfg.hookScriptPath({ id: l.hooks[1].id }), null);
    assert.strictEqual(s.cfg.hookScriptPath({ id: 'nope' }), null);
    s.cfg.hookDisable({ id: l.hooks[0].id, settingsRev: l.settingsRev });
    l = s.cfg.list();
    assert.strictEqual(s.cfg.hookScriptPath({ id: l.disabled[0].id }), script);
  } finally { s.cleanup(); }
});

test('createClaudeConfig: root and userData required; no confirm means refuse', async () => {
  assert.throws(() => createClaudeConfig({ root: '', userData: 'x' }));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfg-test-'));
  try {
    const cfg = createClaudeConfig({ root: path.join(base, '.claude'), userData: path.join(base, 'ud') });
    const r = await cfg.hookAdd({ event: 'Stop', command: 'x', settingsRev: null });
    assert.strictEqual(r.canceled, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------
// review fixes
// ---------------------------------------------------------------------------------

const UNSAFE_SAMPLES = ['\r', '\n', '\t', '\u0007', '\u001b', '\u0085', '\u009b', '\u202E', '\u202A', '\u2066', '\u2069',
  '\u200E', '\u200F', '\u061C', '\u200B', '\u200C', '\u200D', '\uFEFF', '\u2060', '\u2028'];

test('hookAdd / hookUpdate: control, bidi and zero-width chars rejected in command and matcher; 2000 cap', async () => {
  const s = sandbox({ settings: BASE_SETTINGS });
  try {
    const rev = s.cfg.list().settingsRev;
    for (const ch of UNSAFE_SAMPLES) {
      const cmd = 'node safe.js' + ch + ' rm -rf x';
      assert.strictEqual((await s.cfg.hookAdd({ event: 'Stop', command: cmd, settingsRev: rev })).error, 'Kommandot innehåller otillåtna tecken', JSON.stringify(ch));
      assert.strictEqual((await s.cfg.hookAdd({ event: 'Stop', matcher: 'Ba' + ch + 'sh', command: 'x', settingsRev: rev })).error, 'Matchern innehåller otillåtna tecken', JSON.stringify(ch));
    }
    assert.strictEqual((await s.cfg.hookAdd({ event: 'St\u202Eop', command: 'x', settingsRev: rev })).error, 'invalid event');
    assert.strictEqual((await s.cfg.hookAdd({ event: 'Stop', command: 'x'.repeat(2001), settingsRev: rev })).error, 'invalid command');
    assert.strictEqual((await s.cfg.hookAdd({ event: 'Stop', command: 'x'.repeat(2000), settingsRev: rev })).ok, true);
    const l = s.cfg.list();
    const id = l.hooks.find((h) => h.command === 'node stop.js').id;
    assert.strictEqual((await s.cfg.hookUpdate({ id, command: 'a\u202Eb', settingsRev: l.settingsRev })).error, 'Kommandot innehåller otillåtna tecken');
    assert.strictEqual((await s.cfg.hookUpdate({ id, matcher: 'a\u200Bb', settingsRev: l.settingsRev })).error, 'Matchern innehåller otillåtna tecken');
    assert.strictEqual(s.asked.length, 1, 'only the one valid add reached the confirm');
  } finally { s.cleanup(); }
});

test('quoteForDisplay: JSON-quoted, invisible / bidi chars escaped', () => {
  assert.strictEqual(quoteForDisplay('node "a b".js'), '"node \\"a b\\".js"');
  assert.strictEqual(quoteForDisplay('a\nb'), '"a\\nb"');
  assert.strictEqual(quoteForDisplay('a\u202Eb\u200Bc\u0085d\u2028'), '"a\\u202Eb\\u200Bc\\u0085d\\u2028"');
  assert.strictEqual(quoteForDisplay(null), '""');
});

function writeStore(s, entries) {
  fs.mkdirSync(s.userData, { recursive: true });
  fs.writeFileSync(path.join(s.userData, 'claude-disabled-hooks.json'), typeof entries === 'string' ? entries : JSON.stringify(entries));
}

test('hookEnable: refuses store entries with unsafe content before the confirm (fix 1)', async () => {
  const s = sandbox({ settings: { hooks: {} } });
  try {
    const bad = [
      { id: 'c1', event: 'Stop', matcher: '', hook: { type: 'command', command: 'echo ok\u202E' } },
      { id: 'c2', event: 'Stop', matcher: '', hook: { type: 'command', command: 'echo ok\r\nrm -rf /' } },
      { id: 'c3', event: 'Stop', matcher: 'Ba\u200Bsh', hook: { type: 'command', command: 'x' } },
      { id: 'c4', event: 'St op', matcher: '', hook: { type: 'command', command: 'x' } },
      { id: 'c5', event: 'Stop', matcher: '', hook: { type: 'command', command: 'x'.repeat(2001) } },
      { id: 'c6', event: 'Stop', matcher: '', hook: { type: 'command', command: '' } }
    ];
    writeStore(s, bad);
    const rev = s.cfg.list().settingsRev;
    for (const e of bad) {
      const r = await s.cfg.hookEnable({ disabledId: e.id, settingsRev: rev });
      assert.strictEqual(r.ok, false, e.id);
      assert.ok(!r.conflict && !r.canceled, e.id);
    }
    assert.deepStrictEqual(s.asked, []);
    assert.deepStrictEqual(readSettings(s.root), { hooks: {} });
  } finally { s.cleanup(); }
});

test('hookEnable: only type command entries (fix 2)', async () => {
  const s = sandbox({ settings: { model: 'x' } });
  try {
    writeStore(s, [
      { id: 'p1', event: 'Stop', matcher: '', hook: { type: 'prompt', prompt: 'p' } },
      { id: 'p2', event: 'Stop', matcher: '', hook: { command: 'x' } }
    ]);
    const rev = s.cfg.list().settingsRev;
    for (const id of ['p1', 'p2']) {
      assert.strictEqual((await s.cfg.hookEnable({ disabledId: id, settingsRev: rev })).error, 'Bara command-hooks kan slås på här');
    }
    assert.deepStrictEqual(s.asked, []);
  } finally { s.cleanup(); }
});

test('hookUpdate: matcher-only change goes through the confirm; cancel writes nothing (fix 3)', async () => {
  const s = sandbox({ settings: BASE_SETTINGS, confirm: async () => false });
  try {
    const l = s.cfg.list();
    const r = await s.cfg.hookUpdate({ id: l.hooks[0].id, matcher: 'Bash', settingsRev: l.settingsRev });
    assert.strictEqual(r.canceled, true);
    assert.deepStrictEqual(s.asked, [{ action: 'update', event: 'Stop', matcher: 'Bash', command: 'node stop.js' }]);
    assert.deepStrictEqual(readSettings(s.root), BASE_SETTINGS);
  } finally { s.cleanup(); }
});

test('frontmatter fences with trailing whitespace are recognised (fix 4)', () => {
  const t = '--- \nname: a\nmodel: opus\n---\t\nbody';
  const fm = parseFrontmatter(t);
  assert.strictEqual(fm.hasFm, true);
  assert.strictEqual(fm.fields.model, 'opus');
  assert.strictEqual(fm.body, 'body');
  assert.strictEqual(setFrontmatterField(t, 'model', 'haiku'), '--- \nname: a\nmodel: haiku\n---\t\nbody');
  assert.strictEqual(setFrontmatterField('---  \r\nname: a\r\n---\r\n', 'model', 'x'), '---  \r\nname: a\r\nmodel: x\r\n---\r\n');
});

test('broken disabled store: list reports disabledError, disable/enable refuse and leave it (fix 5)', async () => {
  const broken = ['{ nope', '{"a":1}', JSON.stringify([{ id: 'x', event: 'Stop', hook: 'str' }]), JSON.stringify([{ id: 'x', event: 'Stop', matcher: 5, hook: {} }])];
  for (const content of broken) {
    const s = sandbox({ settings: BASE_SETTINGS });
    try {
      writeStore(s, content);
      const l = s.cfg.list();
      assert.strictEqual(l.disabledError, 'claude-disabled-hooks.json är trasig — rätta eller ta bort filen', content);
      assert.deepStrictEqual(l.disabled, []);
      assert.strictEqual(s.cfg.hookDisable({ id: l.hooks[0].id, settingsRev: l.settingsRev }).error, l.disabledError);
      assert.strictEqual((await s.cfg.hookEnable({ disabledId: 'x', settingsRev: l.settingsRev })).error, l.disabledError);
      assert.strictEqual(fs.readFileSync(path.join(s.userData, 'claude-disabled-hooks.json'), 'utf8'), content);
      assert.deepStrictEqual(readSettings(s.root), BASE_SETTINGS);
      assert.deepStrictEqual(s.asked, []);
    } finally { s.cleanup(); }
  }
  const ok = sandbox({ settings: BASE_SETTINGS });
  try { assert.ok(!('disabledError' in ok.cfg.list())); } finally { ok.cleanup(); }
});

test('skillDelete: optional rev / linked from list; mismatch is a conflict (fix 6)', () => {
  const s = sandbox();
  try {
    const d = path.join(s.root, 'skills', 'real');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'SKILL.md'), 'v1');
    const target = path.join(s.base, 'agents-skills', 'lnk');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'L');
    fs.symlinkSync(target, path.join(s.root, 'skills', 'lnk'), 'junction');
    const { skills } = s.cfg.list();
    const real = skills.find((x) => x.id === 'real');
    const lnk = skills.find((x) => x.id === 'lnk');
    assert.strictEqual(s.cfg.skillDelete({ name: 'real', rev: real.rev, linked: true }).conflict, true);
    assert.strictEqual(s.cfg.skillDelete({ name: 'lnk', rev: lnk.rev, linked: false }).conflict, true);
    fs.writeFileSync(path.join(d, 'SKILL.md'), 'v2');
    assert.strictEqual(s.cfg.skillDelete({ name: 'real', rev: real.rev, linked: false }).conflict, true);
    assert.ok(fs.existsSync(d));
    assert.deepStrictEqual(backups(s.root), []);
    assert.deepStrictEqual(s.cfg.skillDelete({ name: 'real', rev: sha1('v2'), linked: false }), { ok: true });
    assert.deepStrictEqual(s.cfg.skillDelete({ name: 'lnk', rev: lnk.rev, linked: true }), { ok: true });
    assert.ok(fs.existsSync(path.join(target, 'SKILL.md')));
  } finally { s.cleanup(); }
});

test('countFiles skips links inside a real skill folder (fix 7)', () => {
  const s = sandbox();
  try {
    const d = path.join(s.root, 'skills', 'real');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'SKILL.md'), 'S');
    const ext = path.join(s.base, 'ext');
    fs.mkdirSync(ext);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(ext, i + '.txt'), 'x');
    fs.symlinkSync(ext, path.join(d, 'linked-dir'), 'junction');
    assert.strictEqual(s.cfg.list().skills[0].files, 1);
    // Deleting the real folder must not follow the nested junction.
    assert.deepStrictEqual(s.cfg.skillDelete({ name: 'real' }), { ok: true });
    assert.ok(!fs.existsSync(d));
    assert.strictEqual(fs.readdirSync(ext).length, 5);
    const bdir = path.join(s.root, 'backups', 'mac-code', backups(s.root)[0]);
    assert.strictEqual(fs.readFileSync(path.join(bdir, 'SKILL.md'), 'utf8'), 'S');
    assert.ok(!fs.existsSync(path.join(bdir, 'linked-dir')), 'links are recorded, not recreated');
    const manifest = JSON.parse(fs.readFileSync(path.join(bdir, '.mac-code-links.json'), 'utf8'));
    assert.strictEqual(manifest.length, 1);
    assert.strictEqual(manifest[0].path, 'linked-dir');
    assert.strictEqual(path.resolve(manifest[0].target).toLowerCase(), path.resolve(ext).toLowerCase());
  } finally { s.cleanup(); }
});
