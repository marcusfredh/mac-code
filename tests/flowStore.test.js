const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createFlowStore, skillConfirmText, diffText, writeDiffFile, hasMarker, lineDiff, resolveHint, hasAtInclude } = require('../flowStore');
const { MARKER, defaultOrchestrateFlow, compileFlow } = require('../flowCompile');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// Temp roots only — never the real ~/.claude. MAC_CODE_TEST_TMP lets a run pin them to
// a scratch folder.
const TMP = process.env.MAC_CODE_TEST_TMP || os.tmpdir();

const REAL_LIKE_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/worktree-guard.js' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/orchestrate-gate.js stop', timeout: 5 }] }],
  SubagentStop: [{ hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/orchestrate-gate.js track', timeout: 5 }] }],
  PreToolUse: [
    { matcher: 'Skill|Agent|Task|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/orchestrate-gate.js pre', timeout: 5 }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/worktree-guard.js' }] }
  ],
  PostToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/pr-poll-trigger.js' }] },
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Bash', hooks: [{ type: 'command', command: 'node C:/u/.claude/hooks/orchestrate-gate.js track', timeout: 5 }] }
  ]
};

function sandbox({ confirm = async () => true, hooks } = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  const base = fs.mkdtempSync(path.join(TMP, 'flow-test-'));
  const root = path.join(base, 'home', '.claude');
  const userData = path.join(base, 'userData');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  if (hooks) fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ model: 'opus', hooks }, null, 2));
  const asked = [];
  let confirmFn = confirm;
  const store = createFlowStore({
    root, userData,
    confirm: async (info) => { asked.push(info); return confirmFn(info); },
    now: () => new Date(2026, 9, 19, 12, 0, 0, 0)
  });
  return {
    base, root, userData, store, asked,
    setConfirm: (f) => { confirmFn = f; },
    flowPath: (s) => path.join(root, 'flows', s + '.json'),
    skillPath: (s) => path.join(root, 'skills', s, 'SKILL.md'),
    backups: () => { const d = path.join(root, 'backups', 'mac-code'); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true })
  };
}

function demo(extra = {}) {
  return Object.assign({
    v: 1, slug: 'demo', name: 'Demo', description: 'Demo flow', preamble: 'Rules.', phases: ['P'],
    nodes: [{ id: 's', kind: 'start', title: '/demo' }, { id: 'a', kind: 'step', title: 'Do it', group: 'P', instr: 'Do the thing.' }],
    edges: [{ from: 's', to: 'a' }]
  }, extra);
}

// ---------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------

test('hasMarker: only as the first non-empty line after the frontmatter (R13)', () => {
  const m = MARKER('x');
  assert.ok(hasMarker('---\nname: x\n---\n\n' + m + '\n# X\n', 'x'));
  assert.ok(hasMarker('\uFEFF---\r\nname: x\r\n---\r\n' + m + '\r\n', 'x'));
  assert.ok(!hasMarker('---\nname: x\n---\n\n# X\n' + m + '\n', 'x'), 'not first');
  assert.ok(!hasMarker(m + '\n', 'x'), 'no frontmatter');
  assert.ok(!hasMarker('---\nname: x\n---\n\n' + MARKER('y') + '\n', 'x'), 'other slug');
  assert.ok(!hasMarker('---\nname: x\n' + m + '\n', 'x'), 'unclosed fence');
});

test('lineDiff: added and removed lines with ops, exact (no approximation)', () => {
  const d = lineDiff('a\nb\nc\n', 'a\nx\nc\ny\n');
  assert.strictEqual(d.added, 2);
  assert.strictEqual(d.removed, 1);
  assert.deepStrictEqual(d.addedLines, ['x', 'y']);
  assert.deepStrictEqual(d.removedLines, ['b']);
  assert.deepStrictEqual(d.ops.map((o) => o.t + o.l), [' a', '-b', '+x', ' c', '+y']);
  assert.deepStrictEqual(lineDiff(null, 'a\nb\n').addedLines, ['a', 'b']);
  const same = lineDiff('a\r\nb\r\n', 'a\nb\n');
  assert.strictEqual(same.added + same.removed, 0);
  // Past the cap: refused, not approximated.
  const big = lineDiff('x\n'.repeat(2001), 'y\n'.repeat(2000));
  assert.deepStrictEqual(big, { tooLarge: true });
});

test('hasAtInclude: flags @path tokens anywhere, not e-mail addresses or @mentions', () => {
  for (const yes of ['Read @src/main.js first', '@~/.ssh/id_rsa', 'see @notes.md', 'x@C:/Users/a/secret.txt', 'x@C:\\Users\\a',
    'prefix@~/x', 'a@./rel', 'a@../up', '(@/etc/passwd)', 'text@/abs']) assert.ok(hasAtInclude(yes), yes);
  for (const no of ['mail a@b.com or @someone', 'ping @team now', 'no at here']) assert.ok(!hasAtInclude(no), no);
});

test('skillConfirmText: path, state, counts, both sides quoted, truncation flag, @ warning', () => {
  const added = Array.from({ length: 25 }, (_, i) => 'line ' + i);
  added[0] = 'evil \u202E txt';
  const removed = ['old \u200B one', 'old two'];
  const t = skillConfirmText({ slug: 'demo', skillPath: 'C:\\h\\.claude\\skills\\demo\\SKILL.md', skillState: 'edited', lines: 40, added: 25, removed: 2, addedLines: added, removedLines: removed, atInclude: true });
  assert.strictEqual(t.message, 'Skriv skills/demo/SKILL.md?');
  assert.strictEqual(t.button, 'Skriv över');
  assert.ok(t.detail.includes('C:\\h\\.claude\\skills\\demo\\SKILL.md'));
  assert.ok(t.detail.includes('ÄNDRAD FÖR HAND'));
  assert.ok(t.detail.includes('Rader: 40 (+25 / −2'));
  assert.ok(t.detail.includes('+ "evil \\u202E txt"'));
  assert.ok(t.detail.includes('Borttagna rader:'));
  assert.ok(t.detail.includes('− "old \\u200B one"') && t.detail.includes('− "old two"'));
  assert.ok(!/[\u202E\u200B]/.test(t.detail));
  assert.ok(t.detail.includes('"line 7"') && !t.detail.includes('"line 8"'));
  assert.ok(t.detail.includes('… och 17 till'));
  assert.ok(t.detail.indexOf('Visa alla ändringar') < t.detail.indexOf('Nya rader:'));
  assert.ok(t.detail.includes('@sökväg'));
  assert.strictEqual(t.truncated, true);
  assert.ok(t.detail.includes('Visa alla ändringar'));
  const small = skillConfirmText({ slug: 'd', skillPath: 'p', skillState: 'none', lines: 1, added: 1, removed: 0, addedLines: ['x'], removedLines: [], atInclude: false });
  assert.strictEqual(small.button, 'Skriv');
  assert.strictEqual(small.truncated, false);
  const manyRemoved = skillConfirmText({ slug: 'd', skillPath: 'p', skillState: 'foreign', lines: 1, added: 0, removed: 21, addedLines: [], removedLines: Array(21).fill('r'), atInclude: false });
  assert.ok(manyRemoved.detail.includes('INTE skapad av Mac Code'));
  assert.strictEqual(manyRemoved.truncated, true, 'removed lines count too');
});

test('diffText + writeDiffFile: every line of both sides, quoted; only the newest 5 kept', () => {
  const sb = sandbox();
  try {
    const d = lineDiff('keep\nold \u202E\n', 'keep\nnew\n');
    const text = diffText(Object.assign({ slug: 'demo', skillPath: 'P' }, d));
    assert.ok(text.includes('\n  "keep"\n'));
    assert.ok(text.includes('\n- "old \\u202E"\n'));
    assert.ok(text.includes('\n+ "new"\n'));
    assert.ok(!text.includes('\u202E'));
    const paths = [];
    for (let i = 0; i < 7; i++) {
      paths.push(writeDiffFile({ userData: sb.userData, slug: 'demo', text: 't' + i, now: () => new Date(2026, 0, 1, 0, 0, i) }));
    }
    const dir = path.join(sb.userData, 'flow-preview');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
    paths.push(writeDiffFile({ userData: sb.userData, slug: 'demo', text: 't7', now: () => new Date(2026, 0, 1, 0, 0, 7) }));
    const left = fs.readdirSync(dir).filter((x) => x !== 'unrelated.txt').sort();
    assert.strictEqual(left.length, 5);
    assert.deepStrictEqual(left, paths.slice(3).map((p) => path.basename(p)).sort());
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.txt')), 'only our own preview files are pruned');
    assert.ok(paths.every((p) => path.dirname(p) === dir && /^demo-.*\.txt$/.test(path.basename(p))));
    assert.throws(() => writeDiffFile({ userData: sb.userData, slug: '../x', text: '' }));
    assert.ok(!fs.existsSync(path.join(sb.root, 'flow-preview')), 'never under ~/.claude');
  } finally { sb.cleanup(); }
});

test('resolveHint: by script name and argument, preferring the hinted event and active hooks', () => {
  const hooks = [
    { type: 'command', event: 'SessionStart', matcher: '', command: 'node C:/h/worktree-guard.js', enabled: true },
    { type: 'command', event: 'PreToolUse', matcher: 'Bash', command: 'node C:/h/worktree-guard.js', enabled: true },
    { type: 'command', event: 'SubagentStop', matcher: '', command: 'node "C:\\h\\orchestrate-gate.js" track', enabled: true },
    { type: 'command', event: 'Stop', matcher: '', command: 'node C:/h/orchestrate-gate.js stop', enabled: false }
  ];
  assert.deepStrictEqual(resolveHint({ script: 'worktree-guard.js', arg: null, event: 'PreToolUse' }, hooks),
    { event: 'PreToolUse', matcher: 'Bash', command: 'node C:/h/worktree-guard.js' });
  assert.deepStrictEqual(resolveHint({ script: 'orchestrate-gate.js', arg: 'track', event: 'PostToolUse' }, hooks).event, 'SubagentStop');
  assert.deepStrictEqual(resolveHint({ script: 'orchestrate-gate.js', arg: 'stop', event: 'Stop' }, hooks).event, 'Stop');
  assert.strictEqual(resolveHint({ script: 'orchestrate-gate.js', arg: 'pre', event: 'PreToolUse' }, hooks), null);
  assert.strictEqual(resolveHint({ script: 'guard.js', arg: null, event: 'PreToolUse' }, hooks), null, 'whole file name only');
});

// ---------------------------------------------------------------------------------
// get / list (the built-in default is never written implicitly)
// ---------------------------------------------------------------------------------

test('flowGet: orchestrate without a file returns the default with resolved hooks, writes nothing', () => {
  const sb = sandbox({ hooks: REAL_LIKE_HOOKS });
  try {
    const r = sb.store.flowGet({ slug: 'orchestrate' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.isDefault, true);
    assert.strictEqual(r.rev, null);
    const byId = Object.fromEntries(r.flow.nodes.map((n) => [n.id, n]));
    assert.deepStrictEqual(byId.be.hooks, [
      { event: 'PreToolUse', matcher: 'Bash', command: 'node C:/u/.claude/hooks/worktree-guard.js' },
      { event: 'PreToolUse', matcher: 'Skill|Agent|Task|Edit|Write|MultiEdit|NotebookEdit', command: 'node C:/u/.claude/hooks/orchestrate-gate.js pre' }
    ]);
    assert.deepStrictEqual(byId.self.hooks, byId.be.hooks);
    assert.deepStrictEqual(byId.fe.hooks, byId.be.hooks);
    assert.deepStrictEqual(byId.skdiff.hooks, [{ event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Bash', command: 'node C:/u/.claude/hooks/orchestrate-gate.js track' }]);
    assert.deepStrictEqual(byId.report.hooks, [{ event: 'Stop', matcher: '', command: 'node C:/u/.claude/hooks/orchestrate-gate.js stop' }]);
    assert.ok(!fs.existsSync(path.join(sb.root, 'flows')), 'nothing written');
    assert.deepStrictEqual(sb.backups(), []);
    const l = sb.store.flowList();
    assert.deepStrictEqual(l, { ok: true, flows: [], hasOrchestrateFile: false });
  } finally { sb.cleanup(); }
});

test('flowGet: no settings.json → default without hooks; unknown slug → notFound', () => {
  const sb = sandbox();
  try {
    const r = sb.store.flowGet({ slug: 'orchestrate' });
    assert.ok(r.flow.nodes.every((n) => n.hooks.length === 0));
    assert.strictEqual(sb.store.flowGet({ slug: 'nope' }).notFound, true);
    assert.strictEqual(sb.store.flowGet({ slug: '../x' }).ok, false);
    assert.strictEqual(sb.store.flowGet({}).ok, false);
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------------------------
// save / conflicts / backups
// ---------------------------------------------------------------------------------

test('flowSave: create, update with rev, conflicts, slug forced, generated ignored', () => {
  const sb = sandbox();
  try {
    const c = sb.store.flowSave({ slug: 'demo', flow: demo({ slug: 'other', generated: { sha1: 'a'.repeat(40), at: 'x' } }), rev: null });
    assert.ok(c.ok, c.error);
    const raw = fs.readFileSync(sb.flowPath('demo'));
    assert.strictEqual(c.rev, sha1(raw));
    const onDisk = JSON.parse(raw);
    assert.strictEqual(onDisk.slug, 'demo', 'R15');
    assert.strictEqual(onDisk.generated, null, 'R5');

    const again = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.conflict, true);
    assert.strictEqual(again.exists, true);

    const u = sb.store.flowSave({ slug: 'demo', flow: demo({ name: 'Demo 2' }), rev: c.rev });
    assert.ok(u.ok);
    assert.notStrictEqual(u.rev, c.rev);
    assert.strictEqual(sb.store.flowSave({ slug: 'demo', flow: demo(), rev: c.rev }).conflict, true, 'stale rev');

    // External edit → conflict
    fs.writeFileSync(sb.flowPath('demo'), fs.readFileSync(sb.flowPath('demo'), 'utf8') + ' ');
    assert.strictEqual(sb.store.flowSave({ slug: 'demo', flow: demo(), rev: u.rev }).conflict, true);

    const g = sb.store.flowGet({ slug: 'demo' });
    assert.ok(g.ok);
    assert.strictEqual(g.flow.name, 'Demo 2');
    assert.strictEqual(g.rev, sha1(fs.readFileSync(sb.flowPath('demo'))));
    assert.strictEqual(g.skillState, 'none');
    assert.strictEqual(g.paths.flow, sb.flowPath('demo'));
  } finally { sb.cleanup(); }
});

test('flowSave: validation errors come back as { ok:false, error, invalid:true } and write nothing', () => {
  const sb = sandbox();
  try {
    const r = sb.store.flowSave({ slug: 'demo', flow: demo({ preamble: 'x !`rm -rf /`' }), rev: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.invalid, true);
    assert.match(r.error, /!`/);
    assert.ok(!fs.existsSync(sb.flowPath('demo')));
    assert.strictEqual(sb.store.flowSave({ slug: 'demo', flow: 'nope', rev: null }).invalid, true);
    assert.strictEqual(sb.store.flowSave({ slug: 'Bad', flow: demo(), rev: null }).invalid, true);
  } finally { sb.cleanup(); }
});

test('flowSave: backs up only the first overwrite per flow per session (R6)', () => {
  const sb = sandbox();
  try {
    let rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    assert.deepStrictEqual(sb.backups(), [], 'create has nothing to back up');
    for (let i = 0; i < 3; i++) rev = sb.store.flowSave({ slug: 'demo', flow: demo({ name: 'n' + i }), rev }).rev;
    const b = sb.backups();
    assert.strictEqual(b.length, 1);
    assert.match(b[0], /flow-demo\.json$/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sb.root, 'backups', 'mac-code', b[0]), 'utf8')).name, 'Demo');
  } finally { sb.cleanup(); }
});

test('flowSave: create refused when skills/<slug> exists and was not made by Mac Code', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.join(sb.root, 'skills', 'demo'));
    fs.writeFileSync(sb.skillPath('demo'), '---\nname: demo\n---\n\n# hand written\n');
    const r = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exists, true);
    assert.ok(!fs.existsSync(sb.flowPath('demo')));
    // The built-in orchestrate flow may be created over the hand-written skill.
    fs.mkdirSync(path.join(sb.root, 'skills', 'orchestrate'));
    fs.writeFileSync(sb.skillPath('orchestrate'), '---\nname: orchestrate\n---\n\n# hand written\n');
    const o = sb.store.flowSave({ slug: 'orchestrate', flow: sb.store.flowGet({ slug: 'orchestrate' }).flow, rev: null });
    assert.ok(o.ok, o.error);
    assert.strictEqual(fs.readFileSync(sb.skillPath('orchestrate'), 'utf8'), '---\nname: orchestrate\n---\n\n# hand written\n', 'SKILL.md untouched');
    assert.strictEqual(sb.store.flowList().hasOrchestrateFile, true);
  } finally { sb.cleanup(); }
});

test('flowDelete: rev-checked, backs up, leaves the skill', () => {
  const sb = sandbox();
  try {
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    fs.mkdirSync(path.join(sb.root, 'skills', 'demo'));
    fs.writeFileSync(sb.skillPath('demo'), 'skill');
    assert.strictEqual(sb.store.flowDelete({ slug: 'demo', rev: 'x' }).conflict, true);
    assert.ok(sb.store.flowDelete({ slug: 'demo', rev }).ok);
    assert.ok(!fs.existsSync(sb.flowPath('demo')));
    assert.strictEqual(fs.readFileSync(sb.skillPath('demo'), 'utf8'), 'skill');
    assert.ok(sb.backups().some((b) => /flow-demo\.json$/.test(b)));
    assert.strictEqual(sb.store.flowDelete({ slug: 'demo', rev }).conflict, true);
  } finally { sb.cleanup(); }
});

test('flowList: entries with skill states, broken files reported', () => {
  const sb = sandbox();
  try {
    for (const s of ['a1', 'b2', 'c3', 'd4']) sb.store.flowSave({ slug: s, flow: demo({ slug: s }), rev: null });
    fs.writeFileSync(path.join(sb.root, 'flows', 'broken.json'), '{nope');
    fs.writeFileSync(path.join(sb.root, 'flows', 'Bad Name.json'), '{}');
    fs.writeFileSync(path.join(sb.root, 'flows', 'notes.txt'), 'x');
    // b2: hand-written skill
    fs.mkdirSync(path.join(sb.root, 'skills', 'b2'));
    fs.writeFileSync(sb.skillPath('b2'), '# mine\n');
    const l0 = sb.store.flowList();
    assert.deepStrictEqual(l0.flows.map((f) => f.slug), ['a1', 'b2', 'broken', 'c3', 'd4']);
    const by = Object.fromEntries(l0.flows.map((f) => [f.slug, f]));
    assert.strictEqual(by.a1.skillState, 'none');
    assert.strictEqual(by.a1.nodes, 2);
    assert.strictEqual(by.a1.name, 'Demo');
    assert.strictEqual(by.b2.skillState, 'foreign');
    assert.ok(by.broken.error);
    assert.strictEqual(by.a1.rev, sha1(fs.readFileSync(sb.flowPath('a1'))));
    assert.strictEqual(l0.hasOrchestrateFile, false);
  } finally { sb.cleanup(); }
});

// ---------------------------------------------------------------------------------
// preview / writeSkill
// ---------------------------------------------------------------------------------

test('flowPreview: compiles the saved file; default orchestrate when there is none', () => {
  const sb = sandbox();
  try {
    const d = sb.store.flowPreview({ slug: 'orchestrate' });
    assert.ok(d.ok, d.error);
    assert.strictEqual(d.isDefault, true);
    assert.strictEqual(d.markdown, compileFlow(defaultOrchestrateFlow()));
    assert.strictEqual(d.skillState, 'none');
    assert.ok(!fs.existsSync(path.join(sb.root, 'flows')));
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    const p = sb.store.flowPreview({ slug: 'demo' });
    assert.ok(p.ok);
    assert.strictEqual(p.rev, rev);
    assert.strictEqual(p.skillPath, sb.skillPath('demo'));
    assert.strictEqual(p.lines, p.markdown.split('\n').length - 1);
    assert.strictEqual(p.added, p.lines);
    assert.ok(!fs.existsSync(sb.skillPath('demo')), 'preview never writes');
    assert.strictEqual(sb.store.flowPreview({ slug: 'none' }).notFound, true);
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: canceled → nothing written', async () => {
  const sb = sandbox({ confirm: async () => false });
  try {
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev });
    assert.deepStrictEqual(r, { ok: false, error: 'canceled', canceled: true });
    assert.strictEqual(sb.asked.length, 1);
    assert.ok(!fs.existsSync(path.join(sb.root, 'skills', 'demo')));
    assert.strictEqual(sha1(fs.readFileSync(sb.flowPath('demo'))), rev, 'flow untouched');
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: writes SKILL.md with marker, records generated, then detects hand edits', async () => {
  const sb = sandbox();
  try {
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev });
    assert.ok(r.ok, r.error);
    const md = fs.readFileSync(sb.skillPath('demo'), 'utf8');
    assert.strictEqual(md, compileFlow(demo()));
    assert.ok(hasMarker(md, 'demo'));
    assert.strictEqual(r.sha1, sha1(md));
    const flowRaw = fs.readFileSync(sb.flowPath('demo'));
    assert.strictEqual(r.rev, sha1(flowRaw));
    const f = JSON.parse(flowRaw);
    assert.deepStrictEqual(f.generated, { sha1: r.sha1, at: r.at });
    assert.strictEqual(f.name, 'Demo', 'rest of the flow kept');
    const info = sb.asked[0];
    assert.strictEqual(info.skillState, 'none');
    assert.strictEqual(info.skillPath, sb.skillPath('demo'));
    assert.strictEqual(info.lines, md.split('\n').length - 1);
    assert.strictEqual(sb.store.flowList().flows[0].skillState, 'generated');
    assert.strictEqual(sb.store.flowGet({ slug: 'demo' }).flow.generated.sha1, r.sha1);

    // a later autosave keeps `generated` even though the renderer sends another value
    const s2 = sb.store.flowSave({ slug: 'demo', flow: demo({ name: 'Demo 2', generated: null }), rev: r.rev });
    assert.ok(s2.ok);
    assert.strictEqual(JSON.parse(fs.readFileSync(sb.flowPath('demo'))).generated.sha1, r.sha1);

    // hand edit → edited; writing again backs up first and reports the state
    fs.appendFileSync(sb.skillPath('demo'), '\nmy note\n');
    assert.strictEqual(sb.store.flowPreview({ slug: 'demo' }).skillState, 'edited');
    const before = sb.backups().length;
    const w2 = await sb.store.flowWriteSkill({ slug: 'demo', rev: s2.rev });
    assert.ok(w2.ok, w2.error);
    assert.strictEqual(sb.asked[1].skillState, 'edited');
    assert.ok(sb.asked[1].removed >= 1);
    const bk = sb.backups().slice(before);
    assert.ok(bk.some((b) => /skill-demo-SKILL\.md$/.test(b)));
    assert.ok(!fs.readFileSync(sb.skillPath('demo'), 'utf8').includes('my note'));
    assert.strictEqual(sb.store.flowList().flows[0].skillState, 'generated');
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: foreign SKILL.md is backed up and overwritten only after confirm', async () => {
  const sb = sandbox();
  try {
    const rev = sb.store.flowSave({ slug: 'orchestrate', flow: defaultOrchestrateFlow(), rev: null }).rev;
    fs.mkdirSync(path.join(sb.root, 'skills', 'orchestrate'));
    fs.writeFileSync(sb.skillPath('orchestrate'), '---\nname: orchestrate\n---\n\n# Hand written\n');
    const r = await sb.store.flowWriteSkill({ slug: 'orchestrate', rev });
    assert.ok(r.ok, r.error);
    assert.strictEqual(sb.asked[0].skillState, 'foreign');
    const bk = sb.backups().find((b) => /skill-orchestrate-SKILL\.md$/.test(b));
    assert.ok(bk);
    assert.strictEqual(fs.readFileSync(path.join(sb.root, 'backups', 'mac-code', bk), 'utf8'), '---\nname: orchestrate\n---\n\n# Hand written\n');
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: flow changed while the dialog was open → conflict, SKILL.md not written', async () => {
  const sb = sandbox();
  try {
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    sb.setConfirm(async () => { fs.appendFileSync(sb.flowPath('demo'), ' '); return true; });
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.conflict, true);
    assert.ok(!fs.existsSync(sb.skillPath('demo')));
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: SKILL.md changed while the dialog was open → abort', async () => {
  const sb = sandbox();
  try {
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    sb.setConfirm(async () => {
      fs.mkdirSync(path.join(sb.root, 'skills', 'demo'));
      fs.writeFileSync(sb.skillPath('demo'), 'sneaky');
      return true;
    });
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev });
    assert.strictEqual(r.conflict, true);
    assert.strictEqual(fs.readFileSync(sb.skillPath('demo'), 'utf8'), 'sneaky');
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: stale rev, unsaved flow, missing description', async () => {
  const sb = sandbox();
  try {
    assert.strictEqual((await sb.store.flowWriteSkill({ slug: 'orchestrate', rev: null })).ok, false, 'default not saved yet');
    assert.strictEqual((await sb.store.flowWriteSkill({ slug: 'demo', rev: 'x' })).conflict, true);
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).rev;
    assert.strictEqual((await sb.store.flowWriteSkill({ slug: 'demo', rev: 'abc' })).conflict, true);
    const rev2 = sb.store.flowSave({ slug: 'demo', flow: demo({ description: '' }), rev }).rev;
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev: rev2 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Beskrivning/);
    assert.strictEqual(sb.asked.length, 0, 'no dialog for a refused write');
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: refuses to write through a junctioned skill folder (R12)', { skip: process.platform !== 'win32' && 'junctions are Windows-only' }, async () => {
  const sb = sandbox();
  try {
    const target = path.join(sb.base, 'other-store', 'demo');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'theirs');
    const link = path.join(sb.root, 'skills', 'demo');
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'node sees the junction as a link');
    const rev = sb.store.flowSave({ slug: 'demo2', flow: demo({ slug: 'demo2' }), rev: null }).rev;
    assert.ok(rev);
    // A flow can't be created over a linked skill...
    assert.strictEqual(sb.store.flowSave({ slug: 'demo', flow: demo(), rev: null }).exists, true);
    // ...and a flow file that exists anyway is never written through the link.
    fs.writeFileSync(sb.flowPath('demo'), JSON.stringify(demo(), null, 2));
    const frev = sha1(fs.readFileSync(sb.flowPath('demo')));
    assert.strictEqual(sb.store.flowList().flows.find((f) => f.slug === 'demo').skillState, 'linked');
    const p = sb.store.flowPreview({ slug: 'demo' });
    assert.strictEqual(p.skillState, 'linked');
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev: frev });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.linked, true);
    assert.match(r.error, /Skillen är länkad till .* — skriv inte där/);
    assert.strictEqual(sb.asked.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'theirs');
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: refuses a symlinked SKILL.md file (R12)', async (t) => {
  const sb = sandbox();
  try {
    const target = path.join(sb.base, 'elsewhere.md');
    fs.writeFileSync(target, 'theirs');
    fs.mkdirSync(path.join(sb.root, 'skills', 'demo'));
    try { fs.symlinkSync(target, sb.skillPath('demo'), 'file'); } catch (err) {
      t.skip('file symlinks need privileges here (' + err.code + ')');
      return;
    }
    fs.mkdirSync(path.join(sb.root, 'flows'), { recursive: true });
    fs.writeFileSync(sb.flowPath('demo'), JSON.stringify(demo()));
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev: sha1(fs.readFileSync(sb.flowPath('demo'))) });
    assert.strictEqual(r.linked, true);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs');
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: a change too large to show in full is refused, not approximated', async () => {
  const sb = sandbox();
  try {
    // ~13000 new lines against 400 old ones → past the line-pair cap.
    const rev = sb.store.flowSave({ slug: 'demo', flow: demo({ preamble: 'a\n'.repeat(13000) + 'b' }), rev: null }).rev;
    assert.ok(rev);
    fs.mkdirSync(path.join(sb.root, 'skills', 'demo'));
    fs.writeFileSync(sb.skillPath('demo'), 'old\n'.repeat(400));
    const r = await sb.store.flowWriteSkill({ slug: 'demo', rev });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.tooLarge, true);
    assert.strictEqual(r.error, 'Ändringen är för stor för att visas — dela upp flödet');
    assert.strictEqual(sb.asked.length, 0, 'no dialog');
    assert.strictEqual(fs.readFileSync(sb.skillPath('demo'), 'utf8'), 'old\n'.repeat(400));
    const p = sb.store.flowPreview({ slug: 'demo' });
    assert.ok(p.ok);
    assert.strictEqual(p.tooLarge, true);
    assert.strictEqual(p.added, null);
  } finally { sb.cleanup(); }
});

test('flowWriteSkill: the confirm gets both sides of the diff; a first write counts every line as added', async () => {
  const sb = sandbox();
  try {
    const rev = sb.store.flowSave({ slug: 'orchestrate', flow: defaultOrchestrateFlow(), rev: null }).rev;
    const r = await sb.store.flowWriteSkill({ slug: 'orchestrate', rev });
    assert.ok(r.ok, r.error);
    const info = sb.asked[0];
    assert.strictEqual(info.skillState, 'none');
    assert.strictEqual(info.added, info.lines);
    assert.deepStrictEqual(info.removedLines, []);
    assert.strictEqual(info.ops.length, info.lines);
    assert.strictEqual(skillConfirmText(info).truncated, true, 'a ~150-line file offers "Visa alla ändringar"');
    fs.appendFileSync(sb.skillPath('orchestrate'), 'hand 1\nhand 2\n');
    await sb.store.flowWriteSkill({ slug: 'orchestrate', rev: r.rev });
    assert.deepStrictEqual(sb.asked[1].removedLines, ['hand 1', 'hand 2']);
    assert.strictEqual(sb.asked[1].added, 0);
  } finally { sb.cleanup(); }
});

test('skillConfirmText: a very long line is cut and offers the full diff', () => {
  const { skillConfirmText } = require('../flowStore');
  const long = 'x'.repeat(5000);
  const t = skillConfirmText({ slug: 'demo', skillState: 'generated', lines: 3, added: 1, removed: 0, addedLines: [long], removedLines: [] });
  assert.ok(t.truncated);
  assert.ok(t.detail.length < 2000);
  assert.ok(t.detail.includes('…'));
});
