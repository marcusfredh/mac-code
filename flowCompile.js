// Claude flows: validation, the built-in default /orchestrate flow and the compiler
// that turns a flow into a skill's SKILL.md. Pure (no I/O, no dependencies) and UMD, so
// main.js, the tests and the renderer all use the same code.
//
// Flow schema v1 (see the flow-editor plan):
//   { v:1, slug, name, description, preamble, phases:[string],
//     nodes:[{ id, kind, title, sub, group, agent, model, rounds, instr, hooks:[hookRef] }],
//     edges:[{ from, to, label }], pos:{ [id]:{ x, y } }, generated:{ sha1, at } | null }
//   hookRef = { event, matcher, command } — a fingerprint of a settings.json hook.
(function (root) {
  'use strict';

  const KINDS = Object.freeze(['start', 'agent', 'step', 'check', 'ask']);
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,79}$/;
  const EVENT_RE = /^[A-Za-z]{1,40}$/;
  const SHA1_RE = /^[0-9a-f]{40}$/;
  const CAPS = Object.freeze({
    nodes: 200, edges: 400, phases: 30, text: 4000, preamble: 40000, description: 1024,
    hooksPerNode: 20, matcher: 1000, command: 2000, rounds: 10, coord: 1e6
  });
  // Same set as claudeConfig.js UNSAFE_CHARS_RE: C0/C1 controls, bidi marks/overrides/
  // isolates, zero-width characters, line/paragraph separators, BOM.
  const UNSAFE_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/;
  // Multi-line fields: the same, but \t (U+0009) and \n (U+000A) are allowed.
  const UNSAFE_MULTI_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/;
  // `!`cmd`` in a skill runs a shell command when Claude Code loads the skill (R7).
  const BANG_TICK = '!`';
  const ERR_BANG = 'Texten får inte innehålla !` (kör kommandon när skillen laddas)';
  // A fenced block opened with ```! or ~~~! runs too. Refused anywhere (inside quotes,
  // list items, mid-line, after unicode spaces): don't assume Claude Code parses Markdown.
  const FENCE_BANG_RE = /(`{3,}|~{3,})[ \t   -   　]*!/;
  const ERR_FENCE = 'Texten får inte innehålla ```! eller !` (kör kommandon när skillen laddas)';
  // -> error message or null, for one field or for a whole compiled SKILL.md.
  function execError(s) {
    if (s.includes(BANG_TICK)) return ERR_BANG;
    if (FENCE_BANG_RE.test(s)) return ERR_FENCE;
    return null;
  }
  const ERR_UNSAFE = 'Texten innehåller otillåtna tecken (styrtecken eller osynliga tecken)';

  function MARKER(slug) {
    return '<!-- Genererad av Mac Code från ~/.claude/flows/' + slug + '.json. Ändra flödet i Mac Code: Inställningar → Flöden. -->';
  }

  function slugOk(s) { return typeof s === 'string' && SLUG_RE.test(s) && !RESERVED_RE.test(s); }

  // "Mitt Flöde!" -> "mitt-flode"; '' when nothing usable is left.
  function slugFromName(name) {
    let s = String(name == null ? '' : name).toLowerCase()
      .replace(/[åä]/g, 'a').replace(/ö/g, 'o')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    s = s.slice(0, 64).replace(/-+$/, '');
    return slugOk(s) ? s : '';
  }

  // ---------------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------------

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  class FlowError extends Error {
    constructor(message, field) { super(message); this.field = field || null; }
  }
  function bad(msg, field) { throw new FlowError(msg, field); }

  // Text field -> normalised string. Single-line: CR/LF/TAB become spaces, trimmed.
  function text(v, field, { max = CAPS.text, multi = false, trim = true } = {}) {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') bad('Ogiltigt fält: ' + field, field);
    let s = multi ? v.replace(/\r\n?/g, '\n') : v.replace(/[\r\n\t]+/g, ' ');
    if (trim) s = multi ? s.replace(/\s+$/, '') : s.trim();
    if (s.length > max) bad('För lång text (max ' + max + ' tecken): ' + field, field);
    const exec = execError(s);
    if (exec) bad(exec, field);
    if ((multi ? UNSAFE_MULTI_RE : UNSAFE_RE).test(s)) bad(ERR_UNSAFE, field);
    return s;
  }

  function hookRef(h, field) {
    if (!isObj(h)) bad('Ogiltig hook: ' + field, field);
    const event = text(h.event, field + '.event', { max: 40 });
    if (!EVENT_RE.test(event)) bad('Ogiltig hook-event: ' + field, field);
    const matcher = text(h.matcher, field + '.matcher', { max: CAPS.matcher });
    const command = text(h.command, field + '.command', { max: CAPS.command });
    if (!command) bad('Hooken saknar kommando: ' + field, field);
    return { event, matcher, command };
  }

  function num(v, field) {
    if (typeof v !== 'number' || !Number.isFinite(v)) bad('Ogiltigt tal: ' + field, field);
    return Math.max(-CAPS.coord, Math.min(CAPS.coord, v));
  }

  function normalise(obj) {
    if (!isObj(obj)) bad('Flödet är inte ett objekt');
    if (obj.v !== undefined && obj.v !== 1) bad('Okänd flödesversion');
    const slug = typeof obj.slug === 'string' ? obj.slug : '';
    if (!slugOk(slug)) bad('Ogiltigt kommando (slug): ' + JSON.stringify(slug), 'slug');
    const name = text(obj.name, 'name') || slug;
    const description = text(obj.description, 'description', { max: CAPS.description });
    const preamble = text(obj.preamble, 'preamble', { max: CAPS.preamble, multi: true });

    const phases = [];
    if (obj.phases !== undefined) {
      if (!Array.isArray(obj.phases)) bad('Ogiltiga faser', 'phases');
      obj.phases.forEach((p, i) => {
        const s = text(p, 'phases[' + i + ']');
        if (s && !phases.includes(s)) phases.push(s);
      });
    }

    if (!Array.isArray(obj.nodes)) bad('Flödet saknar steg', 'nodes');
    if (obj.nodes.length > CAPS.nodes) bad('För många steg (max ' + CAPS.nodes + ')', 'nodes');
    const ids = new Set();
    const nodes = obj.nodes.map((n, i) => {
      const f = 'nodes[' + i + ']';
      if (!isObj(n)) bad('Ogiltigt steg: ' + f, f);
      if (typeof n.id !== 'string' || !ID_RE.test(n.id)) bad('Ogiltigt steg-id: ' + f, f + '.id');
      if (ids.has(n.id)) bad('Dubblett av steg-id: ' + n.id, f + '.id');
      ids.add(n.id);
      if (!KINDS.includes(n.kind)) bad('Okänd stegtyp: ' + f, f + '.kind');
      const agent = text(n.agent, f + '.agent', { max: 64 });
      if (agent && !AGENT_RE.test(agent)) bad('Ogiltigt agentnamn: ' + f, f + '.agent');
      const model = text(n.model, f + '.model', { max: 80 });
      if (model && !MODEL_RE.test(model)) bad('Ogiltig modell: ' + f, f + '.model');
      let rounds = 0;
      if (n.rounds !== undefined && n.rounds !== null && n.rounds !== '') {
        if (!Number.isInteger(n.rounds) || n.rounds < 0 || n.rounds > CAPS.rounds) bad('Ogiltigt antal rundor (0-' + CAPS.rounds + '): ' + f, f + '.rounds');
        rounds = n.rounds;
      }
      const hooks = [];
      if (n.hooks !== undefined && n.hooks !== null) {
        if (!Array.isArray(n.hooks) || n.hooks.length > CAPS.hooksPerNode) bad('Ogiltiga hooks: ' + f, f + '.hooks');
        n.hooks.forEach((h, j) => {
          const r = hookRef(h, f + '.hooks[' + j + ']');
          if (!hooks.some((x) => x.event === r.event && x.matcher === r.matcher && x.command === r.command)) hooks.push(r);
        });
      }
      const group = text(n.group, f + '.group');
      if (group && !phases.includes(group)) phases.push(group);
      return {
        id: n.id,
        kind: n.kind,
        title: text(n.title, f + '.title'),
        sub: text(n.sub, f + '.sub'),
        group,
        agent,
        model,
        rounds,
        instr: text(n.instr, f + '.instr', { multi: true }),
        hooks
      };
    });
    if (phases.length > CAPS.phases) bad('För många faser (max ' + CAPS.phases + ')', 'phases');
    const starts = nodes.filter((n) => n.kind === 'start').length;
    if (starts !== 1) bad('Flödet måste ha exakt ett startsteg', 'nodes');

    const edges = [];
    if (obj.edges !== undefined) {
      if (!Array.isArray(obj.edges)) bad('Ogiltiga kopplingar', 'edges');
      if (obj.edges.length > CAPS.edges) bad('För många kopplingar (max ' + CAPS.edges + ')', 'edges');
      obj.edges.forEach((e, i) => {
        const f = 'edges[' + i + ']';
        if (!isObj(e) || typeof e.from !== 'string' || typeof e.to !== 'string') bad('Ogiltig koppling: ' + f, f);
        if (!ids.has(e.from) || !ids.has(e.to)) bad('Kopplingen pekar på ett steg som inte finns: ' + f, f);
        const label = text(e.label, f + '.label');
        if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push({ from: e.from, to: e.to, label });
      });
    }

    const pos = {};
    if (obj.pos !== undefined && obj.pos !== null) {
      if (!isObj(obj.pos)) bad('Ogiltiga positioner', 'pos');
      for (const id of Object.keys(obj.pos)) {
        if (!ids.has(id)) continue; // positions of removed steps are dropped
        const p = obj.pos[id];
        if (!isObj(p)) bad('Ogiltig position: ' + id, 'pos');
        pos[id] = { x: num(p.x, 'pos.' + id + '.x'), y: num(p.y, 'pos.' + id + '.y') };
      }
    }

    let generated = null;
    if (isObj(obj.generated) && typeof obj.generated.sha1 === 'string' && SHA1_RE.test(obj.generated.sha1)) {
      const at = typeof obj.generated.at === 'string' && obj.generated.at.length <= 40 && !UNSAFE_RE.test(obj.generated.at) ? obj.generated.at : '';
      generated = { sha1: obj.generated.sha1, at };
    }

    return { v: 1, slug, name, description, preamble, phases, nodes, edges, pos, generated };
  }

  // -> { ok:true, flow } | { ok:false, error, field }
  function validateFlow(obj) {
    try { return { ok: true, flow: normalise(obj) }; }
    catch (err) {
      if (err instanceof FlowError) return { ok: false, error: err.message, field: err.field };
      return { ok: false, error: String(err && err.message ? err.message : err), field: null };
    }
  }

  // ---------------------------------------------------------------------------------
  // Compile
  // ---------------------------------------------------------------------------------

  // Same rules as claudeConfig.js formatValue: plain when obviously safe, else a JSON
  // string (valid YAML double-quoted). CR/LF never reach the file.
  const PLAIN_RE = /^[A-Za-z0-9 ._,()\/-]+$/;
  const YAML_INDICATOR_RE = /^[-?:,\[\]{}#&*!|>'"%@` ]/;
  function formatValue(value) {
    const s = String(value).replace(/[\r\n]+/g, ' ');
    if (s !== '' && PLAIN_RE.test(s) && !YAML_INDICATOR_RE.test(s) && !/ $/.test(s)) return s;
    return JSON.stringify(s);
  }

  function baseName(tok) {
    const parts = tok.split(/[\\/]/);
    return parts[parts.length - 1] || tok;
  }
  // "node C:/Users/x/.claude/hooks/orchestrate-gate.js pre" -> "node orchestrate-gate.js pre"
  function shortCommand(command) {
    const toks = String(command).match(/"[^"]*"|'[^']*'|\S+/g) || [];
    return toks.map((t) => {
      const u = /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
      return /[\\/]/.test(u) ? baseName(u) : u;
    }).join(' ').replace(/`/g, "'");
  }
  function hookLabel(h) {
    return h.event + (h.matcher ? ' (' + h.matcher + ')' : '') + ': ' + shortCommand(h.command);
  }

  function title(n) { return n.title || n.id; }
  function noModel(m) { return !m || m === 'inherit'; }

  function block(s) { return s && s.trim() ? s : ''; }

  // Outgoing edges of a node, in edge order.
  function outs(flow, id) { return flow.edges.filter((e) => e.from === id); }

  function pathLines(flow, byId, id) {
    const list = outs(flow, id);
    if (!list.length) return [];
    return ['Next:'].concat(list.map((e) => '- ' + (e.label ? e.label + ' → ' : '') + title(byId[e.to])));
  }

  function stepLines(flow, byId, n) {
    // Paragraphs of the step, each separated by one blank line.
    const parts = [];
    const instr = block(n.instr);
    const multi = instr.includes('\n');
    if (n.kind === 'agent') {
      const who = n.agent ? 'the `' + n.agent + '` subagent' : 'a subagent';
      parts.push('Spawn ' + who + (noModel(n.model) ? '' : ' (model: ' + n.model + ')') + '.');
      if (instr) parts.push(instr);
      if (n.rounds > 0) {
        parts.push('If it reports BLOCKER/MAJOR findings: fix and re-run, at most ' + n.rounds +
          (n.rounds === 1 ? ' round' : ' rounds') + '; then report the rest to the user.');
      }
    } else if (n.kind === 'check') {
      if (instr) parts.push(multi ? 'Condition:\n\n' + instr : 'Condition: ' + instr);
    } else if (n.kind === 'ask') {
      parts.push(!instr ? 'Ask the user and wait.'
        : multi ? 'Ask the user:\n\n' + instr + '\n\nThen wait for the answer.' : 'Ask the user: ' + instr + ' and wait.');
    } else if (instr) {
      parts.push(instr);
    }
    const paths = pathLines(flow, byId, n.id);
    if (paths.length) parts.push(paths.join('\n'));
    if (n.hooks.length) parts.push(['Guarded by hooks:'].concat(n.hooks.map((h) => '- ' + hookLabel(h))).join('\n'));
    const out = ['### ' + title(n)];
    for (const p of parts) out.push('', p);
    out.push('');
    return out;
  }

  // Breadth-first order from the start node, following edges in edge order.
  function bfsOrder(flow) {
    const start = flow.nodes.find((n) => n.kind === 'start');
    const seen = new Set();
    const order = [];
    if (!start) return order;
    const q = [start.id];
    seen.add(start.id);
    while (q.length) {
      const id = q.shift();
      order.push(id);
      for (const e of outs(flow, id)) if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
    return order;
  }

  // flow (validated) -> SKILL.md text. Deterministic: same flow, same bytes.
  function compileFlow(input) {
    const v = validateFlow(input);
    if (!v.ok) throw new Error(v.error);
    const flow = v.flow;
    const byId = {};
    flow.nodes.forEach((n) => { byId[n.id] = n; });
    const order = bfsOrder(flow);
    const reach = new Set(order);
    const start = byId[order[0]];

    const lines = [
      '---',
      'name: ' + formatValue(flow.slug),
      'description: ' + formatValue(flow.description || flow.name),
      '---',
      '',
      MARKER(flow.slug),
      '',
      '# ' + flow.name,
      ''
    ];
    if (block(flow.preamble)) lines.push(flow.preamble, '');
    const startPaths = pathLines(flow, byId, start.id);
    if (startPaths.length) {
      lines.push(startPaths.length === 2 && !outs(flow, start.id)[0].label
        ? 'Start with: ' + title(byId[outs(flow, start.id)[0].to]) + '.'
        : 'Start:\n' + startPaths.slice(1).join('\n'), '');
    }

    const steps = order.slice(1).map((id) => byId[id]);
    for (const n of steps.filter((s) => !s.group)) lines.push(...stepLines(flow, byId, n));
    for (const phase of flow.phases) {
      const members = steps.filter((s) => s.group === phase);
      if (!members.length) continue;
      lines.push('## ' + phase, '');
      for (const n of members) lines.push(...stepLines(flow, byId, n));
    }
    const loose = flow.nodes.filter((n) => !reach.has(n.id));
    if (loose.length) {
      lines.push('## Ej kopplade steg', '');
      for (const n of loose) lines.push(...stepLines(flow, byId, n));
    }
    // Multi-line texts are emitted verbatim (only trailing whitespace was trimmed).
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  }

  // Nodes not reachable from the start node (shown as a warning chip by the editor).
  function unreachable(flow) {
    const reach = new Set(bfsOrder(flow));
    return (flow.nodes || []).filter((n) => !reach.has(n.id)).map((n) => n.id);
  }

  // ---------------------------------------------------------------------------------
  // The built-in /orchestrate flow: the substance of the hand-written
  // ~/.claude/skills/orchestrate/SKILL.md, carried into the preamble and step texts.
  // ---------------------------------------------------------------------------------

  const ORCH_DESCRIPTION = 'Orchestrated multi-agent flow for coding tasks — plan, Skeptic plan review, scoped implementation by backend-dev/frontend-dev, verification (tests + Skeptic diff review + security-reviewer when triggered), integration. Use for any non-trivial coding task (new feature, bug fix spanning several files, refactor). Trigger: /orchestrate <task>, "orchestrate", "kör flödet".';

  const ORCH_PREAMBLE = [
    'You are the ORCHESTRATOR, running in the main thread. You plan, delegate, verify and integrate. You do not write the feature code yourself unless the task is trivial (see Klassa and Gör själv).',
    '',
    'Task: $ARGUMENTS',
    '',
    'Work through the steps below in order; each step names the steps that follow it. The Verifiera steps are mandatory gates.',
    '',
    '## Workers',
    'Delegate implementation to `backend-dev` and/or `frontend-dev` (or a general-purpose agent for other areas). Give each worker:',
    '- The approved contract, its exact scope (files/dirs), and its acceptance criteria.',
    '- An instruction to return its structured output.',
    '',
    'When the task is classed `normal`, run the workers sequentially. When it is classed `risky`, run them in parallel where independent.',
    'Run independent workers in parallel in one message; dependent ones run in sequence. If workers run in parallel and may touch the same files, give them isolated worktrees. Respect any worktree rules from the user or project.',
    'If a worker reports CONTRACT_CHANGES or OPEN_QUESTIONS, resolve them yourself or with the user before continuing.',
    '',
    '## Model choice',
    'Each agent has a default model in its definition: `skeptic` and `security-reviewer` run on opus, and `backend-dev` and `frontend-dev` run on sonnet. You can override a default with the Agent tool\'s `model` parameter:',
    '- Workers move up to `opus` when the task is classed `risky`, when the contract is subtle (concurrency, state machines, security-relevant code), or for a fix round after a worker\'s first attempt drew BLOCKER/MAJOR findings.',
    '- Use `haiku` for pure lookup or search agents (Explore, "find where X is defined"), and `sonnet` when the search needs judgement.',
    '- Never downgrade `skeptic` or `security-reviewer`.',
    '- Name the model of every agent you start in the AGENTS line of the report, e.g. `backend-dev (sonnet)`, so the choice can be evaluated later.'
  ].join('\n');

  const ORCH_CLASSIFY = [
    'Read enough code to understand the task. Then classify and state it on its own line, exactly as `CLASS: trivial`, `CLASS: normal` or `CLASS: risky` (in English, even when replying in another language — tooling reads this line):',
    '- **trivial** (1–2 files, obvious, low risk): implement directly (Gör själv), then run tests (Tester + build), then the Skeptic diff review (Granska diff). Skip Plan + kontrakt, Granska plan and the Backend/Frontend workers.',
    '- **normal** (several files or one layer): run the full flow, with workers run sequentially.',
    '- **risky** (several layers, public contracts, auth/data/migrations, more than about 8 files): run the full flow, with workers run in parallel where independent.'
  ].join('\n');

  const ORCH_PLAN = [
    'Write a short plan:',
    '- Goal and acceptance criteria (testable).',
    '- Contract: API shape, types, schema, error shapes — anything two workers must agree on.',
    '- Work split: which worker does what, files in scope, dependencies (parallel vs sequential).',
    '- Risks and the tests that will prove it works.'
  ].join('\n');

  const ORCH_PLAN_REVIEW = 'Only for `normal` and `risky` tasks. Give it the plan and the task, NOT your reasoning. Fix the plan for every BLOCKER or MAJOR finding. At most 2 rounds; then escalate open disagreements to the user.';

  const ORCH_WORKER = (part) => [
    'Delegate the ' + part + ' part of the approved plan (use a general-purpose agent for other areas). Give the worker:',
    '- The approved contract, its exact scope (files/dirs), and its acceptance criteria.',
    '- An instruction to return its structured output.',
    'If it reports CONTRACT_CHANGES or OPEN_QUESTIONS, resolve them yourself or with the user before continuing.'
  ].join('\n');

  const ORCH_SELF = 'Only for `trivial` tasks: implement the change directly yourself — no plan, no plan review, no workers. Then continue with Tester + build and Granska diff.';

  const ORCH_TESTS = 'Mandatory gate. Run the full test, typecheck and build yourself. Paste the actual result.';

  const ORCH_DIFF_REVIEW = [
    'Mandatory gate. Give it the diff. Spawn `security-reviewer` (Säkerhet) in the same message when the diff triggers it — the two reviews run together, not one after the other.',
    'Send findings back to the relevant worker (or fix trivial ones yourself), then re-verify. At most 2 fix–review rounds; after that, stop and report the remaining findings to the user.'
  ].join('\n');

  const ORCH_SECURITY = [
    'Mandatory gate when triggered. Spawn `security-reviewer` in the same message as the Skeptic diff review (Granska diff) if the diff touches any of: auth, sessions, tokens, permissions, user input, uploads, URL/path parsing, SQL/queries/migrations, secrets/config, crypto, or dependency files. Rule-based, not optional.',
    'Send findings back to the relevant worker (or fix trivial ones yourself), then re-verify. At most 2 fix–review rounds; after that, stop and report the remaining findings to the user.'
  ].join('\n');

  const ORCH_REPORT = [
    'Report in exactly this format:',
    '```',
    'CLASS: trivial | normal | risky',
    'AGENTS: <which ran, with model, e.g. backend-dev (sonnet); why any were skipped or upgraded>',
    'CHANGES: <files / summary>',
    'VERIFICATION: <test/build results, Skeptic verdict, Security verdict>',
    'OPEN: <remaining findings, decisions for the user>',
    '```',
    'Never claim tests pass without having run them. Never drop a Skeptic or security finding silently — either fix it or list it under OPEN.'
  ].join('\n');

  // Hooks the default flow attaches when the user has them (R10): resolved by script
  // name against settings.json at load time; `event` is a preference among matches.
  const DEFAULT_HOOK_HINTS = Object.freeze({
    self: [{ script: 'worktree-guard.js', arg: null, event: 'PreToolUse' }, { script: 'orchestrate-gate.js', arg: 'pre', event: 'PreToolUse' }],
    be: [{ script: 'worktree-guard.js', arg: null, event: 'PreToolUse' }, { script: 'orchestrate-gate.js', arg: 'pre', event: 'PreToolUse' }],
    fe: [{ script: 'worktree-guard.js', arg: null, event: 'PreToolUse' }, { script: 'orchestrate-gate.js', arg: 'pre', event: 'PreToolUse' }],
    skdiff: [{ script: 'orchestrate-gate.js', arg: 'track', event: 'PostToolUse' }],
    report: [{ script: 'orchestrate-gate.js', arg: 'stop', event: 'Stop' }]
  });

  function defaultOrchestrateFlow() {
    const N = (id, kind, t, o) => Object.assign({ id, kind, title: t, sub: '', group: '', agent: '', model: '', rounds: 0, instr: '', hooks: [] }, o || {});
    const E = (from, to, label) => ({ from, to, label: label || '' });
    return {
      v: 1,
      slug: 'orchestrate',
      name: 'Orchestrate',
      description: ORCH_DESCRIPTION,
      preamble: ORCH_PREAMBLE,
      phases: ['Planera', 'Bygg', 'Verifiera', 'Leverera'],
      nodes: [
        N('start', 'start', '/orchestrate', { sub: 'när du ger en uppgift' }),
        N('classify', 'check', 'Klassa', { sub: 'trivial · normal · risky', group: 'Planera', instr: ORCH_CLASSIFY }),
        N('plan', 'step', 'Plan + kontrakt', { sub: 'mål, kontrakt, arbetsfördelning', group: 'Planera', instr: ORCH_PLAN }),
        N('skplan', 'agent', 'Granska plan', { sub: 'Skeptic', group: 'Planera', agent: 'skeptic', rounds: 2, instr: ORCH_PLAN_REVIEW }),
        N('be', 'agent', 'Backend', { group: 'Bygg', agent: 'backend-dev', instr: ORCH_WORKER('backend') }),
        N('fe', 'agent', 'Frontend', { group: 'Bygg', agent: 'frontend-dev', instr: ORCH_WORKER('frontend') }),
        N('self', 'step', 'Gör själv', { sub: 'liten ändring', group: 'Bygg', instr: ORCH_SELF }),
        N('tests', 'step', 'Tester + build', { sub: 'test, typecheck, build', group: 'Verifiera', instr: ORCH_TESTS }),
        N('skdiff', 'agent', 'Granska diff', { sub: 'Skeptic', group: 'Verifiera', agent: 'skeptic', rounds: 2, instr: ORCH_DIFF_REVIEW }),
        N('sec', 'agent', 'Säkerhet', { sub: 'när diffen rör auth/input/data', group: 'Verifiera', agent: 'security-reviewer', rounds: 2, instr: ORCH_SECURITY }),
        N('report', 'step', 'Rapport', { sub: 'CLASS · AGENTS · CHANGES · VERIFICATION · OPEN', group: 'Leverera', instr: ORCH_REPORT })
      ],
      edges: [
        E('start', 'classify'),
        E('classify', 'plan', 'normal · risky'),
        E('classify', 'self', 'trivial'),
        E('plan', 'skplan'),
        E('skplan', 'be'),
        E('skplan', 'fe'),
        E('be', 'tests'),
        E('fe', 'tests'),
        E('self', 'tests'),
        E('tests', 'skdiff'),
        E('tests', 'sec', 'rör auth/input/data…'),
        E('skdiff', 'report'),
        E('sec', 'report')
      ],
      pos: {},
      generated: null
    };
  }

  const api = {
    KINDS, CAPS, SLUG_RE, MARKER, slugOk, slugFromName, validateFlow, compileFlow,
    defaultOrchestrateFlow, DEFAULT_HOOK_HINTS, unreachable, hookLabel, formatValue, execError
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.flowCompile = api;
})(typeof window !== 'undefined' ? window : this);
