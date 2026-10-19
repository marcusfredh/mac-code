const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// flowEditor.js is a browser IIFE; its pure helpers are reachable without a DOM.
function load(withCompile) {
  const win = {};
  const ctx = { window: win, Promise, setTimeout, clearTimeout };
  if (withCompile) win.flowCompile = require('../flowCompile.js');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'flowEditor.js'), 'utf8'), ctx);
  return win.FlowEditor;
}
const FE = load(false);
const T = FE._test;
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects from the vm realm

test('FlowEditor exposes mount / unmount / flush / consumesEsc', () => {
  for (const k of ['mount', 'unmount', 'flush', 'consumesEsc']) assert.strictEqual(typeof FE[k], 'function', k);
  assert.strictEqual(FE.consumesEsc(), false); // nothing mounted
});

test('slugify: Swedish letters, separators, length; matches flowCompile.slugFromName', () => {
  assert.strictEqual(T.slugify('Städa Över'), 'stada-over');
  assert.strictEqual(T.slugify('  Bug fix!! (v2) '), 'bug-fix-v2');
  assert.strictEqual(T.slugify('Ärende — åtgärd'), 'arende-atgard');
  assert.strictEqual(T.slugify('x'.repeat(80)).length, 64);
  assert.ok(T.slugOk('bugfix') && !T.slugOk('-x') && !T.slugOk('Bug'));
  const withFc = load(true)._test;
  for (const name of ['Städa Över', 'Bug fix!! (v2)', 'Ärende — åtgärd', 'café olé']) {
    assert.strictEqual(T.slugify(name), withFc.slugify(name), name);
  }
});

test('resolveRef: trimmed fingerprint against active, disabled, duplicates, missing', () => {
  const data = {
    hooks: [
      { id: 'a1', event: 'PreToolUse', matcher: 'Bash', command: 'node g.js' },
      { id: 'a2', event: 'PreToolUse', matcher: 'Bash', command: 'node g.js' }
    ],
    disabled: [{ id: 'd1', event: 'Stop', matcher: '', command: 'node stop.js' }]
  };
  assert.deepStrictEqual(plain(T.resolveRef({ event: ' PreToolUse', matcher: 'Bash ', command: ' node g.js ' }, data)), { state: 'on', id: 'a1', many: true });
  assert.deepStrictEqual(plain(T.resolveRef({ event: 'Stop', matcher: null, command: 'node stop.js' }, data)), { state: 'off', disabledId: 'd1', many: false });
  assert.strictEqual(T.resolveRef({ event: 'Stop', matcher: '', command: 'node other.js' }, data).state, 'missing');
  assert.strictEqual(T.resolveRef({ event: 'Stop', matcher: '', command: 'x' }, null).state, 'missing');
});

test('hookName: script base name plus arguments', () => {
  assert.strictEqual(T.hookName('node "C:\\Users\\x\\.claude\\hooks\\orchestrate-gate.js" pre'), 'orchestrate-gate pre');
  assert.strictEqual(T.hookName('node C:/h/worktree-guard.js'), 'worktree-guard');
  assert.strictEqual(T.hookName(''), '(tomt kommando)');
  assert.ok(T.hookName('echo ' + 'y'.repeat(60)).endsWith('…'));
});

const flow = () => ({
  phases: ['A', 'B'],
  nodes: [
    { id: 's', kind: 'start', group: '' },
    { id: 'c', kind: 'check', group: 'A' },
    { id: 'x', kind: 'step', group: 'A' },
    { id: 'y', kind: 'step', group: 'B' },
    { id: 'z', kind: 'step', group: '' }
  ],
  edges: [{ from: 's', to: 'c', label: '' }, { from: 'c', to: 'x', label: 'trivial' }, { from: 'c', to: 'y', label: 'normal · risky' }]
});

test('unreachable: nodes not reachable from start', () => {
  assert.deepStrictEqual(plain(T.unreachable(flow())), ['z']);
});

test('autoLayout: every node placed, phases left to right, columns within a phase', () => {
  const f = flow();
  const pos = T.autoLayout(f);
  for (const n of f.nodes) assert.ok(Number.isFinite(pos[n.id].x) && Number.isFinite(pos[n.id].y), n.id);
  assert.ok(pos.s.x < pos.c.x, 'start before phase A');
  assert.ok(pos.c.x < pos.x.x, 'check before its successor in the same phase');
  assert.ok(pos.x.x < pos.y.x, 'phase A before phase B');
  // cycles do not hang
  const cyc = { phases: [], nodes: [{ id: 'a', kind: 'start' }, { id: 'b', kind: 'step', group: 'P' }, { id: 'c', kind: 'step', group: 'P' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }] };
  assert.strictEqual(Object.keys(T.autoLayout(cyc)).length, 3);
});

test('autoLayout: a back edge (Granska diff → Backend) keeps phase order Planera < Bygg < Verifiera < Leverera', () => {
  const f = require('../flowCompile.js').defaultOrchestrateFlow();
  f.edges.push({ from: 'skdiff', to: 'be', label: 'fel' });
  const pos = T.autoLayout(f);
  const minX = (phase) => Math.min(...f.nodes.filter((n) => n.group === phase).map((n) => pos[n.id].x));
  const order = ['Planera', 'Bygg', 'Verifiera', 'Leverera'].map(minX);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], 'phase ' + i + ' after phase ' + (i - 1) + ': ' + order);
  assert.ok(pos.start.x < minX('Planera'), 'start first');
  // the back edge is the only one dropped
  const dag = plain(T.dagEdges(f));
  assert.strictEqual(dag.length, f.edges.length - 1);
  assert.ok(!dag.some((e) => e.from === 'skdiff' && e.to === 'be'));
  // same layout as without the back edge
  const g = require('../flowCompile.js').defaultOrchestrateFlow();
  assert.deepStrictEqual(plain(T.autoLayout(g)), plain(pos));
});

test('dagEdges: cycles not reachable from start are broken from the first unvisited node', () => {
  const f = { nodes: [{ id: 's', kind: 'start' }, { id: 'a', kind: 'step' }, { id: 'b', kind: 'step' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 's', to: 's' }] };
  assert.deepStrictEqual(plain(T.dagEdges(f)), [{ from: 'a', to: 'b' }]);
});

test('bridgeLabel: outgoing label wins, both are joined', () => {
  assert.strictEqual(T.bridgeLabel('', 'trivial'), 'trivial');
  assert.strictEqual(T.bridgeLabel('ja', ''), 'ja');
  assert.strictEqual(T.bridgeLabel('ja', 'risky'), 'ja · risky');
  assert.strictEqual(T.bridgeLabel(' ', null), '');
});

test('simPick: class labels, risky-only security path, ask takes ja', () => {
  const outs = [{ label: 'trivial', to: 'x' }, { label: 'normal · risky', to: 'y' }];
  assert.deepStrictEqual(plain(T.simPick({ kind: 'check' }, outs, 'trivial').map((e) => e.to)), ['x']);
  assert.deepStrictEqual(plain(T.simPick({ kind: 'check' }, outs, 'risky').map((e) => e.to)), ['y']);
  const sec = [{ label: '', to: 'diff' }, { label: 'rör auth/input/data…', to: 'sec' }];
  assert.deepStrictEqual(plain(T.simPick({ kind: 'step' }, sec, 'normal').map((e) => e.to)), ['diff']);
  assert.deepStrictEqual(plain(T.simPick({ kind: 'step' }, sec, 'risky').map((e) => e.to)), ['diff', 'sec']);
  assert.deepStrictEqual(plain(T.simPick({ kind: 'ask' }, [{ label: 'nej', to: 'n' }, { label: 'ja', to: 'j' }], 'normal').map((e) => e.to)), ['j']);
});

test('normalizeFlow: fills fields, drops dangling edges and stale positions, maps inherit to ""', () => {
  const f = T.normalizeFlow({
    name: 'X', nodes: [{ id: 's', kind: 'start' }, { id: 'a', kind: 'agent', model: 'inherit', hooks: [{ event: ' Stop ', command: ' c ' }] }],
    edges: [{ from: 's', to: 'a' }, { from: 's', to: 'gone' }], pos: { a: { x: 1, y: 2 }, gone: { x: 0, y: 0 }, s: { x: 'no' } },
    generated: { sha1: 'abc' }
  }, 'x');
  assert.strictEqual(f.slug, 'x');
  assert.strictEqual(f.nodes[1].model, '');
  assert.deepStrictEqual(plain(f.nodes[1].hooks), [{ event: 'Stop', matcher: '', command: 'c' }]);
  assert.strictEqual(f.edges.length, 1);
  assert.deepStrictEqual(plain(Object.keys(f.pos)), ['a']);
  assert.deepStrictEqual(plain(f.generated), { sha1: 'abc' });
  assert.strictEqual(f.description, '');
});

test('flowEditor.js builds DOM without innerHTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'flowEditor.js'), 'utf8');
  assert.ok(!/\.innerHTML\b|insertAdjacentHTML|outerHTML\s*=/.test(src));
});
