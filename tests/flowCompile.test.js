const test = require('node:test');
const assert = require('node:assert');
const {
  KINDS, CAPS, MARKER, slugOk, slugFromName, validateFlow, compileFlow, defaultOrchestrateFlow,
  DEFAULT_HOOK_HINTS, unreachable, hookLabel, execError
} = require('../flowCompile');

function mini(extra = {}) {
  return Object.assign({
    v: 1, slug: 'demo', name: 'Demo', description: 'A demo flow', preamble: 'Rules.',
    phases: ['Fas 1'],
    nodes: [
      { id: 's', kind: 'start', title: '/demo' },
      { id: 'a', kind: 'agent', title: 'Review', agent: 'skeptic', group: 'Fas 1' }
    ],
    edges: [{ from: 's', to: 'a' }]
  }, extra);
}

// ---------------------------------------------------------------------------------
// slugs
// ---------------------------------------------------------------------------------

test('slugOk: lowercase slugs only, no reserved names', () => {
  for (const ok of ['a', 'orchestrate', 'my-flow-2', 'x'.repeat(64)]) assert.ok(slugOk(ok), ok);
  for (const bad of ['', 'A', 'My', '-a', 'a_b', 'a b', '../x', 'x'.repeat(65), 'con', 'nul', 'com1', null, 7]) assert.ok(!slugOk(bad), String(bad));
});

test('slugFromName: å/ä/ö, accents, separators', () => {
  assert.strictEqual(slugFromName('Mitt Flöde!'), 'mitt-flode');
  assert.strictEqual(slugFromName('Ändra  Åtgärd'), 'andra-atgard');
  assert.strictEqual(slugFromName('  Café / Bugfix  '), 'cafe-bugfix');
  assert.strictEqual(slugFromName('---'), '');
  assert.strictEqual(slugFromName('CON'), '');
  assert.strictEqual(slugFromName('a'.repeat(80)).length, 64);
});

// ---------------------------------------------------------------------------------
// validateFlow
// ---------------------------------------------------------------------------------

test('validateFlow: normalises a minimal flow and drops unknown keys', () => {
  const r = validateFlow(Object.assign(mini(), { evil: 1, nodes: mini().nodes.map((n) => Object.assign({ extra: 'x' }, n)) }));
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(Object.keys(r.flow).sort(), ['description', 'edges', 'generated', 'name', 'nodes', 'phases', 'pos', 'preamble', 'slug', 'v']);
  assert.deepStrictEqual(Object.keys(r.flow.nodes[0]).sort(), ['agent', 'group', 'hooks', 'id', 'instr', 'kind', 'model', 'rounds', 'sub', 'title']);
  assert.strictEqual(r.flow.generated, null);
});

test('validateFlow: kinds, ids, duplicates, start count, edges', () => {
  assert.deepStrictEqual(KINDS, ['start', 'agent', 'step', 'check', 'ask']);
  const bad = (f, re) => { const r = validateFlow(f); assert.ok(!r.ok, 'expected failure'); if (re) assert.match(r.error, re); };
  bad(Object.assign(mini(), { nodes: [{ id: 's', kind: 'start' }, { id: 'x', kind: 'script' }] }), /stegtyp/);
  bad(Object.assign(mini(), { nodes: [{ id: 's', kind: 'start' }, { id: 'a b', kind: 'step' }] }), /id/);
  bad(Object.assign(mini(), { nodes: [{ id: 's', kind: 'start' }, { id: 'x'.repeat(41), kind: 'step' }] }), /id/);
  bad(Object.assign(mini(), { nodes: [{ id: 's', kind: 'start' }, { id: 's', kind: 'step' }] }), /Dubblett/);
  bad(Object.assign(mini(), { nodes: [{ id: 'a', kind: 'step' }], edges: [] }), /exakt ett startsteg/);
  bad(Object.assign(mini(), { nodes: [{ id: 's', kind: 'start' }, { id: 't', kind: 'start' }], edges: [] }), /exakt ett startsteg/);
  bad(Object.assign(mini(), { edges: [{ from: 's', to: 'nope' }] }), /inte finns/);
  bad(Object.assign(mini(), { slug: 'Bad Slug' }), /slug/);
  bad(Object.assign(mini(), { v: 2 }));
  bad(null);
  bad([]);
});

test('validateFlow: caps on nodes, edges, phases and text', () => {
  const nodes = [{ id: 's', kind: 'start' }];
  for (let i = 0; i < CAPS.nodes; i++) nodes.push({ id: 'n' + i, kind: 'step' });
  assert.ok(!validateFlow(Object.assign(mini(), { nodes, edges: [] })).ok);
  assert.ok(validateFlow(Object.assign(mini(), { nodes: nodes.slice(0, CAPS.nodes), edges: [] })).ok);
  const edges = [];
  for (let i = 0; i <= CAPS.edges; i++) edges.push({ from: 's', to: 'a' });
  assert.ok(!validateFlow(Object.assign(mini(), { edges })).ok);
  const phases = [];
  for (let i = 0; i <= CAPS.phases; i++) phases.push('P' + i);
  assert.ok(!validateFlow(Object.assign(mini(), { phases })).ok);
  assert.ok(validateFlow(Object.assign(mini(), { preamble: 'x'.repeat(40000) })).ok);
  assert.ok(!validateFlow(Object.assign(mini(), { preamble: 'x'.repeat(40001) })).ok);
  assert.ok(!validateFlow(Object.assign(mini(), { name: 'x'.repeat(4001) })).ok);
  assert.ok(!validateFlow(Object.assign(mini(), { description: 'x'.repeat(1025) })).ok);
  const longInstr = mini(); longInstr.nodes[1].instr = 'x'.repeat(4001);
  assert.ok(!validateFlow(longInstr).ok);
});

test('validateFlow: numbers must be finite; rounds whole 0-10; pos of unknown ids dropped', () => {
  assert.ok(!validateFlow(Object.assign(mini(), { pos: { a: { x: NaN, y: 0 } } })).ok);
  assert.ok(!validateFlow(Object.assign(mini(), { pos: { a: { x: Infinity, y: 0 } } })).ok);
  assert.ok(!validateFlow(Object.assign(mini(), { pos: { a: { x: '1', y: 0 } } })).ok);
  const r = validateFlow(Object.assign(mini(), { pos: { a: { x: 1.5, y: -2 }, gone: { x: 1, y: 1 } } }));
  assert.deepStrictEqual(r.flow.pos, { a: { x: 1.5, y: -2 } });
  for (const bad of [-1, 11, 1.5, '2', NaN]) {
    const f = mini(); f.nodes[1].rounds = bad;
    assert.ok(!validateFlow(f).ok, String(bad));
  }
  const f = mini(); f.nodes[1].rounds = 2;
  assert.strictEqual(validateFlow(f).flow.nodes[1].rounds, 2);
});

test('validateFlow: refuses !` anywhere (R7), with the exact message', () => {
  const msg = 'Texten får inte innehålla !` (kör kommandon när skillen laddas)';
  const cases = [
    Object.assign(mini(), { preamble: 'run !`rm -rf ~`' }),
    Object.assign(mini(), { name: 'x!`y' }),
    Object.assign(mini(), { description: '!`id`' }),
    Object.assign(mini(), { phases: ['!`p`'] })
  ];
  const n = mini(); n.nodes[1].instr = 'line\n!`curl x`'; cases.push(n);
  const t = mini(); t.nodes[1].title = 'T!`'; cases.push(t);
  const e = mini(); e.edges[0].label = 'ja !`x`'; cases.push(e);
  const h = mini(); h.nodes[1].hooks = [{ event: 'Stop', matcher: '', command: 'node x.js !`y`' }]; cases.push(h);
  for (const c of cases) {
    const r = validateFlow(c);
    assert.ok(!r.ok);
    assert.strictEqual(r.error, msg);
  }
});

test('validateFlow: refuses ```! / ~~~! fenced pre-execution blocks in multi-line fields', () => {
  const msg = 'Texten får inte innehålla ```! eller !` (kör kommandon när skillen laddas)';
  const bad = ['```!\nrm -rf ~\n```', 'intro\n  ```` !\nls\n````', 'x\n~~~!\nid\n~~~', '\t~~~~  !bash\nid',
    '> ```!\nid\n```', '- ```!', '1. ```!', 'a ```! inline', ' ```!', ' ```!', 'run ```!id``` now'];
  for (const text of bad) {
    const p = validateFlow(Object.assign(mini(), { preamble: text }));
    assert.ok(!p.ok, text);
    assert.strictEqual(p.error, msg);
    const n = mini(); n.nodes[1].instr = text;
    assert.strictEqual(validateFlow(n).error, msg, text);
  }
  // Ordinary fences, a ! after the info word, or a ! on the next line stay allowed. A fence
  // followed by ! is refused anywhere (quotes, lists, mid-line, unicode spaces).
  for (const ok of ['```\nCLASS: x\n```', '```bash !\nls\n```', '```\n! not a fence\n```', 'a ``` b !']) {
    assert.ok(validateFlow(Object.assign(mini(), { preamble: ok })).ok, ok);
  }
});

test('execError: checks a whole compiled SKILL.md', () => {
  assert.strictEqual(execError(compileFlow(defaultOrchestrateFlow())), null);
  assert.match(execError('# x\n\n```!\nls\n```\n'), /```!/);
  assert.match(execError('a\n~~~!\n'), /```!/);
  assert.match(execError('see !`id`'), /!`/);
});

test('validateFlow: invisible / bidi / control characters are refused; CR/LF stripped in single-line fields', () => {
  for (const ch of ['\u202E', '\u200B', '\u2066', '\uFEFF', '\u0007', '\u2028', '\u061C']) {
    assert.ok(!validateFlow(Object.assign(mini(), { name: 'a' + ch + 'b' })).ok, ch.charCodeAt(0).toString(16));
    assert.ok(!validateFlow(Object.assign(mini(), { preamble: 'a' + ch + 'b' })).ok, ch.charCodeAt(0).toString(16));
  }
  const r = validateFlow(Object.assign(mini(), { name: 'Two\r\nlines\t---', preamble: 'a\r\n\tb\rc\n' }));
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.flow.name, 'Two lines ---');
  assert.strictEqual(r.flow.preamble, 'a\n\tb\nc');
});

test('validateFlow: groups not in phases are appended; hooks are trimmed and de-duplicated', () => {
  const f = mini();
  f.nodes[1].group = 'Ny';
  f.nodes[1].hooks = [
    { event: 'Stop', matcher: ' ', command: ' node a.js ' },
    { event: 'Stop', matcher: '', command: 'node a.js' }
  ];
  const r = validateFlow(f);
  assert.deepStrictEqual(r.flow.phases, ['Fas 1', 'Ny']);
  assert.deepStrictEqual(r.flow.nodes[1].hooks, [{ event: 'Stop', matcher: '', command: 'node a.js' }]);
  const b = mini(); b.nodes[1].hooks = [{ event: 'Bad Event', command: 'x' }];
  assert.ok(!validateFlow(b).ok);
  const c = mini(); c.nodes[1].hooks = [{ event: 'Stop', command: '' }];
  assert.ok(!validateFlow(c).ok);
});

test('validateFlow: generated kept only when well-formed', () => {
  const sha = 'a'.repeat(40);
  assert.deepStrictEqual(validateFlow(Object.assign(mini(), { generated: { sha1: sha, at: '2026-10-19T10:00:00.000Z' } })).flow.generated, { sha1: sha, at: '2026-10-19T10:00:00.000Z' });
  assert.strictEqual(validateFlow(Object.assign(mini(), { generated: { sha1: 'nope' } })).flow.generated, null);
});

// ---------------------------------------------------------------------------------
// compileFlow
// ---------------------------------------------------------------------------------

test('compileFlow: frontmatter, marker, heading, preamble, steps (exact output)', () => {
  const f = mini({
    phases: ['Fas 1', 'Fas 2'],
    nodes: [
      { id: 's', kind: 'start', title: '/demo' },
      { id: 'c', kind: 'check', title: 'Liten?', group: 'Fas 1', instr: 'the change is small' },
      { id: 'a', kind: 'agent', title: 'Review', agent: 'skeptic', model: 'opus', rounds: 1, group: 'Fas 2', instr: 'Review it.' },
      { id: 'q', kind: 'ask', title: 'Push?', group: 'Fas 2', instr: 'push to master', hooks: [{ event: 'PostToolUse', matcher: 'Bash', command: 'node C:/x/.claude/hooks/pr-poll-trigger.js' }] },
      { id: 'd', kind: 'step', title: 'Done', group: 'Fas 2' }
    ],
    edges: [{ from: 's', to: 'c' }, { from: 'c', to: 'a', label: 'nej' }, { from: 'c', to: 'd', label: 'ja' }, { from: 'a', to: 'q' }, { from: 'q', to: 'd', label: 'ja' }]
  });
  const expected = [
    '---',
    'name: demo',
    'description: A demo flow',
    '---',
    '',
    MARKER('demo'),
    '',
    '# Demo',
    '',
    'Rules.',
    '',
    'Start with: Liten?.',
    '',
    '## Fas 1',
    '',
    '### Liten?',
    '',
    'Condition: the change is small',
    '',
    'Next:',
    '- nej → Review',
    '- ja → Done',
    '',
    '## Fas 2',
    '',
    '### Review',
    '',
    'Spawn the `skeptic` subagent (model: opus).',
    '',
    'Review it.',
    '',
    'If it reports BLOCKER/MAJOR findings: fix and re-run, at most 1 round; then report the rest to the user.',
    '',
    'Next:',
    '- Push?',
    '',
    '### Done',
    '',
    '### Push?',
    '',
    'Ask the user: push to master and wait.',
    '',
    'Next:',
    '- ja → Done',
    '',
    'Guarded by hooks:',
    '- PostToolUse (Bash): node pr-poll-trigger.js',
    ''
  ].join('\n');
  assert.strictEqual(compileFlow(f), expected);
  assert.strictEqual(compileFlow(f), compileFlow(JSON.parse(JSON.stringify(f))));
});

test('compileFlow: R1 — empty or inherit model emits no model clause', () => {
  for (const model of ['', 'inherit', undefined]) {
    const f = mini(); f.nodes[1].model = model;
    const md = compileFlow(f);
    assert.ok(md.includes('Spawn the `skeptic` subagent.\n'), md);
    assert.ok(!md.includes('(model:'));
  }
});

test('compileFlow: titles/descriptions with newlines, --- or the marker cannot break the frontmatter', () => {
  const f = mini({ description: 'evil\n---\nname: x', name: 'N\n---' });
  f.nodes[1].title = '---\n' + MARKER('demo');
  const md = compileFlow(f);
  const lines = md.split('\n');
  assert.strictEqual(lines[0], '---');
  assert.strictEqual(lines[1], 'name: demo');
  assert.strictEqual(lines[2], 'description: "evil --- name: x"');
  assert.strictEqual(lines[3], '---');
  assert.strictEqual(lines[5], MARKER('demo'));
  assert.strictEqual(lines.indexOf('---', 1), 3);
  assert.ok(md.includes('# N ---\n'));
});

test('compileFlow: unreachable steps go under "## Ej kopplade steg" (R11)', () => {
  const f = mini();
  f.nodes.push({ id: 'lost', kind: 'step', title: 'Lost', group: 'Fas 1', instr: 'nobody gets here' });
  assert.deepStrictEqual(unreachable(validateFlow(f).flow), ['lost']);
  const md = compileFlow(f);
  const i = md.indexOf('## Ej kopplade steg');
  assert.ok(i > md.indexOf('### Review'));
  assert.ok(md.indexOf('### Lost') > i);
});

test('compileFlow: throws on an invalid flow', () => {
  assert.throws(() => compileFlow({ slug: 'x', nodes: [] }));
});

test('hookLabel: shortens paths to file names', () => {
  assert.strictEqual(hookLabel({ event: 'PreToolUse', matcher: 'Bash', command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\.claude\\hooks\\worktree-guard.js"' }),
    'PreToolUse (Bash): node.exe worktree-guard.js');
  assert.strictEqual(hookLabel({ event: 'Stop', matcher: '', command: 'node ~/.claude/hooks/orchestrate-gate.js stop' }), 'Stop: node orchestrate-gate.js stop');
});

// ---------------------------------------------------------------------------------
// The built-in /orchestrate flow (R2): every rule of the hand-written SKILL.md
// ---------------------------------------------------------------------------------

const REAL_DESCRIPTION = 'Orchestrated multi-agent flow for coding tasks — plan, Skeptic plan review, scoped implementation by backend-dev/frontend-dev, verification (tests + Skeptic diff review + security-reviewer when triggered), integration. Use for any non-trivial coding task (new feature, bug fix spanning several files, refactor). Trigger: /orchestrate <task>, "orchestrate", "kör flödet".';

test('defaultOrchestrateFlow: valid, graph as in the prototype minus push, description verbatim', () => {
  const f = defaultOrchestrateFlow();
  const r = validateFlow(f);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.flow, f, 'the default is already normalised');
  assert.strictEqual(f.description, REAL_DESCRIPTION);
  assert.deepStrictEqual(f.phases, ['Planera', 'Bygg', 'Verifiera', 'Leverera']);
  assert.deepStrictEqual(f.nodes.map((n) => n.title),
    ['/orchestrate', 'Klassa', 'Plan + kontrakt', 'Granska plan', 'Backend', 'Frontend', 'Gör själv', 'Tester + build', 'Granska diff', 'Säkerhet', 'Rapport']);
  assert.ok(!f.nodes.some((n) => /push/i.test(n.title + n.instr) || n.kind === 'ask'));
  assert.ok(f.nodes.every((n) => n.model === ''), 'R1: no per-step models');
  assert.ok(f.nodes.every((n) => n.hooks.length === 0), 'hooks are resolved by the store');
  assert.deepStrictEqual(Object.keys(DEFAULT_HOOK_HINTS).sort(), ['be', 'fe', 'report', 'self', 'skdiff']);
  assert.strictEqual(unreachable(f).length, 0);
  assert.strictEqual(f.nodes.find((n) => n.id === 'skplan').rounds, 2);
  assert.strictEqual(f.edges.find((e) => e.to === 'sec').label, 'rör auth/input/data…');
  assert.deepStrictEqual(f.edges.filter((e) => e.from === 'classify').map((e) => e.label), ['normal · risky', 'trivial']);
  assert.notStrictEqual(defaultOrchestrateFlow(), defaultOrchestrateFlow(), 'a fresh copy each call');
});

test('defaultOrchestrateFlow: the compiled SKILL.md carries every rule of the hand-written one', () => {
  const md = compileFlow(defaultOrchestrateFlow());
  const phrases = [
    // frontmatter description, verbatim
    'description: ' + JSON.stringify(REAL_DESCRIPTION),
    // role + task
    'You are the ORCHESTRATOR, running in the main thread. You plan, delegate, verify and integrate.',
    'You do not write the feature code yourself unless the task is trivial',
    'Task: $ARGUMENTS',
    // classification
    'Read enough code to understand the task.',
    'state it on its own line, exactly as `CLASS: trivial`, `CLASS: normal` or `CLASS: risky` (in English, even when replying in another language — tooling reads this line)',
    '**trivial** (1–2 files, obvious, low risk): implement directly',
    'then the Skeptic diff review (Granska diff). Skip Plan + kontrakt, Granska plan',
    '**normal** (several files or one layer): run the full flow, with workers run sequentially.',
    '**risky** (several layers, public contracts, auth/data/migrations, more than about 8 files): run the full flow, with workers run in parallel where independent.',
    // plan
    'Goal and acceptance criteria (testable).',
    'Contract: API shape, types, schema, error shapes — anything two workers must agree on.',
    'Work split: which worker does what, files in scope, dependencies (parallel vs sequential).',
    'Risks and the tests that will prove it works.',
    // plan review
    'Give it the plan and the task, NOT your reasoning.',
    'Fix the plan for every BLOCKER or MAJOR finding. At most 2 rounds; then escalate open disagreements to the user.',
    // workers
    'Delegate implementation to `backend-dev` and/or `frontend-dev` (or a general-purpose agent for other areas).',
    'The approved contract, its exact scope (files/dirs), and its acceptance criteria.',
    'An instruction to return its structured output.',
    'Run independent workers in parallel in one message; dependent ones run in sequence.',
    'If workers run in parallel and may touch the same files, give them isolated worktrees.',
    'Respect any worktree rules from the user or project.',
    'If a worker reports CONTRACT_CHANGES or OPEN_QUESTIONS, resolve them yourself or with the user before continuing.',
    // model choice (verbatim)
    'Each agent has a default model in its definition: `skeptic` and `security-reviewer` run on opus, and `backend-dev` and `frontend-dev` run on sonnet.',
    "You can override a default with the Agent tool's `model` parameter:",
    "Workers move up to `opus` when the task is classed `risky`, when the contract is subtle (concurrency, state machines, security-relevant code), or for a fix round after a worker's first attempt drew BLOCKER/MAJOR findings.",
    'Use `haiku` for pure lookup or search agents (Explore, "find where X is defined"), and `sonnet` when the search needs judgement.',
    'Never downgrade `skeptic` or `security-reviewer`.',
    'Name the model of every agent you start in the AGENTS line of the report, e.g. `backend-dev (sonnet)`, so the choice can be evaluated later.',
    // verification gates
    'Mandatory gate. Run the full test, typecheck and build yourself. Paste the actual result.',
    'Spawn the `skeptic` subagent.\n\nMandatory gate. Give it the diff. Spawn `security-reviewer` (Säkerhet) in the same message',
    'Spawn `security-reviewer` in the same message as the Skeptic diff review (Granska diff) if the diff touches any of: auth, sessions, tokens, permissions, user input, uploads, URL/path parsing, SQL/queries/migrations, secrets/config, crypto, or dependency files. Rule-based, not optional.',
    'Send findings back to the relevant worker (or fix trivial ones yourself), then re-verify. At most 2 fix–review rounds; after that, stop and report the remaining findings to the user.',
    // report
    'CLASS: trivial | normal | risky',
    'AGENTS: <which ran, with model, e.g. backend-dev (sonnet); why any were skipped or upgraded>',
    'CHANGES: <files / summary>',
    'VERIFICATION: <test/build results, Skeptic verdict, Security verdict>',
    'OPEN: <remaining findings, decisions for the user>',
    'Never claim tests pass without having run them.',
    'Never drop a Skeptic or security finding silently — either fix it or list it under OPEN.'
  ];
  for (const p of phrases) assert.ok(md.includes(p), 'missing: ' + p);
  assert.ok(!md.includes('(model: sonnet)'), 'R1');
  assert.ok(!md.includes('(model:'), 'R1');
  assert.ok(!/\bstep [0-9]/i.test(md) && !/steps [0-9]/i.test(md), 'R2: no numeric step references');
  assert.ok(!md.includes('!`'));
  // security gate appears in both diff-review steps so they read as one message
  assert.strictEqual(md.split('in the same message').length - 1 >= 2, true);
  // phases in order
  const at = (h) => md.indexOf('\n## ' + h + '\n');
  assert.ok(at('Planera') < at('Bygg') && at('Bygg') < at('Verifiera') && at('Verifiera') < at('Leverera'));
  assert.ok(md.startsWith('---\nname: orchestrate\n'));
  assert.strictEqual(md.split('\n')[5], MARKER('orchestrate'));
});
