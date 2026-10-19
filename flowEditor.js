// Flöden: the canvas editor for Claude flows (Settings → Flöden).
//
// A flow is a JSON file in ~/.claude/flows/<slug>.json; main owns every path and every
// write (window.flowApi: list / get / save / delete / preview / writeSkill). This module
// only edits the flow in memory and autosaves it through a single-flight queue: one
// request at a time, each with the rev the previous one returned. A conflict or a refused
// (invalid) save keeps the user's edits in memory and says so; nothing is dropped silently.
// SKILL.md is only written from the "Skriv SKILL.md" preview, through the same queue.
//
// Hooks on steps are fingerprints { event, matcher, command }, resolved against
// window.claudeCfgApi.list() (settings.json hooks + Mac Code's turned-off list).
//
// All DOM is built with createElement/textContent; no data goes through innerHTML.

(() => {
  'use strict';

  // ---------- constants ----------
  const W = 184, H = 46, COLGAP = 56, ROWGAP = 22, PHASEGAP = 70;
  const ICON = { start: '▶', agent: 'AG', step: '▸', check: '◇', ask: '?' };
  const KIND = { start: 'Start', agent: 'Agent', step: 'Steg', check: 'Villkor', ask: 'Fråga mig' };
  const CAP = { nodes: 200, edges: 400, phases: 30, text: 4000, preamble: 40000, desc: 1024 };
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const MODELS = [['', 'Agentens standard'], ['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku'], ['fable', 'fable']];
  const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
  const BUILTIN_AGENTS = ['general-purpose'];
  const SKILL_WORDS = { none: 'ny', generated: 'genererad av Mac Code', edited: 'ÄNDRAD FÖR HAND',
    foreign: 'INTE skapad av Mac Code', linked: 'länkad' };
  const NS = 'http://www.w3.org/2000/svg';

  // ---------- pure helpers (also exported for tests) ----------
  const str = (v) => (v == null ? '' : String(v));

  // flowCompile.js (UMD, loaded before this file) is the source of truth when present.
  const FC = () => (window.flowCompile && typeof window.flowCompile === 'object' ? window.flowCompile : null);

  // Name -> command slug: lowercase, å/ä -> a, ö -> o, everything else -> '-'.
  function slugify(name) {
    const fc = FC();
    if (fc && typeof fc.slugFromName === 'function') return fc.slugFromName(name);
    let s = str(name).toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length > 64) s = s.slice(0, 64).replace(/-+$/, '');
    return s;
  }
  function slugOk(s) { return SLUG_RE.test(str(s)); }

  function trimRef(h) {
    return { event: str(h && h.event).trim(), matcher: str(h && h.matcher).trim(), command: str(h && h.command).trim() };
  }
  function refKey(h) { const r = trimRef(h); return r.event + '\u0001' + r.matcher + '\u0001' + r.command; }

  // ref -> { state: 'on'|'off'|'missing', id?, disabledId?, many }
  function resolveRef(ref, data) {
    const k = refKey(ref);
    const on = (data && Array.isArray(data.hooks) ? data.hooks : []).filter((h) => refKey(h) === k);
    const off = (data && Array.isArray(data.disabled) ? data.disabled : []).filter((h) => refKey(h) === k);
    const many = on.length + off.length > 1;
    if (on.length) return { state: 'on', id: on[0].id, many };
    if (off.length) return { state: 'off', disabledId: off[0].id, many };
    return { state: 'missing', many: false };
  }

  // A short name for a hook command: the script's base name plus its first arguments.
  function hookName(cmd) {
    const c = str(cmd).trim();
    const m = c.match(/([A-Za-z0-9_.-]+)\.(?:c?js|mjs|ps1|py|sh|cmd|bat|exe)\b["']?(.*)$/);
    if (m) {
      const rest = m[2].replace(/["']/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
      return (m[1] + (rest ? ' ' + rest : '')).slice(0, 40);
    }
    if (!c) return '(tomt kommando)';
    return c.length > 32 ? c.slice(0, 31) + '…' : c;
  }

  // Ids of nodes that cannot be reached from the start node.
  function unreachable(f) {
    const fc = FC();
    if (fc && typeof fc.unreachable === 'function') { try { return fc.unreachable(f); } catch (_) {} }
    const start = f.nodes.find((n) => n.kind === 'start');
    const seen = new Set();
    if (start) {
      const q = [start.id];
      seen.add(start.id);
      while (q.length) {
        const id = q.shift();
        for (const e of f.edges) if (e.from === id && !seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
      }
    }
    return f.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  }

  // Edges minus the back edges a DFS finds (from the start node first, then from any
  // node not reached yet, in insertion order): what is left is a DAG. Back edges are
  // still drawn; they just do not drive the layout.
  function dagEdges(f) {
    const ids = new Set(f.nodes.map((n) => n.id));
    const valid = f.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const out = new Map();
    for (const n of f.nodes) out.set(n.id, []);
    valid.forEach((e) => out.get(e.from).push(e));
    const state = new Map(); // 1 = on the DFS stack, 2 = done
    const back = new Set();
    const visit = (root) => {
      // Iterative DFS: a stack of [id, index of the next outgoing edge].
      const stack = [[root, 0]];
      state.set(root, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const list = out.get(top[0]);
        if (top[1] >= list.length) { state.set(top[0], 2); stack.pop(); continue; }
        const e = list[top[1]++];
        const s = state.get(e.to);
        if (s === 1) back.add(e);
        else if (!s) { state.set(e.to, 1); stack.push([e.to, 0]); }
      }
    };
    const start = f.nodes.find((n) => n.kind === 'start');
    if (start) visit(start.id);
    for (const n of f.nodes) if (!state.has(n.id)) visit(n.id);
    return valid.filter((e) => !back.has(e));
  }

  // Label for the edge that replaces in → (deleted step) → out: the outgoing label is the
  // condition that mattered, so it wins; both kept when both exist.
  function bridgeLabel(inLabel, outLabel) {
    const a = str(inLabel).trim(), b = str(outLabel).trim();
    return a && b ? a + ' · ' + b : b || a;
  }

  // Phase layout: each phase gets its own block of columns, phases ordered by rank.
  function autoLayout(f) {
    const pos = {};
    if (!f.nodes.length) return pos;
    const phaseOf = (n) => n.group || '·' + n.id;
    const edges = dagEdges(f);
    // rank = longest-path depth over the DAG (Kahn order).
    const indeg = {};
    f.nodes.forEach((n) => { indeg[n.id] = 0; });
    edges.forEach((e) => { indeg[e.to]++; });
    const rank = {};
    const q = f.nodes.filter((n) => !indeg[n.id]).map((n) => n.id);
    q.forEach((id) => { rank[id] = 0; });
    while (q.length) {
      const id = q.shift();
      for (const e of edges) {
        if (e.from !== id) continue;
        rank[e.to] = Math.max(rank[e.to] || 0, rank[id] + 1);
        if (--indeg[e.to] === 0) q.push(e.to);
      }
    }
    f.nodes.forEach((n) => { if (rank[n.id] == null) rank[n.id] = 0; });
    const phases = [];
    for (const n of f.nodes) { const p = phaseOf(n); if (!phases.includes(p)) phases.push(p); }
    const declared = f.phases || [];
    const minRank = (p) => Math.min(...f.nodes.filter((n) => phaseOf(n) === p).map((n) => rank[n.id]));
    phases.sort((a, b) => {
      const ra = minRank(a), rb = minRank(b);
      if (ra !== rb) return ra - rb;
      return declared.indexOf(a) - declared.indexOf(b);
    });
    let x = 0;
    for (const p of phases) {
      const members = f.nodes.filter((n) => phaseOf(n) === p);
      const ids = new Set(members.map((n) => n.id));
      const local = {};
      members.forEach((n) => { local[n.id] = 0; });
      for (let k = 0; k < members.length; k++) {
        for (const e of edges) {
          if (ids.has(e.from) && ids.has(e.to)) local[e.to] = Math.min(members.length, Math.max(local[e.to], local[e.from] + 1));
        }
      }
      const cols = {};
      members.forEach((n) => { (cols[local[n.id]] = cols[local[n.id]] || []).push(n); });
      const keys = Object.keys(cols).map(Number).sort((a, b) => a - b);
      keys.forEach((c, ci) => {
        const list = cols[c];
        list.forEach((n, i) => { pos[n.id] = { x: x + ci * (W + COLGAP), y: (i - (list.length - 1) / 2) * (H + ROWGAP) }; });
      });
      x += keys.length * (W + COLGAP) - COLGAP + PHASEGAP + (p.startsWith('·') ? -20 : 0);
    }
    return pos;
  }

  // Which outgoing edges the simulation follows for a class (trivial / normal / risky).
  function simPick(n, outs, cls) {
    if (outs.length < 2) return outs;
    const labels = outs.map((e) => e.label).join(' ');
    if (/trivial|normal|risky/.test(labels)) return outs.filter((e) => e.label.includes(cls));
    if (/auth|data|input/.test(labels)) return outs.filter((e) => !/auth|data|input/.test(e.label) || cls === 'risky');
    if (n.kind === 'ask') { const y = outs.filter((e) => /ja/i.test(e.label)); return (y.length ? y : outs).slice(0, 1); }
    return outs;
  }

  // Flow from main -> the shape the editor works on (missing fields filled in).
  function normalizeFlow(raw, slug) {
    const f = raw && typeof raw === 'object' ? raw : {};
    const nodes = (Array.isArray(f.nodes) ? f.nodes : []).filter((n) => n && typeof n.id === 'string').map((n) => ({
      id: n.id,
      kind: ['start', 'agent', 'step', 'check', 'ask'].includes(n.kind) ? n.kind : 'step',
      title: str(n.title), sub: str(n.sub), group: str(n.group), agent: str(n.agent),
      model: n.model === 'inherit' ? '' : str(n.model),
      rounds: Number.isFinite(n.rounds) ? Math.max(0, Math.min(9, Math.round(n.rounds))) : 0,
      instr: str(n.instr),
      hooks: (Array.isArray(n.hooks) ? n.hooks : []).filter((h) => h && typeof h === 'object').map(trimRef)
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (Array.isArray(f.edges) ? f.edges : [])
      .filter((e) => e && ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, label: str(e.label) }));
    const pos = {};
    if (f.pos && typeof f.pos === 'object') {
      for (const [k, p] of Object.entries(f.pos)) {
        if (ids.has(k) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos[k] = { x: p.x, y: p.y };
      }
    }
    const out = {
      v: 1, slug: str(f.slug) || slug, name: str(f.name) || slug, description: str(f.description), preamble: str(f.preamble),
      phases: (Array.isArray(f.phases) ? f.phases : []).map(str).filter(Boolean),
      nodes, edges, pos
    };
    if (f.generated && typeof f.generated === 'object') out.generated = f.generated;
    return out;
  }

  // ---------- small DOM helpers ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(cls, label, onClick, aria) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function svgEl(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }
  function isEditable(t) {
    return !!(t && t.closest && t.closest('input, select, textarea, [contenteditable=""], [contenteditable="true"]'));
  }
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const newId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let fieldSeq = 0;

  // ---------- state ----------
  // Lives across mount/unmount so edits that could not be saved survive a closed dialog.
  const S = {
    api: null, cfgApi: null, openInEditor: null, confirm: null,
    flows: [], hasOrchestrateFile: false,
    slug: null, flow: null, rev: null, isDefault: false, exists: false,
    dirty: false, gen: 0, conflict: false, saveErr: null, invalid: false, invalidMsg: null, saveField: null,
    skillStateGet: null, paths: null,
    loadErr: null, loadTok: 0,
    cfg: null, cfgErr: null, defaultHooksDone: false,
    sel: null, selEdge: null, showHooks: false,
    running: false, runTok: 0, sim: { run: new Set(), done: new Set(), edges: new Set() },
    view: { x: 0, y: 0, s: 1 }, userView: false, needFit: true,
    form: null, P: {}
  };
  let R = null;         // DOM refs while mounted
  let saveTimer = null;
  let chain = Promise.resolve();
  let saveTask = null;

  // ---------- api ----------
  function apiUsable(a) {
    return !!a && typeof a === 'object' && ['get', 'save', 'preview', 'writeSkill'].every((k) => typeof a[k] === 'function');
  }
  async function call(target, method, args) {
    if (!target || typeof target[method] !== 'function') return { ok: false, error: 'saknas i den här versionen av Mac Code' };
    try {
      const r = await target[method](args);
      return r && typeof r === 'object' ? r : { ok: false, error: 'inget svar' };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }
  const flowCall = (m, a) => call(S.api, m, a);
  const cfgCall = (m, a) => call(S.cfgApi, m, a);

  // ---------- save queue (single flight) ----------
  // Every flowApi write (save, writeSkill, delete, create) runs through `chain`, one at a
  // time, so each one reads the rev the previous one returned.
  function enqueue(task) {
    const p = chain.then(task, task);
    chain = p.catch(() => {});
    return p;
  }
  const blocked = () => S.conflict || S.invalid;

  function markDirty() {
    if (!S.flow) return;
    S.dirty = true;
    S.gen++;
    // A refused save is retried with the next edit (the user may have fixed the text).
    // The inline error stays until a save goes through, so the drawer is not rebuilt mid-typing.
    if (S.saveErr) { S.saveErr = null; S.invalid = false; paintBanner(); }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; pump(); }, 500);
    paintStatus();
  }

  function flowForSave() {
    const f = S.flow;
    // Main owns `generated`; send the rest.
    return JSON.parse(JSON.stringify({
      v: 1, slug: S.slug, name: f.name, description: f.description, preamble: f.preamble,
      phases: f.phases, nodes: f.nodes, edges: f.edges, pos: f.pos
    }));
  }

  async function saveLoop() {
    while (S.flow && S.dirty && !blocked()) {
      const gen = S.gen;
      const slug = S.slug;
      paintStatus();
      const res = await flowCall('save', { slug, flow: flowForSave(), rev: S.rev });
      if (slug !== S.slug) return;
      if (res.ok) {
        if (typeof res.rev === 'string') S.rev = res.rev;
        if (!S.exists) { S.exists = true; S.isDefault = false; S.hasOrchestrateFile = S.hasOrchestrateFile || slug === 'orchestrate'; }
        S.saveErr = null; S.invalid = false;
        if (S.invalidMsg) { S.invalidMsg = null; S.saveField = null; paintFieldError(); }
        if (S.gen === gen) S.dirty = false;
      } else if (res.conflict) {
        S.conflict = true;
      } else {
        S.saveErr = str(res.error) || 'okänt fel';
        S.invalid = !!res.invalid;
        if (S.invalid) {
          // Kept until a save goes through, so it stays visible while the user fixes it.
          S.invalidMsg = S.saveErr;
          S.saveField = typeof res.field === 'string' ? res.field : null;
        }
        paintFieldError();
        // Not retried in a loop: the next edit (or "Försök igen") retries.
        break;
      }
    }
  }
  function pump() {
    if (saveTask) return saveTask;
    if (!S.flow || !S.dirty || blocked() || S.saveErr) return Promise.resolve();
    saveTask = enqueue(saveLoop).finally(() => {
      saveTask = null;
      paintStatus(); paintBanner();
      // An edit that came in as the loop ended gets its own round.
      if (S.dirty && !blocked() && !S.saveErr && !saveTimer) saveTimer = setTimeout(() => { saveTimer = null; pump(); }, 500);
    });
    return saveTask;
  }
  // Waits for the pending edit and every queued write. -> { ok, conflict, invalid, error }
  async function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (S.dirty && !blocked() && !S.saveErr) await pump();
    await chain;
    if (saveTask) await saveTask;
    const ok = !S.dirty && !S.conflict && !S.saveErr;
    return { ok, conflict: S.conflict, invalid: S.invalid, error: S.conflict ? 'Flödesfilen ändrades utanför Mac Code.' : S.saveErr };
  }

  // ---------- loading ----------
  async function loadList() {
    if (!S.api || typeof S.api.list !== 'function') return;
    const res = await flowCall('list');
    // flowApi.list is shared with the run-state view in older builds: only take the shape we know.
    if (res && res.ok && Array.isArray(res.flows)) {
      S.flows = res.flows.filter((x) => x && slugOk(x.slug));
      S.hasOrchestrateFile = !!res.hasOrchestrateFile;
    }
  }
  async function loadCfg() {
    if (!S.cfgApi || typeof S.cfgApi.list !== 'function') { S.cfg = null; S.cfgErr = 'saknas'; return; }
    const res = await cfgCall('list');
    if (res.ok) { S.cfg = res; S.cfgErr = null; applyDefaultHooks(); } else { S.cfgErr = str(res.error) || 'okänt fel'; }
  }
  function pickerEntries() {
    const out = S.flows.map((x) => ({ slug: x.slug, name: str(x.name) || x.slug, skillState: x.skillState }));
    if (!S.hasOrchestrateFile && !out.some((x) => x.slug === 'orchestrate')) out.unshift({ slug: 'orchestrate', name: 'Orchestrate', skillState: null });
    if (S.slug && !out.some((x) => x.slug === S.slug)) out.push({ slug: S.slug, name: (S.flow && S.flow.name) || S.slug });
    return out;
  }
  function skillState() {
    const e = S.flows.find((x) => x.slug === S.slug);
    if (e && SKILL_WORDS[e.skillState]) return e.skillState;
    return S.skillStateGet || 'none';
  }

  async function openFlow(slug, keepSel) {
    const tok = ++S.loadTok;
    const gen0 = S.gen;
    S.loadErr = null;
    paintStatus();
    const res = await flowCall('get', { slug });
    if (tok !== S.loadTok) return false;
    if (!res.ok) { S.loadErr = str(res.error) || 'okänt fel'; paintAll(); return false; }
    // The user edited while the file was being read: never replace those edits.
    if (S.flow && (S.gen !== gen0 || S.dirty || blocked())) {
      // Same flow (a refresh): keep the in-memory version; the queued save carries it.
      if (S.slug === slug) { paintAll(); return false; }
      // Another flow: the edits belong to the old one; save them first, or stay.
      const r = await flush();
      if (tok !== S.loadTok) return false;
      if (!r.ok) { paintAll(); toast(['Det öppna flödet är inte sparat: ' + (r.error || 'okänt fel')]); return false; }
    }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    S.slug = slug;
    S.flow = normalizeFlow(res.flow, slug);
    S.rev = typeof res.rev === 'string' ? res.rev : null;
    S.isDefault = !!res.isDefault;
    S.exists = !res.isDefault && S.rev != null;
    S.dirty = false; S.conflict = false; S.saveErr = null; S.invalid = false; S.invalidMsg = null; S.saveField = null;
    S.skillStateGet = SKILL_WORDS[res.skillState] ? res.skillState : null;
    S.paths = res.paths && typeof res.paths === 'object' ? res.paths : null;
    S.defaultHooksDone = false;
    if (!keepSel || !S.flow.nodes.some((n) => n.id === S.sel)) S.sel = null;
    S.selEdge = null; S.form = null;
    S.needFit = true; S.userView = false;
    applyDefaultHooks();
    if (R) { clearWorld(); renderAll(); fitSoon(); }
    return true;
  }

  // The built-in default names its hooks by script; attach the user's real ones (R10).
  const DEFAULT_HOOKS = {
    'Gör själv': ['wt', 'pre'], Backend: ['wt', 'pre'], Frontend: ['wt', 'pre'], 'Granska diff': ['track'], Rapport: ['stop']
  };
  function findScriptHook(tag) {
    const all = (S.cfg && Array.isArray(S.cfg.hooks) ? S.cfg.hooks : []).concat(S.cfg && Array.isArray(S.cfg.disabled) ? S.cfg.disabled : []);
    const gate = (arg) => (h) => { const c = str(h.command); const i = c.indexOf('orchestrate-gate.js'); return i >= 0 && new RegExp('\\b' + arg + '\\b').test(c.slice(i + 19)); };
    const test = { wt: (h) => str(h.command).includes('worktree-guard.js'), pre: gate('pre'), track: gate('track'), stop: gate('stop'),
      pr: (h) => str(h.command).includes('pr-poll-trigger.js') }[tag];
    const h = test ? all.find(test) : null;
    return h ? trimRef(h) : null;
  }
  function scriptTag(ref) {
    const c = str(ref.command);
    if (c.includes('worktree-guard')) return 'wt';
    if (c.includes('pr-poll-trigger')) return 'pr';
    const i = c.indexOf('orchestrate-gate');
    if (i >= 0) { const rest = c.slice(i); for (const t of ['pre', 'track', 'stop']) if (new RegExp('\\b' + t + '\\b').test(rest)) return t; }
    return null;
  }
  function applyDefaultHooks() {
    if (!S.isDefault || !S.flow || !S.cfg || S.defaultHooksDone) return;
    S.defaultHooksDone = true;
    for (const n of S.flow.nodes) {
      const next = [];
      for (const ref of n.hooks) {
        if (resolveRef(ref, S.cfg).state !== 'missing') { next.push(ref); continue; }
        const tag = scriptTag(ref);
        const real = tag ? findScriptHook(tag) : null;
        if (real && !next.some((x) => refKey(x) === refKey(real))) next.push(real);
      }
      if (!n.hooks.length && DEFAULT_HOOKS[n.title]) {
        for (const tag of DEFAULT_HOOKS[n.title]) {
          const real = findScriptHook(tag);
          if (real && !next.some((x) => refKey(x) === refKey(real))) next.push(real);
        }
      }
      n.hooks = next;
    }
    // Not marked dirty: the default is only written once the user changes something.
    if (R) renderAll();
  }

  async function refresh() {
    await Promise.all([loadList(), loadCfg()]);
    if (!R) return;
    if (!S.flow) {
      const entries = pickerEntries();
      const first = entries.find((x) => x.slug === 'orchestrate') || entries[0];
      if (first) await openFlow(first.slug);
    } else if (!S.dirty && !blocked() && !S.saveErr && !saveTask && S.exists && !S.running) {
      // Clean: pick up edits made outside Mac Code since the last show.
      await openFlow(S.slug, true);
    }
    renderAll();
  }

  async function switchFlow(slug) {
    if (slug === S.slug) return;
    const r = await flush();
    if (!r.ok) {
      const go = await S.confirm({
        title: 'Släng ändringarna i ' + ((S.flow && S.flow.name) || S.slug) + '?',
        message: 'De kunde inte sparas: ' + (r.error || 'okänt fel'),
        okLabel: 'Släng', danger: true
      });
      if (!go) { paintBar(); return; }
    }
    await openFlow(slug);
  }

  // ---------- mount / unmount ----------
  function mount(container, opts) {
    if (!container) return;
    const o = opts || {};
    if (R && R.container !== container) unmount();
    S.api = o.flowApi || null;
    S.cfgApi = o.claudeCfgApi || null;
    S.openInEditor = typeof o.openInEditor === 'function' ? o.openInEditor : null;
    S.confirm = typeof o.confirm === 'function' ? o.confirm : (x) => Promise.resolve(window.confirm(x.title + '\n' + (x.message || '')));
    if (R) { if (!R.noApi) refresh(); return; }

    const root = el('div', 'fe-root');
    container.textContent = '';
    container.appendChild(root);
    R = { container, root };

    if (!apiUsable(S.api)) {
      const n = el('div', 'set-row-note warn', 'Flödesredigeraren är inte tillgänglig i den här versionen av Mac Code (flowApi saknas).');
      n.setAttribute('role', 'status');
      root.appendChild(n);
      R.noApi = true;
      return;
    }
    build(root);
    renderAll();
    refresh();
  }

  function unmount() {
    if (!R) return;
    flush();
    closeMenu();
    if (R.ro) R.ro.disconnect();
    if (R.docDown) document.removeEventListener('pointerdown', R.docDown, true);
    const dlg = R.container.closest && R.container.closest('.set-dialog');
    if (dlg) dlg.classList.remove('flow-big');
    R.root.remove();
    R = null;
  }

  // Esc: close the topmost editor layer. -> true when something closed.
  function consumesEsc() {
    if (!R || R.noApi) return false;
    if (R.menu) { closeMenu(); return true; }
    if (S.form) {
      const back = S.form.kind === 'newFlow' ? R.picker : null;
      S.form = null; renderDrawer(); renderPanel();
      if (back) back.focus();
      return true;
    }
    if (S.sel || S.selEdge != null) {
      const id = S.sel;
      S.sel = null; S.selEdge = null; renderAll();
      const n = id && R.nodeEls.get(id);
      if (n) n.focus(); else R.canvas.focus();
      return true;
    }
    if (isBig()) { setBig(false); return true; }
    return false;
  }

  // ---------- build ----------
  function build(root) {
    R.nodeEls = new Map();
    R.groupEls = new Map();

    // toolbar
    const bar = el('div', 'fe-bar');
    const picker = el('select', 'set-select fe-picker');
    picker.setAttribute('aria-label', 'Flöde');
    picker.addEventListener('change', () => {
      const v = picker.value;
      if (v === '__new') { paintBar(); openNewFlowForm(); return; }
      switchFlow(v);
    });
    bar.appendChild(picker);
    const meta = el('span', 'fe-meta');
    bar.appendChild(meta);
    const chip = btn('fe-chip', '', () => {
      const ids = unreachable(S.flow).filter((id) => { const n = node(id); return n && n.kind !== 'start'; });
      if (ids.length) { S.sel = ids[0]; S.selEdge = null; renderAll(); centerOn(ids[0]); }
    });
    chip.hidden = true;
    bar.appendChild(chip);
    bar.appendChild(el('span', 'fe-grow'));
    const more = btn('set-btn sm', '⋯', (e) => openMoreMenu(e.currentTarget), 'Fler val för flödet');
    more.setAttribute('aria-haspopup', 'menu');
    bar.appendChild(more);
    const hooksBtn = btn('set-btn sm fe-hooksbtn', '⛨ Visa hooks', () => {
      S.showHooks = !S.showHooks; paintBar(); drawEdges(); if (!S.userView) fit();
    });
    hooksBtn.setAttribute('aria-pressed', 'false');
    bar.appendChild(hooksBtn);
    const cls = el('select', 'set-select fe-cls');
    cls.setAttribute('aria-label', 'Testkör som');
    for (const c of ['trivial', 'normal', 'risky']) { const op = el('option', null, c); op.value = c; cls.appendChild(op); }
    cls.value = 'normal';
    bar.appendChild(cls);
    const run = btn('set-btn sm primary', '▶ Testkör (simulering)', () => (S.running ? stopRun() : testRun()));
    run.title = 'Visar vägen genom flödet. Inget körs på riktigt.';
    bar.appendChild(run);
    const big = btn('set-btn sm', '⤢ Större', () => setBig(!isBig()));
    big.setAttribute('aria-pressed', 'false');
    big.title = 'Använd hela fönstret';
    bar.appendChild(big);
    root.appendChild(bar);

    // banner (conflict / refused save / load error)
    const banner = el('div', 'fe-banner');
    banner.setAttribute('role', 'alert');
    banner.hidden = true;
    root.appendChild(banner);

    // canvas
    const wrap = el('div', 'fe-wrap');
    const canvas = el('div', 'fe-canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Flöde. Tab går till stegen, Enter öppnar ett steg.');
    const world = el('div', 'fe-world');
    canvas.appendChild(world);
    wrap.appendChild(canvas);

    const tools = el('div', 'fe-tools');
    const add = btn('fe-tool fe-add', '+', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      addMenu(r.right + 6, r.top, e.currentTarget, addAfterSelected);
    }, 'Lägg till steg');
    add.title = 'Lägg till steg (efter det valda)';
    const tidy = btn('fe-tool', '✦ Städa upp', tidyUp);
    tidy.title = 'Lägg ut stegen i sina faser igen';
    tools.appendChild(add);
    tools.appendChild(tidy);
    wrap.appendChild(tools);

    const zoomBox = el('div', 'fe-zoom');
    zoomBox.appendChild(btn('fe-tool', '−', () => { S.userView = true; zoom(1 / 1.2, ...mid()); }, 'Zooma ut'));
    zoomBox.appendChild(btn('fe-tool', 'Anpassa', () => { S.userView = false; fit(); }));
    zoomBox.appendChild(btn('fe-tool', '+', () => { S.userView = true; zoom(1.2, ...mid()); }, 'Zooma in'));
    wrap.appendChild(zoomBox);

    const toastEl = el('div', 'fe-toast');
    toastEl.setAttribute('role', 'status');
    toastEl.hidden = true;
    wrap.appendChild(toastEl);

    const drawer = el('aside', 'fe-drawer scroll');
    drawer.setAttribute('aria-label', 'Steg');
    wrap.appendChild(drawer);

    const panel = el('div', 'fe-panel');
    panel.hidden = true;
    wrap.appendChild(panel);
    root.appendChild(wrap);

    // footer
    const foot = el('div', 'fe-foot');
    const paths = el('div', 'fe-paths');
    foot.appendChild(paths);
    const status = el('span', 'fe-status');
    status.setAttribute('role', 'status');
    foot.appendChild(status);
    const retry = btn('set-btn sm', 'Försök igen', () => { S.saveErr = null; S.invalid = false; S.dirty = true; pump(); paintStatus(); });
    retry.hidden = true;
    foot.appendChild(retry);
    const write = btn('set-btn sm', 'Skriv SKILL.md…', writeSkillFlow);
    foot.appendChild(write);
    root.appendChild(foot);

    Object.assign(R, { bar, picker, meta, chip, hooksBtn, cls, run, big, banner, wrap, canvas, world, add, tidy,
      toastEl, drawer, panel, paths, status, retry, write });

    wireCanvas();
    root.addEventListener('keydown', onKey);
    R.docDown = (e) => { if (R && R.menu && !R.menu.contains(e.target) && e.target !== R.menuFrom) closeMenu(); };
    document.addEventListener('pointerdown', R.docDown, true);
    if (typeof ResizeObserver === 'function') {
      R.ro = new ResizeObserver(() => {
        const r = canvas.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        if (S.needFit || !S.userView) fit();
      });
      R.ro.observe(canvas);
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (consumesEsc()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditable(e.target) && !S.running && S.flow) {
      if (S.selEdge != null) { e.preventDefault(); deleteEdge(S.selEdge); return; }
      if (S.sel && e.target.closest && e.target.closest('.fe-canvas')) {
        const n = node(S.sel);
        if (n && n.kind !== 'start') { e.preventDefault(); deleteNode(n); }
      }
    }
  }

  // ---------- model helpers ----------
  const node = (id) => (S.flow ? S.flow.nodes.find((n) => n.id === id) : null);
  function canAddNode() {
    if (S.flow.nodes.length >= CAP.nodes) { toast(['Högst ' + CAP.nodes + ' steg i ett flöde.']); return false; }
    if (S.flow.edges.length + 2 > CAP.edges) { toast(['Högst ' + CAP.edges + ' pilar i ett flöde.']); return false; }
    return true;
  }
  function mkNode(kind, title, o) {
    return Object.assign({ id: newId(), kind, title, sub: '', group: '', agent: '', model: '', rounds: 0, instr: '', hooks: [] }, o || {});
  }
  function agentIds() {
    const ids = (S.cfg && Array.isArray(S.cfg.agents) ? S.cfg.agents : []).filter((a) => a && !a.readonly).map((a) => str(a.id));
    for (const b of BUILTIN_AGENTS) if (!ids.includes(b)) ids.push(b);
    return ids;
  }
  function agentDefaultModel(id) {
    const a = (S.cfg && Array.isArray(S.cfg.agents) ? S.cfg.agents : []).find((x) => str(x.id) === id);
    if (!a) return null;
    const m = str(a.model).trim();
    return !m || m === 'inherit' ? 'ärver sessionens' : m;
  }
  function deleteEdge(i) {
    if (!S.flow.edges[i]) return;
    S.flow.edges.splice(i, 1);
    S.selEdge = null;
    markDirty(); renderAll();
    toast(['Tog bort pilen']);
    R.canvas.focus();
  }
  function deleteNode(n) {
    const f = S.flow;
    const ins = f.edges.filter((e) => e.to === n.id), outs = f.edges.filter((e) => e.from === n.id);
    f.edges = f.edges.filter((e) => e.from !== n.id && e.to !== n.id);
    for (const a of ins) {
      for (const b of outs) {
        if (a.from !== b.to && !f.edges.some((e) => e.from === a.from && e.to === b.to) && f.edges.length < CAP.edges) {
          f.edges.push({ from: a.from, to: b.to, label: bridgeLabel(a.label, b.label) });
        }
      }
    }
    f.nodes = f.nodes.filter((y) => y.id !== n.id);
    delete f.pos[n.id];
    S.sel = null;
    markDirty(); renderAll();
    const labelled = ins.concat(outs).some((e) => str(e.label).trim());
    toast(labelled ? ['Tog bort ', ['b', n.title], ' · kontrollera vägarna efter borttagningen']
      : ['Tog bort ', ['b', n.title], ' och kopplade ihop pilarna runt det']);
    R.canvas.focus();
  }

  // ---------- render ----------
  function positions() {
    const f = S.flow;
    const auto = autoLayout(f);
    for (const n of f.nodes) if (f.pos[n.id]) auto[n.id] = f.pos[n.id];
    return auto;
  }
  function clearWorld() {
    if (!R || !R.world) return;
    R.world.textContent = '';
    R.nodeEls.clear();
    R.groupEls.clear();
  }
  function paintAll() { paintBar(); paintStatus(); paintBanner(); }
  function renderAll() {
    if (!R || R.noApi) return;
    if (S.flow) renderCanvas(); else clearWorld();
    renderDrawer();
    renderPanel();
    paintAll();
  }

  function groupBox(list) {
    const xs = list.map((n) => S.P[n.id].x), ys = list.map((n) => S.P[n.id].y);
    const x0 = Math.min(...xs) - 20, y0 = Math.min(...ys) - 26, x1 = Math.max(...xs) + W + 20, y1 = Math.max(...ys) + H + 18;
    return { left: x0 + 'px', top: y0 + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' };
  }
  function phaseGroups() {
    const groups = {};
    S.flow.nodes.forEach((n) => { if (n.group && S.P[n.id]) (groups[n.group] = groups[n.group] || []).push(n); });
    return groups;
  }
  function moveGroups() {
    for (const [g, list] of Object.entries(phaseGroups())) {
      const box = R.groupEls.get(g);
      if (box) Object.assign(box.style, groupBox(list));
    }
  }

  function renderCanvas() {
    const f = S.flow;
    S.P = positions();
    const groups = phaseGroups();
    for (const [g, e] of R.groupEls) if (!groups[g]) { e.remove(); R.groupEls.delete(g); }
    for (const [g, list] of Object.entries(groups)) {
      let box = R.groupEls.get(g);
      if (!box) { box = el('div', 'fe-group'); box.appendChild(el('span')); R.world.prepend(box); R.groupEls.set(g, box); }
      Object.assign(box.style, groupBox(list));
      const lab = box.firstChild;
      lab.textContent = g;
      const hk = new Set(list.flatMap((n) => n.hooks.map(refKey)));
      if (hk.size) lab.appendChild(el('i', null, '⛨ ' + hk.size));
    }
    for (const [id, e] of R.nodeEls) if (!f.nodes.some((n) => n.id === id)) { e.remove(); R.nodeEls.delete(id); }
    for (const n of f.nodes) {
      let e = R.nodeEls.get(n.id);
      if (!e) {
        e = el('div');
        e.dataset.id = n.id;
        e.tabIndex = 0;
        e.setAttribute('role', 'button');
        R.world.appendChild(e);
        R.nodeEls.set(n.id, e);
        wireNode(e, n.id);
      }
      e.style.left = S.P[n.id].x + 'px';
      e.style.top = S.P[n.id].y + 'px';
      paintNode(n);
    }
    drawEdges();
  }

  function paintNode(n) {
    const e = R.nodeEls.get(n.id);
    if (!e) return;
    const bad = S.invalidMsg && fieldTarget(S.saveField);
    e.className = 'fe-node k-' + n.kind + (S.sel === n.id ? ' sel' : '') + (S.sim.run.has(n.id) ? ' run' : '') + (S.sim.done.has(n.id) ? ' done' : '') +
      (bad && bad.nodeId === n.id ? ' bad' : '');
    e.setAttribute('aria-pressed', String(S.sel === n.id));
    e.setAttribute('aria-label', KIND[n.kind] + ': ' + (n.title || '(namnlöst)') + (n.kind === 'agent' && n.agent ? ', agent ' + n.agent : ''));
    e.textContent = '';
    const c = el('div', 'fe-card');
    const ic = el('div', 'fe-ic', ICON[n.kind]);
    ic.setAttribute('aria-hidden', 'true');
    const tx = el('div', 'fe-txt');
    tx.appendChild(el('div', 'fe-tt', n.title || '(namnlöst)'));
    const s = n.kind === 'agent' ? n.agent : n.sub;
    if (s) tx.appendChild(el('div', 'fe-ts', s));
    const marks = el('div', 'fe-marks');
    if (n.kind === 'agent' && n.model) marks.appendChild(el('span', 'fe-mk m', n.model));
    if (n.rounds) marks.appendChild(el('span', 'fe-mk', '↺' + n.rounds));
    if (n.hooks.length) marks.appendChild(el('span', 'fe-mk h', '⛨' + n.hooks.length));
    c.appendChild(ic); c.appendChild(tx); c.appendChild(marks);
    const port = el('span', 'fe-port');
    port.title = 'Dra för att koppla till ett annat steg';
    c.appendChild(port);
    e.appendChild(c);
  }

  const outPt = (p) => ({ x: p.x + W, y: p.y + H / 2 });
  const inPt = (p) => ({ x: p.x, y: p.y + H / 2 });
  function curve(A, B) {
    if (B.x < A.x + 10) {
      const lift = Math.max(A.y, B.y) + 80;
      return `M${A.x},${A.y} C${A.x + 60},${A.y} ${A.x + 60},${lift} ${(A.x + B.x) / 2},${lift} S${B.x - 60},${B.y} ${B.x - 2},${B.y}`;
    }
    const dx = Math.max(30, (B.x - A.x) / 2);
    return `M${A.x},${A.y} C${A.x + dx},${A.y} ${B.x - dx},${B.y} ${B.x - 2},${B.y}`;
  }

  // Flow-wide hooks for the lane: one entry per fingerprint, with the steps it guards.
  function laneHooks() {
    const map = new Map();
    for (const n of S.flow.nodes) {
      for (const ref of n.hooks) {
        const k = refKey(ref);
        if (!map.has(k)) map.set(k, { ref, nodes: [] });
        map.get(k).nodes.push(n.id);
      }
    }
    return [...map.values()];
  }

  function drawEdges(temp) {
    if (!R || !S.flow) return;
    const world = R.world;
    world.querySelectorAll('svg.fe-edges, .fe-elabel, .fe-eplus, .fe-lane, .fe-hnode').forEach((x) => x.remove());
    const f = S.flow;
    const P = S.P;
    const svg = svgEl('svg', { class: 'fe-edges', 'aria-hidden': 'true' });
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'fe-ar', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(svgEl('path', { class: 'fe-arrow', d: 'M0,0 L8,4 L0,8 z' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    world.insertBefore(svg, world.querySelector('.fe-node'));
    f.edges.forEach((e, i) => {
      const a = P[e.from], b = P[e.to];
      if (!a || !b) return;
      const A = outPt(a), B = inPt(b);
      const d = curve(A, B);
      const p = svgEl('path', { d, class: 'fe-e' + (S.selEdge === i ? ' sel' : '') + (S.sim.edges.has(i) ? ' flow' : ''), 'marker-end': 'url(#fe-ar)' });
      svg.appendChild(p);
      const hit = svgEl('path', { d, class: 'fe-e hit' });
      svg.appendChild(hit);
      const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      if (e.label) {
        const l = el('div', 'fe-elabel', e.label);
        l.style.left = m.x + 'px'; l.style.top = m.y + 'px';
        world.appendChild(l);
      }
      const from = node(e.from), to = node(e.to);
      const plus = btn('fe-eplus', '+', (ev) => {
        ev.stopPropagation();
        if (S.running) return;
        const r = plus.getBoundingClientRect();
        addMenu(r.right + 4, r.top, plus, (n) => insertOnEdge(i, n));
      }, 'Lägg in steg mellan ' + (from ? from.title : '') + ' och ' + (to ? to.title : ''));
      plus.style.left = m.x + 'px';
      plus.style.top = (m.y + (e.label ? 16 : 0)) + 'px';
      hit.addEventListener('pointerenter', () => plus.classList.add('show'));
      hit.addEventListener('pointerleave', () => setTimeout(() => { if (!plus.matches(':hover')) plus.classList.remove('show'); }, 120));
      plus.addEventListener('pointerleave', () => plus.classList.remove('show'));
      hit.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        if (S.running) return;
        S.selEdge = i; S.sel = null; S.form = null;
        renderAll();
        toast(['Pil vald · ', ['b', 'Delete'], ' tar bort den']);
      });
      world.appendChild(plus);
    });
    if (S.showHooks) {
      const pts = Object.values(P);
      const laneY = (pts.length ? Math.max(...pts.map((p) => p.y)) : 0) + H + 110;
      const laneX = pts.length ? Math.min(...pts.map((p) => p.x)) : 0;
      const hooks = laneHooks();
      const lab = el('div', 'fe-lane', hooks.length ? 'Hooks i flödet · klicka för att slå av/på' : 'Inga hooks i flödet · koppla dem i ett stegs panel');
      lab.style.left = laneX + 'px'; lab.style.top = laneY - 22 + 'px';
      world.appendChild(lab);
      hooks.forEach((entry, i) => {
        const r = resolveRef(entry.ref, S.cfg);
        const hx = laneX + i * 230, hy = laneY;
        const name = hookName(entry.ref.command);
        const hn = btn('fe-hnode' + (r.state === 'off' ? ' off' : r.state === 'missing' ? ' missing' : ''),
          '⛨ ' + name + (r.state === 'missing' ? ' (saknas)' : ''), () => toggleHook(entry.ref));
        hn.setAttribute('aria-pressed', String(r.state === 'on'));
        hn.setAttribute('aria-label', 'Hook ' + name + ', ' + (r.state === 'on' ? 'på' : r.state === 'off' ? 'av' : 'saknas'));
        hn.title = entry.ref.event + (entry.ref.matcher ? ' · ' + entry.ref.matcher : '') + '\n' + entry.ref.command;
        hn.style.left = hx + 'px'; hn.style.top = hy + 'px';
        world.appendChild(hn);
        for (const id of entry.nodes) {
          const t = P[id];
          if (!t) continue;
          const A = { x: hx + 60, y: hy }, B = { x: t.x + W / 2, y: t.y + H };
          svg.appendChild(svgEl('path', { d: `M${A.x},${A.y} C${A.x},${A.y - 50} ${B.x},${B.y + 50} ${B.x},${B.y}`, class: 'fe-e hook' }));
        }
      });
    }
    if (temp) svg.appendChild(svgEl('path', { d: `M${temp.a.x},${temp.a.y} L${temp.b.x},${temp.b.y}`, class: 'fe-e temp' }));
  }

  // ---------- bar / status / banner ----------
  function isBig() {
    const dlg = R && R.container.closest && R.container.closest('.set-dialog');
    return !!(dlg && dlg.classList.contains('flow-big'));
  }
  function setBig(on) {
    const dlg = R && R.container.closest && R.container.closest('.set-dialog');
    if (dlg) dlg.classList.toggle('flow-big', on);
    R.root.classList.toggle('big', on);
    paintBar();
  }

  function paintBar() {
    if (!R || R.noApi) return;
    const p = R.picker;
    p.textContent = '';
    for (const x of pickerEntries()) {
      const o = el('option', null, x.name + (x.slug === 'orchestrate' && !S.hasOrchestrateFile ? ' (inbyggt)' : ''));
      o.value = x.slug;
      p.appendChild(o);
    }
    const nw = el('option', null, '+ Nytt flöde…');
    nw.value = '__new';
    p.appendChild(nw);
    if (S.slug) p.value = S.slug;
    p.disabled = S.running;
    const f = S.flow;
    R.meta.textContent = '';
    if (f) {
      R.meta.appendChild(document.createTextNode('startas med '));
      R.meta.appendChild(el('code', null, '/' + S.slug));
      R.meta.appendChild(document.createTextNode(' · ' + f.nodes.length + ' steg'));
      const un = unreachable(f).filter((id) => { const n = node(id); return n && n.kind !== 'start'; }).length;
      R.chip.hidden = !un;
      R.chip.textContent = un === 1 ? '1 steg är inte kopplat' : un + ' steg är inte kopplade';
      R.chip.title = 'Nås inte från start. Hamnar under "Ej kopplade steg" i SKILL.md. Klicka för att visa.';
    } else R.chip.hidden = true;
    R.hooksBtn.setAttribute('aria-pressed', String(S.showHooks));
    R.hooksBtn.textContent = S.showHooks ? '⛨ Dölj hooks' : '⛨ Visa hooks';
    R.run.textContent = S.running ? '■ Stoppa simuleringen' : '▶ Testkör (simulering)';
    R.cls.disabled = S.running;
    const big = isBig();
    R.big.setAttribute('aria-pressed', String(big));
    R.big.textContent = big ? '⤡ Mindre' : '⤢ Större';
    R.add.disabled = !f || S.running;
    R.tidy.disabled = !f || S.running;
    R.tidy.classList.toggle('dirty', !!f && Object.keys(f.pos).length > 0);
    R.write.disabled = !f || S.running;
  }

  function paintStatus() {
    if (!R || R.noApi) return;
    const slug = S.slug || '…';
    R.paths.textContent = '';
    R.paths.appendChild(document.createTextNode('Sparas som '));
    R.paths.appendChild(el('code', null, '~/.claude/flows/' + slug + '.json'));
    R.paths.appendChild(document.createTextNode(' · skriver '));
    R.paths.appendChild(el('code', null, 'skills/' + slug + '/SKILL.md'));
    R.paths.appendChild(document.createTextNode(' (' + SKILL_WORDS[skillState()] + ')'));
    R.paths.title = S.paths ? [str(S.paths.flow), str(S.paths.skill)].filter(Boolean).join('\n') : '';
    let text, kind = '';
    if (S.loadErr) { text = 'Kunde inte läsa flödet: ' + S.loadErr; kind = 'err'; }
    else if (!S.flow) text = 'Läser in…';
    else if (S.conflict) { text = 'Inte sparat · filen ändrades utanför Mac Code'; kind = 'err'; }
    else if (S.saveErr) { text = 'Inte sparat: ' + S.saveErr; kind = 'err'; }
    else if (S.dirty || saveTask) text = 'Sparar…';
    else if (!S.exists) text = 'Inbyggt standardflöde · sparas när du ändrar något';
    else { text = '✓ Sparat'; kind = 'ok'; }
    R.status.textContent = text;
    R.status.className = 'fe-status' + (kind ? ' ' + kind : '');
    R.retry.hidden = !(S.saveErr && !S.invalid && !S.conflict);
  }

  function paintBanner() {
    if (!R || R.noApi) return;
    const b = R.banner;
    b.textContent = '';
    b.className = 'fe-banner';
    if (S.conflict) {
      b.classList.add('err');
      b.appendChild(el('span', 'fe-banner-text', 'Filen ändrades utanför Mac Code. Dina ändringar finns kvar här men är inte sparade.'));
      b.appendChild(btn('set-btn sm', 'Läs om (släng mina ändringar)', async () => {
        S.conflict = false; S.dirty = false;
        await openFlow(S.slug);
        await loadList();
        renderAll();
        toast(['Läste om ', ['b', S.flow ? S.flow.name : S.slug]]);
      }));
      b.appendChild(btn('set-btn sm danger', 'Skriv över', overwriteAfterConflict));
      b.hidden = false;
    } else if (S.invalidMsg) {
      b.classList.add('warn');
      b.appendChild(el('span', 'fe-banner-text', 'Ändringen kunde inte sparas: ' + S.invalidMsg + '. Rätta texten så sparas den.'));
      b.hidden = false;
    } else b.hidden = true;
  }

  async function overwriteAfterConflict() {
    // Take the rev on disk now, then save this version over it.
    const res = await enqueue(() => flowCall('get', { slug: S.slug }));
    // A file main cannot parse still has a rev; a removed file is created again (rev null).
    const usable = res.ok || typeof res.rev === 'string' || res.notFound;
    if (!usable) { toast(['Kunde inte läsa filen: ' + (res.error || 'okänt fel')]); return; }
    S.rev = typeof res.rev === 'string' ? res.rev : null;
    S.exists = S.rev != null;
    S.conflict = false;
    S.dirty = true;
    S.gen++;
    paintBanner();
    await pump();
    paintAll();
    if (!S.conflict && !S.saveErr) toast(['Sparade dina ändringar över filen']);
  }

  // ---------- toast ----------
  // parts: strings, or ['b', text] for a bold part.
  function toast(parts) {
    if (!R || !R.toastEl) return;
    const t = R.toastEl;
    t.textContent = '';
    for (const p of parts) {
      if (Array.isArray(p)) t.appendChild(el('b', null, str(p[1])));
      else t.appendChild(document.createTextNode(str(p)));
    }
    t.hidden = false;
    clearTimeout(R.toastT);
    R.toastT = setTimeout(() => { if (R) R.toastEl.hidden = true; }, 3500);
  }

  // ---------- view ----------
  function apply() { R.world.style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.s})`; }
  function toWorld(cx, cy) {
    const r = R.canvas.getBoundingClientRect();
    return { x: (cx - r.left - S.view.x) / S.view.s, y: (cy - r.top - S.view.y) / S.view.s };
  }
  function fit() {
    if (!R || !R.canvas || !S.flow) return;
    const r = R.canvas.getBoundingClientRect();
    const pts = Object.values(S.P);
    if (!pts.length || r.width < 2 || r.height < 2) return;
    const x0 = Math.min(...pts.map((p) => p.x)) - 40, x1 = Math.max(...pts.map((p) => p.x)) + W + 40;
    const y0 = Math.min(...pts.map((p) => p.y)) - 60;
    const y1 = Math.max(...pts.map((p) => p.y)) + H + 40 + (S.showHooks ? 160 : 0);
    const s = Math.min(1.1, Math.max(0.3, Math.min(r.width / (x1 - x0), (r.height - 30) / (y1 - y0))));
    S.view = { s, x: (r.width - (x1 - x0) * s) / 2 - x0 * s, y: (r.height - (y1 - y0) * s) / 2 - y0 * s + 8 };
    S.needFit = false;
    apply();
  }
  function fitSoon() { requestAnimationFrame(() => { if (R && (S.needFit || !S.userView)) fit(); }); }
  function zoom(fct, cx, cy) {
    const r = R.canvas.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const s = Math.min(1.8, Math.max(0.3, S.view.s * fct));
    const k = s / S.view.s;
    S.view.x = px - (px - S.view.x) * k;
    S.view.y = py - (py - S.view.y) * k;
    S.view.s = s;
    apply();
  }
  function mid() { const r = R.canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  function centerOn(id) {
    const p = S.P[id];
    if (!p) return;
    const r = R.canvas.getBoundingClientRect();
    S.view.x = r.width / 2 - (p.x + W / 2) * S.view.s;
    S.view.y = r.height / 2 - (p.y + H / 2) * S.view.s;
    S.userView = true;
    apply();
  }

  function wireCanvas() {
    const canvas = R.canvas;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      S.userView = true;
      zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
    }, { passive: false });
    let pan = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.fe-node, .fe-eplus, .fe-hnode') || (e.target.classList && e.target.classList.contains('hit'))) return;
      pan = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      canvas.classList.add('panning');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pan) return;
      if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 3) { pan.moved = true; S.userView = true; }
      S.view.x = pan.vx + e.clientX - pan.x;
      S.view.y = pan.vy + e.clientY - pan.y;
      apply();
    });
    const end = () => {
      if (pan && !pan.moved && (S.sel || S.selEdge != null)) { S.sel = null; S.selEdge = null; S.form = null; renderAll(); }
      pan = null;
      canvas.classList.remove('panning');
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  function select(id) {
    S.sel = id; S.selEdge = null;
    if (S.form && S.form.kind !== 'newFlow') S.form = null;
    renderAll();
  }

  function wireNode(e, id) {
    let drag = null, link = null;
    e.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === e) {
        ev.preventDefault();
        if (S.running) return;
        select(id);
        const first = R.drawer.querySelector('input, textarea, select');
        if (first) first.focus();
      }
    });
    e.addEventListener('pointerdown', (ev) => {
      if (S.running || ev.button !== 0) return;
      ev.stopPropagation();
      if (ev.target.classList.contains('fe-port')) { link = { tgt: null }; try { e.setPointerCapture(ev.pointerId); } catch (_) {} return; }
      const p = S.P[id];
      if (!p) return;
      drag = { x: ev.clientX, y: ev.clientY, nx: p.x, ny: p.y, moved: false };
      try { e.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    e.addEventListener('pointermove', (ev) => {
      if (drag) {
        const dx = (ev.clientX - drag.x) / S.view.s, dy = (ev.clientY - drag.y) / S.view.s;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          const p = { x: Math.round(drag.nx + dx), y: Math.round(drag.ny + dy) };
          S.flow.pos[id] = p;
          S.P[id] = p;
          e.style.left = p.x + 'px'; e.style.top = p.y + 'px';
          drawEdges(); moveGroups();
        }
      } else if (link) {
        const over = document.elementFromPoint(ev.clientX, ev.clientY);
        const t = over && over.closest('.fe-node');
        R.nodeEls.forEach((x) => x.classList.remove('drop'));
        const tn = t && node(t.dataset.id);
        link.tgt = tn && tn.id !== id && tn.kind !== 'start' ? tn.id : null;
        if (link.tgt) t.classList.add('drop');
        if (S.P[id]) drawEdges({ a: outPt(S.P[id]), b: toWorld(ev.clientX, ev.clientY) });
      }
    });
    const up = () => {
      if (drag) {
        const moved = drag.moved;
        drag = null;
        if (moved) { markDirty(); paintBar(); } else select(id);
      }
      if (link) {
        const f = S.flow;
        const tgt = link.tgt;
        link = null;
        R.nodeEls.forEach((x) => x.classList.remove('drop'));
        if (tgt && !f.edges.some((x) => x.from === id && x.to === tgt)) {
          if (f.edges.length >= CAP.edges) toast(['Högst ' + CAP.edges + ' pilar i ett flöde.']);
          else {
            f.edges.push({ from: id, to: tgt, label: '' });
            markDirty();
            toast(['Kopplade ', ['b', node(id).title], ' → ', ['b', node(tgt).title]]);
          }
        }
        renderAll();
      }
    };
    e.addEventListener('pointerup', up);
    e.addEventListener('pointercancel', () => { if (drag && drag.moved) markDirty(); drag = null; link = null; R.nodeEls.forEach((x) => x.classList.remove('drop')); drawEdges(); });
  }

  // ---------- tidy up ----------
  function tidyUp() {
    const f = S.flow;
    if (!f || S.running) return;
    if (!Object.keys(f.pos).length) { toast(['Redan uppstädat']); return; }
    const glide = !reducedMotion();
    if (glide) R.world.classList.add('tidy');
    f.pos = {};
    markDirty();
    R.world.querySelectorAll('svg.fe-edges, .fe-elabel, .fe-eplus').forEach((x) => { x.style.opacity = '0'; });
    S.P = positions();
    for (const n of f.nodes) {
      const e = R.nodeEls.get(n.id);
      if (e) { e.style.left = S.P[n.id].x + 'px'; e.style.top = S.P[n.id].y + 'px'; }
    }
    moveGroups();
    setTimeout(() => {
      if (!R) return;
      R.world.classList.remove('tidy');
      renderAll();
      S.userView = false;
      fit();
      toast(['Städat · stegen ligger i sina faser igen']);
    }, glide ? 480 : 0);
  }

  // ---------- menus ----------
  function closeMenu() {
    if (!R || !R.menu) return;
    const from = R.menuFrom;
    R.menu.remove();
    R.menu = null; R.menuFrom = null;
    if (from && from.isConnected && R.root.contains(document.activeElement) === false) { try { from.focus(); } catch (_) {} }
  }
  function openMenu(x, y, from, build) {
    closeMenu();
    const m = el('div', 'fe-menu');
    m.setAttribute('role', 'menu');
    build(m);
    R.root.appendChild(m);
    m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px';
    m.addEventListener('keydown', (e) => {
      const items = [...m.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items[((i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        if (n) n.focus();
      } else if (e.key === 'Tab') { e.preventDefault(); closeMenu(); if (from) from.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); if (from) from.focus(); }
    });
    R.menu = m;
    R.menuFrom = from || null;
    const first = m.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }
  function menuItem(m, kind, label, sub, onPick, disabled) {
    const b = el('button', 'fe-mi');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (kind) { const ic = el('span', 'fe-ic k-' + kind, ICON[kind]); ic.setAttribute('aria-hidden', 'true'); b.appendChild(ic); }
    b.appendChild(el('span', null, label));
    if (sub) b.appendChild(el('small', null, sub));
    b.disabled = !!disabled;
    b.addEventListener('click', () => { const from = R.menuFrom; closeMenu(); onPick(from); });
    m.appendChild(b);
  }

  function addMenu(x, y, from, onPick) {
    if (!S.flow || S.running) return;
    openMenu(x, y, from, (m) => {
      for (const a of agentIds()) {
        const dm = agentDefaultModel(a);
        menuItem(m, 'agent', a, dm && dm !== 'ärver sessionens' ? dm : '', () => onPick(mkNode('agent', a === 'skeptic' ? 'Granska' : a, { agent: a })));
      }
      m.appendChild(el('hr'));
      menuItem(m, 'step', 'Steg', 'egen instruktion', () => onPick(mkNode('step', 'Nytt steg')));
      menuItem(m, 'check', 'Villkor', 'om … annars', () => onPick(mkNode('check', 'Villkor', { sub: 'beskriv villkoret' })));
      menuItem(m, 'ask', 'Fråga mig', 'väntar på svar', () => onPick(mkNode('ask', 'Fråga', { sub: 'frågar dig' })));
    });
  }
  function insertOnEdge(i, n) {
    const f = S.flow;
    const e = f.edges[i];
    if (!e || !canAddNode()) return;
    const from = node(e.from), to = node(e.to);
    n.group = (to && to.group) || (from && from.group) || '';
    f.nodes.push(n);
    f.edges.splice(i, 1, { from: e.from, to: n.id, label: e.label }, { from: n.id, to: e.to, label: '' });
    S.sel = n.id; S.selEdge = null;
    markDirty(); renderAll();
    toast(['Lade in ', ['b', n.title], ' i ' + (n.group || 'flödet')]);
  }
  function addAfterSelected(n) {
    const f = S.flow;
    if (!canAddNode()) return;
    const last = S.sel ? node(S.sel) : null;
    if (last) {
      n.group = last.kind === 'start' ? (f.phases[0] || '') : last.group;
      f.edges.push({ from: last.id, to: n.id, label: '' });
    } else n.group = f.phases[0] || '';
    f.nodes.push(n);
    S.sel = n.id; S.selEdge = null;
    markDirty(); renderAll();
    toast(last ? ['Lade till ', ['b', n.title], ' efter ', ['b', last.title]]
      : ['Lade till ', ['b', n.title], ' · dra från punkten till höger för att koppla']);
  }

  function openMoreMenu(from) {
    const r = from.getBoundingClientRect();
    const st = skillState();
    openMenu(r.left, r.bottom + 4, from, (m) => {
      menuItem(m, null, 'Öppna SKILL.md i editorn', '', () => openSkillInEditor(),
        st === 'none' || !S.openInEditor || !S.cfgApi || typeof S.cfgApi.skillPath !== 'function');
      menuItem(m, null, 'Ta bort flödet…', '', () => deleteFlow(), !S.exists || typeof S.api.delete !== 'function');
    });
  }
  async function openSkillInEditor() {
    await flush();
    let p = null;
    try {
      const r = await S.cfgApi.skillPath({ name: S.slug });
      p = typeof r === 'string' ? r : r && typeof r.path === 'string' ? r.path : null;
    } catch (_) { p = null; }
    if (!p) { toast(['Kunde inte öppna SKILL.md']); return; }
    S.openInEditor(p);
  }
  async function deleteFlow() {
    const name = S.flow ? S.flow.name : S.slug;
    const ok = await S.confirm({
      title: 'Ta bort flödet ' + name + '?',
      message: 'Filen ~/.claude/flows/' + S.slug + '.json tas bort. En säkerhetskopia sparas i ~/.claude/backups/mac-code.\n\n' +
        'skills/' + S.slug + '/SKILL.md tas inte bort; ta bort skillen under Claude-konfiguration om du vill bli av med den.',
      okLabel: 'Ta bort', danger: true
    });
    if (!ok) return;
    const r = await flush();
    if (!r.ok && !r.conflict) {
      const go = await S.confirm({ title: 'Ta bort ändå?', message: 'Den senaste ändringen kunde inte sparas: ' + (r.error || 'okänt fel'), okLabel: 'Ta bort', danger: true });
      if (!go) return;
    }
    const slug = S.slug;
    const res = await enqueue(() => flowCall('delete', { slug, rev: S.rev }));
    if (res.ok) {
      S.flow = null; S.slug = null; S.dirty = false; S.conflict = false; S.saveErr = null; S.invalid = false;
      await loadList();
      clearWorld();
      const entries = pickerEntries();
      const next = entries.find((x) => x.slug === 'orchestrate') || entries[0];
      if (next) await openFlow(next.slug);
      renderAll();
      toast(['Tog bort flödet ', ['b', name]]);
    } else if (res.conflict) {
      S.conflict = true; paintAll();
      toast(['Filen ändrades utanför Mac Code. Inget togs bort.']);
    } else toast(['Kunde inte ta bort flödet: ' + (res.error || 'okänt fel')]);
  }

  // ---------- drawer ----------
  function fk(n, key) { n.dataset.feFocus = key; return n; }
  function field(parent, label, input, key, hint) {
    const f = el('div', 'fe-f');
    const id = 'fe-in' + (++fieldSeq);
    const l = el('label', null, label);
    l.htmlFor = id;
    input.id = id;
    if (key) fk(input, key);
    f.appendChild(l);
    f.appendChild(input);
    if (hint) { const h = el('div', 'fe-hint', hint); f.appendChild(h); f.hintEl = h; }
    parent.appendChild(f);
    return f;
  }
  function selectEl(opts, val, on) {
    const s = el('select', 'set-select');
    for (const [v, l] of opts) { const o = el('option', null, l); o.value = v; s.appendChild(o); }
    s.value = val;
    s.addEventListener('change', () => on(s.value));
    return s;
  }
  function textInput(val, on, o) {
    const i = el('input', 'set-input' + (o && o.mono ? ' mono' : ''));
    i.type = 'text';
    i.spellcheck = false;
    i.autocomplete = 'off';
    i.value = val;
    i.maxLength = (o && o.max) || CAP.text;
    if (o && o.placeholder) i.placeholder = o.placeholder;
    if (o && o.readOnly) i.readOnly = true;
    else i.addEventListener('input', () => on(i.value.replace(/[\r\n]+/g, ' ')));
    return i;
  }
  function textArea(val, on, o) {
    const t = el('textarea', 'set-input fe-ta' + (o && o.mono ? ' mono' : ''));
    t.spellcheck = false;
    t.value = val;
    t.rows = (o && o.rows) || 4;
    t.maxLength = (o && o.max) || CAP.text;
    if (o && o.placeholder) t.placeholder = o.placeholder;
    t.addEventListener('input', () => on(t.value));
    return t;
  }
  function dsec(parent, text) { parent.appendChild(el('div', 'fe-dsec', text)); }

  // A refused save names its field ('nodes[3].instr', 'description', 'edges[2].label' …):
  // mark that step's card and, when its panel is open, the input itself.
  function fieldTarget(field) {
    const f = str(field);
    let m = f.match(/^nodes\[(\d+)\](?:\.(\w+))?/);
    if (m && S.flow) {
      const n = S.flow.nodes[Number(m[1])];
      const map = { title: 'n:title', sub: 'n:sub', instr: 'n:instr', agent: 'n:agent', model: 'n:model', group: 'n:phase', rounds: 'n:rounds', hooks: 'hook:add' };
      return n ? { nodeId: n.id, key: map[m[2]] || null } : null;
    }
    m = f.match(/^edges\[(\d+)\]/);
    if (m) return { edge: Number(m[1]), key: S.selEdge === Number(m[1]) ? 'edge:label' : 'path:' + m[1] };
    const start = S.flow && S.flow.nodes.find((n) => n.kind === 'start');
    const top = { name: 'start:name', description: 'start:desc', preamble: 'start:pre' }[f];
    if (top && start) return { nodeId: start.id, key: top };
    return null;
  }
  function paintFieldError() {
    if (!R || R.noApi) return;
    const t = S.invalidMsg ? fieldTarget(S.saveField) : null;
    R.nodeEls.forEach((e, id) => e.classList.toggle('bad', !!(t && t.nodeId === id)));
    R.drawer.querySelectorAll('.fe-bad').forEach((x) => { x.classList.remove('fe-bad'); x.removeAttribute('aria-invalid'); });
    if (R.drawerNote && R.drawerNote.isConnected) {
      R.drawerNote.textContent = S.invalidMsg ? 'Inte sparat: ' + S.invalidMsg : '';
      R.drawerNote.hidden = !S.invalidMsg;
    }
    if (t && t.key) {
      const inp = R.drawer.querySelector('[data-fe-focus="' + CSS.escape(t.key) + '"]');
      if (inp) { inp.classList.add('fe-bad'); inp.setAttribute('aria-invalid', 'true'); }
    }
    paintBanner();
  }

  function renderDrawer() {
    if (!R || R.noApi) return;
    const d = R.drawer;
    const a = document.activeElement;
    const focusKey = a && d.contains(a) ? a.dataset.feFocus : null;
    const n = S.sel && node(S.sel);
    const edge = S.selEdge != null && S.flow ? S.flow.edges[S.selEdge] : null;
    d.textContent = '';
    d.classList.toggle('open', !!(n || edge));
    d.setAttribute('aria-hidden', String(!(n || edge)));
    if (n) { if (n.kind === 'start') drawStart(d); else drawNode(d, n); }
    else if (edge) drawEdge(d, edge, S.selEdge);
    paintFieldError();
    if (focusKey) {
      const t = d.querySelector('[data-fe-focus="' + CSS.escape(focusKey) + '"]');
      if (t) t.focus();
    }
  }

  function drawerHead(d, kind, kindLabel, title, onClose) {
    const h = el('div', 'fe-dh');
    const ic = el('div', 'fe-ic k-' + kind, ICON[kind] || '→');
    ic.setAttribute('aria-hidden', 'true');
    const t = el('div', 'fe-dh-t');
    t.appendChild(el('div', 'fe-dh-k', kindLabel));
    const b = el('div', 'fe-dh-title', title);
    t.appendChild(b);
    const x = btn('set-x fe-dh-x', '×', onClose, 'Stäng panelen');
    h.appendChild(ic); h.appendChild(t); h.appendChild(x);
    d.appendChild(h);
    const note = el('div', 'set-row-note err fe-dnote');
    note.setAttribute('role', 'alert');
    note.hidden = true;
    d.appendChild(note);
    R.drawerNote = note;
    return b;
  }
  const closeDrawer = () => {
    const id = S.sel;
    S.sel = null; S.selEdge = null; S.form = null;
    renderAll();
    const e = id && R.nodeEls.get(id);
    if (e) e.focus(); else R.canvas.focus();
  };

  // Start node: the flow's own fields (R9).
  function drawStart(d) {
    const f = S.flow;
    const head = drawerHead(d, 'start', 'Flöde', f.name || S.slug, closeDrawer);
    field(d, 'Namn', textInput(f.name, (v) => { f.name = v; head.textContent = v || S.slug; markDirty(); paintBar(); }, { max: 200 }), 'start:name');
    field(d, 'Kommando', textInput('/' + S.slug, null, { readOnly: true, mono: true }), 'start:slug',
      'Kommandot följer filnamnet och går inte att ändra.');
    let fld = null;
    const counter = () => {
      const len = f.description.trim().length;
      if (!fld || !fld.hintEl) return;
      fld.hintEl.textContent = len ? len + ' / ' + CAP.desc + ' tecken. Claude läser den för att avgöra när skillen ska användas.'
        : 'Krävs. Claude läser beskrivningen för att avgöra när skillen ska användas.';
      fld.hintEl.classList.toggle('err', !len);
    };
    fld = field(d, 'Beskrivning', textArea(f.description, (v) => { f.description = v; markDirty(); counter(); }, { rows: 4, max: CAP.desc }), 'start:desc', ' ');
    counter();
    field(d, 'Regler', textArea(f.preamble, (v) => { f.preamble = v; markDirty(); }, { rows: 12, max: CAP.preamble, mono: true,
      placeholder: 'Regler som gäller hela flödet (markdown)' }), 'start:pre',
    'Skrivs först i SKILL.md, före stegen.');
    d.appendChild(el('div', 'fe-hint', 'Startsteget går inte att ta bort. Dra från punkten till höger på kortet för att koppla det.'));
  }

  function phaseOptions(f) { return f.phases.map((p) => [p, p]); }

  function drawNode(d, n) {
    const f = S.flow;
    const head = drawerHead(d, n.kind, KIND[n.kind] + (n.group ? ' · ' + n.group : ''), n.title || '(namnlöst)', closeDrawer);
    field(d, 'Namn', textInput(n.title, (v) => { n.title = v; head.textContent = v || '(namnlöst)'; markDirty(); paintNode(n); }, { max: 200 }), 'n:title');

    // Phase, with an inline "+ Ny fas"
    const opts = [['', '(ingen fas)']].concat(phaseOptions(f));
    if (n.group && !f.phases.includes(n.group)) opts.push([n.group, n.group]);
    if (f.phases.length < CAP.phases) opts.push(['__new', '+ Ny fas…']);
    field(d, 'Fas', selectEl(opts, n.group, (v) => {
      if (v === '__new') { S.form = { kind: 'newPhase', nodeId: n.id, value: '', error: null }; renderDrawer(); focusKey('phase:name'); return; }
      n.group = v;
      delete f.pos[n.id];
      markDirty(); renderAll();
      toast(['Flyttade ', ['b', n.title], ' till ' + (n.group || 'ingen fas')]);
    }), 'n:phase');
    if (S.form && S.form.kind === 'newPhase' && S.form.nodeId === n.id) drawPhaseForm(d, n);

    if (n.kind === 'agent') {
      const ids = agentIds();
      if (n.agent && !ids.includes(n.agent)) ids.push(n.agent);
      const aOpts = ids.map((a) => [a, a]);
      if (!n.agent) aOpts.unshift(['', '(välj agent)']);
      const dm = agentDefaultModel(n.agent);
      field(d, 'Agent', selectEl(aOpts, n.agent, (v) => { n.agent = v; markDirty(); renderAll(); }), 'n:agent',
        n.agent && !agentDefaultModel(n.agent) && !BUILTIN_AGENTS.includes(n.agent) ? 'Agenten finns inte i ~/.claude/agents.' : null);
      const mOpts = MODELS.slice();
      if (n.model && !mOpts.some((m) => m[0] === n.model)) mOpts.push([n.model, n.model]);
      field(d, 'Modell', selectEl(mOpts, n.model, (v) => { n.model = v; markDirty(); paintNode(n); }), 'n:model',
        dm ? 'Agentens standard: ' + dm + '. Ett val här skrivs som modell för steget i SKILL.md; agentfilen ändras inte.' : 'Ett val här skrivs som modell för steget i SKILL.md.');
      field(d, 'Om agenten hittar fel', selectEl([['0', 'Gå vidare'], ['1', 'Rätta och kör om, max 1 gång'], ['2', 'Rätta och kör om, max 2 gånger'], ['3', 'Rätta och kör om, max 3 gånger']],
        String(n.rounds || 0), (v) => { n.rounds = Number(v); markDirty(); paintNode(n); }), 'n:rounds');
      field(d, 'Instruktion', textArea(n.instr, (v) => { n.instr = v; markDirty(); }, { rows: 5, placeholder: 'Vad agenten ska göra' }), 'n:instr');
    } else {
      field(d, 'Text på kortet', textInput(n.sub, (v) => { n.sub = v; markDirty(); paintNode(n); }, { max: 200 }), 'n:sub');
      const lab = n.kind === 'check' ? 'Villkor' : n.kind === 'ask' ? 'Fråga' : 'Instruktion';
      const ph = n.kind === 'check' ? 'Vad som avgör vilken väg som gäller' : n.kind === 'ask' ? 'Vad Claude ska fråga dig om' : 'Vad Claude ska göra';
      field(d, lab, textArea(n.instr, (v) => { n.instr = v; markDirty(); }, { rows: 5, placeholder: ph }), 'n:instr');
    }

    const outs = f.edges.map((e, i) => ({ e, i })).filter((x) => x.e.from === n.id);
    if (outs.length > 1 || n.kind === 'check' || n.kind === 'ask') {
      dsec(d, 'Vägar ut');
      if (!outs.length) d.appendChild(el('div', 'fe-hint', 'Inga vägar ut ännu. Dra från punkten till höger på kortet.'));
      for (const { e, i } of outs) {
        const target = node(e.to);
        const row = el('div', 'fe-path');
        const inp = textInput(e.label, (v) => { e.label = v; markDirty(); }, { placeholder: 'namn på vägen', max: 200 });
        inp.addEventListener('change', () => drawEdges());
        field(row, '→ ' + (target ? target.title : e.to), inp, 'path:' + i);
        row.appendChild(btn('fe-x', '×', () => deleteEdge(i), 'Ta bort vägen till ' + (target ? target.title : e.to)));
        d.appendChild(row);
      }
    }

    drawHooks(d, n);

    const del = btn('set-btn sm fe-del', 'Ta bort steget', () => deleteNode(n));
    fk(del, 'n:del');
    d.appendChild(del);
  }

  function drawPhaseForm(d, n) {
    const f = S.flow;
    const form = S.form;
    const box = el('div', 'fe-mini');
    const inp = textInput(form.value, (v) => { form.value = v; }, { max: 60, placeholder: 'Fasens namn' });
    const submit = () => {
      const name = form.value.trim();
      if (!name) { form.error = 'Skriv ett namn.'; renderDrawer(); focusKey('phase:name'); return; }
      if (f.phases.includes(name)) { form.error = 'Fasen finns redan.'; renderDrawer(); focusKey('phase:name'); return; }
      f.phases.push(name);
      n.group = name;
      delete f.pos[n.id];
      S.form = null;
      markDirty(); renderAll();
      focusKey('n:phase');
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    field(box, 'Ny fas', inp, 'phase:name');
    if (form.error) { const er = el('div', 'set-row-note err', form.error); er.setAttribute('role', 'alert'); box.appendChild(er); }
    const foot = el('div', 'fe-mini-foot');
    foot.appendChild(btn('set-btn sm ghost', 'Avbryt', () => { S.form = null; renderDrawer(); focusKey('n:phase'); }));
    foot.appendChild(btn('set-btn sm primary', 'Lägg till', submit));
    box.appendChild(foot);
    d.appendChild(box);
  }

  function focusKey(key) {
    if (!R) return;
    const t = R.root.querySelector('[data-fe-focus="' + CSS.escape(key) + '"]');
    if (t) t.focus();
  }

  function allHooks() {
    const on = (S.cfg && Array.isArray(S.cfg.hooks) ? S.cfg.hooks : []).map((h) => ({ h, off: false }));
    const off = (S.cfg && Array.isArray(S.cfg.disabled) ? S.cfg.disabled : []).map((h) => ({ h, off: true }));
    return on.concat(off).filter((x) => str(x.h.type || 'command') === 'command' && str(x.h.command));
  }
  function hookLabel(h, off) {
    return hookName(h.command) + ' · ' + str(h.event) + (str(h.matcher) ? ' ' + str(h.matcher) : '') + (off ? ' (av)' : '');
  }

  function drawHooks(d, n) {
    dsec(d, 'Hooks på steget');
    if (!S.cfg) {
      d.appendChild(el('div', 'fe-hint', S.cfgErr ? 'Hooks kunde inte läsas: ' + S.cfgErr : 'Läser in hooks…'));
    }
    if (!n.hooks.length) d.appendChild(el('div', 'fe-hint', 'Inga hooks.'));
    const choices = allHooks();
    n.hooks.forEach((ref, idx) => {
      const r = resolveRef(ref, S.cfg);
      const row = el('div', 'fe-hk' + (r.state === 'missing' ? ' missing' : r.state === 'off' ? ' off' : ''));
      const hn = el('div', 'fe-hn', hookName(ref.command) + (r.many ? ' (flera)' : ''));
      hn.title = ref.command;
      const small = el('small', null, ref.event + (ref.matcher ? ' · ' + ref.matcher : '') +
        (r.state === 'off' ? ' · avstängd' : r.state === 'missing' && S.cfg ? ' · saknas' : ''));
      hn.appendChild(small);
      row.appendChild(hn);
      row.appendChild(btn('fe-x', '×', () => {
        n.hooks.splice(idx, 1);
        markDirty(); renderAll(); focusKey('hook:add');
      }, 'Koppla bort ' + hookName(ref.command)));
      d.appendChild(row);
      if (r.state === 'missing' && S.cfg && choices.length) {
        const opts = [['', 'Koppla om…']].concat(choices.map((c, i) => [String(i), hookLabel(c.h, c.off)]));
        const s = selectEl(opts, '', (v) => {
          const c = choices[Number(v)];
          if (!c) return;
          n.hooks[idx] = trimRef(c.h);
          markDirty(); renderAll();
        });
        s.classList.add('fe-relink');
        s.setAttribute('aria-label', 'Koppla om ' + hookName(ref.command));
        fk(s, 'hook:relink:' + idx);
        d.appendChild(s);
      }
    });
    if (S.cfg) {
      const attached = new Set(n.hooks.map(refKey));
      const avail = choices.filter((c) => !attached.has(refKey(c.h)));
      const canAdd = !S.cfg.settingsError;
      const opts = [['', '+ Koppla hook…']].concat(avail.map((c, i) => [String(i), hookLabel(c.h, c.off)]));
      if (canAdd) opts.push(['__new', 'Ny hook…']);
      const s = selectEl(opts, '', (v) => {
        if (v === '__new') {
          S.form = { kind: 'newHook', nodeId: n.id, values: { event: 'PreToolUse', matcher: '', command: '' }, error: null };
          renderDrawer(); focusKey('hook:event');
          return;
        }
        const c = avail[Number(v)];
        if (!c) return;
        n.hooks.push(trimRef(c.h));
        markDirty(); renderAll(); focusKey('hook:add');
      });
      s.classList.add('fe-hookadd');
      s.setAttribute('aria-label', 'Koppla hook');
      fk(s, 'hook:add');
      d.appendChild(s);
      if (S.cfg.settingsError) d.appendChild(el('div', 'set-row-note warn', 'settings.json kunde inte läsas, så nya hooks kan inte läggas till.'));
      if (S.form && S.form.kind === 'newHook' && S.form.nodeId === n.id) drawHookForm(d, n);
    }
  }

  function drawHookForm(d, n) {
    const form = S.form;
    const v = form.values;
    const box = el('div', 'fe-mini');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Ny hook');
    box.appendChild(el('div', 'fe-mini-title', 'Ny hook'));
    const evs = HOOK_EVENTS.slice();
    for (const c of allHooks()) if (c.h.event && !evs.includes(str(c.h.event))) evs.push(str(c.h.event));
    field(box, 'Händelse', selectEl(evs.map((e) => [e, e]), v.event, (x) => { v.event = x; }), 'hook:event');
    field(box, 'Matcher', textInput(v.matcher, (x) => { v.matcher = x; }, { mono: true, placeholder: 'Tomt = alla, t.ex. Bash|Edit' }), 'hook:matcher');
    const cmd = textInput(v.command, (x) => { v.command = x; }, { mono: true, placeholder: 'node "C:\\…\\.claude\\hooks\\script.js"' });
    cmd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitHookForm(n); } });
    field(box, 'Kommando', cmd, 'hook:command');
    box.appendChild(el('div', 'fe-hint', 'Sparas i ~/.claude/settings.json och körs i varje Claude-session. Mac Code visar kommandot och frågar en gång till.'));
    if (form.error) { const er = el('div', 'set-row-note err', form.error); er.setAttribute('role', 'alert'); box.appendChild(er); }
    const foot = el('div', 'fe-mini-foot');
    foot.appendChild(btn('set-btn sm ghost', 'Avbryt', () => { S.form = null; renderDrawer(); focusKey('hook:add'); }));
    const sb = btn('set-btn sm primary', form.busy ? 'Sparar…' : 'Lägg till', () => submitHookForm(n));
    sb.disabled = !!form.busy;
    fk(sb, 'hook:submit');
    foot.appendChild(sb);
    box.appendChild(foot);
    d.appendChild(box);
  }

  async function submitHookForm(n) {
    const form = S.form;
    if (!form || form.kind !== 'newHook' || form.busy) return;
    const ref = trimRef(form.values);
    if (!/^[A-Za-z]{1,40}$/.test(ref.event)) { form.error = 'Välj en händelse.'; renderDrawer(); return; }
    if (!ref.command) { form.error = 'Skriv ett kommando.'; renderDrawer(); focusKey('hook:command'); return; }
    form.busy = true; form.error = null;
    renderDrawer();
    const res = await cfgCall('hookAdd', { event: ref.event, matcher: ref.matcher, command: ref.command, timeout: null,
      settingsRev: S.cfg ? S.cfg.settingsRev : undefined });
    form.busy = false;
    if (res.ok) {
      if (S.form === form) S.form = null;
      const target = node(n.id);
      if (target && !target.hooks.some((h) => refKey(h) === refKey(ref))) { target.hooks.push(ref); markDirty(); }
      await loadCfg();
      renderAll();
      focusKey('hook:add');
      toast(['La till hooken ', ['b', hookName(ref.command)]]);
      return;
    }
    if (res.canceled) { renderDrawer(); focusKey('hook:submit'); return; }
    if (res.conflict) {
      form.error = 'settings.json ändrades utanför Mac Code. Läste om; försök igen.';
      await loadCfg();
    } else form.error = 'Kunde inte spara hooken: ' + (res.error || 'okänt fel');
    renderAll();
    focusKey('hook:submit');
  }

  function drawEdge(d, e, i) {
    const from = node(e.from), to = node(e.to);
    drawerHead(d, 'step', 'Pil', (from ? from.title : e.from) + ' → ' + (to ? to.title : e.to), closeDrawer);
    field(d, 'Namn på vägen', textInput(e.label, (v) => { e.label = v; markDirty(); }, { max: 200, placeholder: 't.ex. ja, trivial, rör auth' }), 'edge:label')
      .querySelector('input').addEventListener('change', () => drawEdges());
    d.appendChild(el('div', 'fe-hint', 'Namnet visas på pilen och skrivs som väg i SKILL.md.'));
    const del = btn('set-btn sm fe-del', 'Ta bort pilen', () => deleteEdge(i));
    fk(del, 'edge:del');
    d.appendChild(del);
  }

  async function toggleHook(ref) {
    if (S.running) return;
    if (!S.cfg) { toast(['Hooks är inte inlästa']); return; }
    const r = resolveRef(ref, S.cfg);
    if (r.state === 'missing') { toast(['Hooken ', ['b', hookName(ref.command)], ' finns inte i settings.json. Koppla om den i stegets panel.']); return; }
    if (S.cfg.settingsError || S.cfg.disabledError) { toast(['Hooks kan inte slås av eller på just nu']); return; }
    const res = r.state === 'on'
      ? await cfgCall('hookDisable', { id: r.id, settingsRev: S.cfg.settingsRev })
      : await cfgCall('hookEnable', { disabledId: r.disabledId, settingsRev: S.cfg.settingsRev });
    if (res.canceled) return;
    if (!res.ok) toast([res.conflict ? 'settings.json ändrades utanför Mac Code. Läste om.' : 'Kunde inte ändra hooken: ' + (res.error || 'okänt fel')]);
    else toast([r.state === 'on' ? 'Stängde av ' : 'Slog på ', ['b', hookName(ref.command)], ' i alla Claude-sessioner']);
    await loadCfg();
    renderAll();
  }

  // ---------- new flow (R9) ----------
  function openNewFlowForm() {
    if (S.running) return;
    S.form = { kind: 'newFlow', name: '', description: '', error: null, busy: false };
    S.sel = null; S.selEdge = null;
    renderAll();
    focusKey('nf:name');
  }
  function newFlowProblem(slug) {
    if (!slug) return 'Skriv ett namn.';
    if (!slugOk(slug)) return 'Namnet måste ge ett kommando med a–z, 0–9 och -, högst 64 tecken.';
    if (S.flows.some((x) => x.slug === slug)) return 'Det finns redan ett flöde som heter /' + slug + '.';
    if (slug === 'orchestrate' && !S.hasOrchestrateFile) return '/orchestrate är det inbyggda flödet. Välj det i listan i stället.';
    // An existing skills/<slug> is main's call: one Mac Code generated is fine, a foreign
    // or linked one is refused by flowSave ({ exists:true }) with its own message.
    return null;
  }
  function renderPanel() {
    if (!R || R.noApi) return;
    const p = R.panel;
    const form = S.form && S.form.kind === 'newFlow' ? S.form : null;
    p.hidden = !form;
    const a = document.activeElement;
    const focus = a && p.contains(a) ? a.dataset.feFocus : null;
    p.textContent = '';
    if (!form) return;
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Nytt flöde');
    p.appendChild(el('div', 'fe-mini-title', 'Nytt flöde'));
    const slugLine = el('div', 'fe-hint');
    const paintSlug = () => {
      const slug = slugify(form.name);
      const prob = form.name.trim() ? newFlowProblem(slug) : null;
      slugLine.textContent = slug ? 'Startas med /' + slug + ' · sparas som ~/.claude/flows/' + slug + '.json' : 'Kommandot blir namnet med små bokstäver och bindestreck.';
      slugLine.classList.toggle('err', !!prob);
      if (prob) slugLine.textContent += ' · ' + prob;
    };
    const name = textInput(form.name, (v) => { form.name = v; paintSlug(); }, { max: 80, placeholder: 't.ex. Bugfix' });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitNewFlow(); } });
    field(p, 'Namn', name, 'nf:name');
    p.appendChild(slugLine);
    paintSlug();
    field(p, 'Beskrivning', textArea(form.description, (v) => { form.description = v; }, { rows: 3, max: CAP.desc,
      placeholder: 'När Claude ska använda flödet' }), 'nf:desc', 'Krävs. Blir skillens beskrivning.');
    if (form.error) { const er = el('div', 'set-row-note err', form.error); er.setAttribute('role', 'alert'); p.appendChild(er); }
    const foot = el('div', 'fe-mini-foot');
    foot.appendChild(btn('set-btn sm ghost', 'Avbryt', () => { S.form = null; renderPanel(); R.picker.focus(); }));
    const sb = btn('set-btn sm primary', form.busy ? 'Skapar…' : 'Skapa', submitNewFlow);
    sb.disabled = form.busy;
    fk(sb, 'nf:submit');
    foot.appendChild(sb);
    p.appendChild(foot);
    if (focus) focusKey(focus);
  }
  async function submitNewFlow() {
    const form = S.form;
    if (!form || form.kind !== 'newFlow' || form.busy) return;
    const slug = slugify(form.name);
    const description = form.description.trim();
    let err = newFlowProblem(slug);
    if (!err && !description) err = 'Skriv en beskrivning. Claude använder den för att välja flödet.';
    if (err) { form.error = err; renderPanel(); focusKey('nf:submit'); return; }
    form.busy = true; form.error = null;
    renderPanel();
    const r = await flush();
    if (!r.ok) { form.busy = false; form.error = 'Det öppna flödet är inte sparat: ' + (r.error || 'okänt fel'); renderPanel(); return; }
    const flow = {
      v: 1, slug, name: form.name.trim().replace(/[\r\n]+/g, ' '), description, preamble: '', phases: ['Fas 1'],
      nodes: [{ id: 'start', kind: 'start', title: '/' + slug, sub: '', group: '', agent: '', model: '', rounds: 0, instr: '', hooks: [] }],
      edges: [], pos: {}
    };
    const res = await enqueue(() => flowCall('save', { slug, flow, rev: null }));
    form.busy = false;
    if (!res.ok) {
      form.error = res.exists && res.conflict ? 'Namnet är upptaget: det finns redan ett flöde som heter /' + slug + '.'
        : res.exists ? (str(res.error) || 'Det finns redan en skill som heter ' + slug + '.')
        : 'Kunde inte skapa flödet: ' + (res.error || 'okänt fel');
      renderPanel();
      return;
    }
    S.form = null;
    await loadList();
    await openFlow(slug);
    S.sel = 'start';
    renderAll();
    toast(['Skapade ', ['b', '/' + slug], ' · lägg till steg med +']);
  }

  // ---------- Skriv SKILL.md ----------
  async function writeSkillFlow() {
    if (!S.flow || S.running) return;
    if (!S.flow.description.trim()) {
      S.sel = S.flow.nodes.find((n) => n.kind === 'start').id; S.selEdge = null;
      renderAll(); focusKey('start:desc');
      toast(['Skriv en ', ['b', 'beskrivning'], ' för flödet först']);
      return;
    }
    // The built-in default has no file yet: create it first (R4).
    if (!S.exists) { S.dirty = true; S.gen++; }
    const r = await flush();
    if (!r.ok) { paintAll(); toast(['Flödet är inte sparat: ' + (r.error || 'okänt fel')]); return; }
    const pv = await enqueue(() => flowCall('preview', { slug: S.slug }));
    if (!pv.ok) { toast(['Kunde inte förhandsvisa: ' + (pv.error || 'okänt fel')]); return; }
    showPreview(pv);
  }

  function showPreview(pv) {
    const prev = document.activeElement;
    const st = SKILL_WORDS[pv.skillState] ? pv.skillState : 'none';
    const overlay = el('div', 'set-overlay set-overlay-top show');
    const box = el('div', 'set-confirm fe-preview');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = el('div', 'set-confirm-title', 'Skriv SKILL.md för /' + S.slug);
    title.id = 'fe-pv-title-' + Date.now();
    box.setAttribute('aria-labelledby', title.id);
    box.appendChild(title);
    const meta = el('div', 'set-path', str(pv.skillPath) || 'skills/' + S.slug + '/SKILL.md');
    meta.title = str(pv.skillPath);
    box.appendChild(meta);
    const lines = Number.isFinite(pv.lines) ? pv.lines : str(pv.markdown).split('\n').length;
    box.appendChild(el('div', 'fe-hint', lines + ' rader · nuvarande fil: ' + SKILL_WORDS[st]));
    let warn = null;
    if (st === 'edited') warn = 'SKILL.md har ändrats för hand sedan Mac Code skrev den senast — den sparas som backup och skrivs över.';
    else if (st === 'foreign') warn = 'SKILL.md skapades inte av Mac Code — den sparas som backup och skrivs över.';
    else if (st === 'linked') warn = 'Skillen är länkad till en annan mapp — Mac Code skriver inte där.';
    if (st === 'linked' && pv.linkedTarget) warn = 'Skillen är länkad till ' + str(pv.linkedTarget) + ' — Mac Code skriver inte där.';
    if (warn) { const w = el('div', 'set-row-note ' + (st === 'linked' ? 'err' : 'warn'), warn); w.setAttribute('role', 'alert'); box.appendChild(w); }
    if (pv.atInclude) box.appendChild(el('div', 'set-row-note warn', 'Texten innehåller @sökväg — Claude läser in den filen när skillen används.'));
    if (Number.isFinite(pv.added) && Number.isFinite(pv.removed) && st !== 'none') {
      box.appendChild(el('div', 'fe-hint', '+' + pv.added + ' / −' + pv.removed + ' rader mot nuvarande fil'));
    }
    const pre = el('pre', 'fe-pre scroll', str(pv.markdown));
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', 'Förhandsvisning av SKILL.md');
    box.appendChild(pre);
    const err = el('div', 'set-row-note err');
    err.hidden = true;
    err.setAttribute('role', 'alert');
    box.appendChild(err);
    const foot = el('div', 'set-confirm-foot');
    const cancel = btn('set-btn', 'Avbryt', () => finish());
    foot.appendChild(cancel);
    let ok = null;
    if (st !== 'linked') {
      const over = st === 'edited' || st === 'foreign';
      ok = btn('set-btn ' + (over ? 'danger' : 'primary'), over ? 'Skriv över' : 'Skriv', async () => {
        ok.disabled = true;
        err.hidden = true;
        const res = await enqueue(() => flowCall('writeSkill', { slug: S.slug, rev: S.rev }));
        if (!overlay.isConnected) return;
        ok.disabled = false;
        if (res.ok) {
          if (typeof res.rev === 'string') S.rev = res.rev;
          finish();
          await loadList();
          paintStatus();
          toast(['Skrev ', ['b', 'skills/' + S.slug + '/SKILL.md']]);
        } else if (res.canceled) {
          // Avbryt in main's own confirm: nothing was written.
        } else if (res.conflict && res.skillChanged) {
          err.textContent = 'SKILL.md ändrades medan dialogen var öppen. Stäng och förhandsvisa igen.';
          err.hidden = false;
          ok.disabled = true;
        } else if (res.conflict) {
          S.conflict = true;
          finish();
          paintAll();
        } else {
          err.textContent = 'Kunde inte skriva: ' + (res.error || 'okänt fel');
          err.hidden = false;
        }
      });
      foot.appendChild(ok);
    }
    box.appendChild(foot);
    overlay.appendChild(box);
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      overlay.remove();
      if (prev && prev.isConnected) { try { prev.focus(); } catch (_) {} }
    }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      else if (e.key === 'Tab') {
        const list = [...box.querySelectorAll('button, [tabindex="0"]')].filter((n) => !n.disabled);
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      e.stopPropagation();
    });
    document.body.appendChild(overlay);
    (warn || !ok ? cancel : ok).focus();
  }

  // ---------- test run (simulation only) ----------
  function stopRun() { S.runTok++; }
  async function testRun() {
    const f = S.flow;
    if (!f || S.running) return;
    const tok = ++S.runTok;
    S.running = true;
    S.sel = null; S.selEdge = null; S.form = null;
    S.sim = { run: new Set(), done: new Set(), edges: new Set() };
    const cls = R.cls.value;
    renderAll();
    const seen = new Set();
    const live = () => R && tok === S.runTok && S.flow === f;
    async function visit(id, viaIdx) {
      const n = node(id);
      if (!n || seen.has(id) || !live()) return;
      seen.add(id);
      if (viaIdx != null) S.sim.edges.add(viaIdx);
      S.sim.run.add(id);
      renderCanvas();
      const dm = agentDefaultModel(n.agent);
      const model = n.model || (dm && dm !== 'ärver sessionens' ? dm : 'sessionens');
      const hooks = n.hooks.filter((h) => resolveRef(h, S.cfg).state === 'on').map((h) => hookName(h.command));
      toast((n.kind === 'agent' ? ['Agent ', ['b', n.agent || '?'], ' (' + model + ')'] : [['b', n.title]])
        .concat(hooks.length ? [' · hooks: ' + hooks.join(', ')] : []));
      await sleep(700);
      if (!live()) return;
      if (viaIdx != null) S.sim.edges.delete(viaIdx);
      S.sim.run.delete(id);
      S.sim.done.add(id);
      renderCanvas();
      const outs = f.edges.map((e, i) => Object.assign({ i }, e)).filter((e) => e.from === id);
      const next = simPick(n, outs, cls);
      const workers = next.length > 1 && next.every((e) => { const t = node(e.to); return t && t.kind === 'agent' && /-dev$/.test(t.agent); });
      if (workers && cls !== 'risky') { for (const e of next) await visit(e.to, e.i); }
      else await Promise.all(next.map((e) => visit(e.to, e.i)));
    }
    const start = f.nodes.find((n) => n.kind === 'start');
    if (start) await visit(start.id, null);
    const finished = live();
    S.running = false;
    S.sim.edges.clear(); S.sim.run.clear();
    if (!R) return;
    renderAll();
    toast(finished ? ['Simuleringen klar som ', ['b', cls], ' · inget kördes på riktigt'] : ['Simuleringen stoppad']);
    setTimeout(() => { if (!S.running) { S.sim.done.clear(); if (R && S.flow) renderCanvas(); } }, 2500);
  }

  window.FlowEditor = {
    mount, unmount, flush, consumesEsc,
    _test: { slugify, slugOk, trimRef, refKey, resolveRef, hookName, unreachable, autoLayout, dagEdges, bridgeLabel, simPick, normalizeFlow }
  };
})();
