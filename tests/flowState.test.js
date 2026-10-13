const test = require('node:test');
const assert = require('node:assert');
const { deriveFlow, fmtDuration } = require('../flowState');

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;
const NO_FINDINGS = { blocker: 0, critical: 0, high: 0, major: 0, medium: 0, minor: 0, low: 0 };

function agent(over) {
  return {
    id: over.id || Math.random().toString(36).slice(2), type: 'skeptic', role: 'plan',
    status: 'done', startedAt: T0 + MIN, endedAt: T0 + 2 * MIN, verdict: null,
    findings: { ...NO_FINDINGS }, summary: null, ...over
  };
}

function state(flowOver = {}, over = {}) {
  return {
    sessionId: 's1', flowKey: 'k1', cwd: 'C:\\dev', updatedAt: T0 + 10 * MIN,
    ...over,
    flow: { startedAt: T0, endedAt: null, class: null, gate: 'none', waitingForUser: false, agents: [], tests: null, ...flowOver }
  };
}

const phase = (v, name) => v.phases.find(p => p.name === name);
const NOW = T0 + 10 * MIN;

test('no flow -> null', () => {
  assert.strictEqual(deriveFlow({}, NOW), null);
  assert.strictEqual(deriveFlow(null, NOW), null);
  assert.strictEqual(deriveFlow({ dirtyAt: T0 }, NOW), null);
});

test('plan only', () => {
  const v = deriveFlow(state(), NOW);
  assert.strictEqual(v.phases.length, 5);
  assert.strictEqual(phase(v, 'Plan').status, 'run');
  assert.strictEqual(phase(v, 'Skeptic').status, 'wait');
  assert.strictEqual(phase(v, 'Build').status, 'wait');
  assert.strictEqual(phase(v, 'Verify').status, 'wait');
  assert.strictEqual(phase(v, 'Done').status, 'wait');
  assert.strictEqual(v.label, 'Plan');
  assert.strictEqual(v.needsYou, false);
  assert.strictEqual(v.gate, 'none');
  assert.strictEqual(v.round, 1);
  assert.strictEqual(v.flowKey, 'k1');
  assert.strictEqual(v.sessionId, 's1');
});

test('plan skeptic running -> Skeptic', () => {
  const v = deriveFlow(state({ agents: [agent({ status: 'run', endedAt: null })] }), NOW);
  assert.strictEqual(phase(v, 'Plan').status, 'done');
  assert.strictEqual(phase(v, 'Skeptic').status, 'run');
  assert.strictEqual(v.label, 'Skeptic');
});

test('plan skeptic CHANGES_REQUIRED -> warn', () => {
  const v = deriveFlow(state({ agents: [agent({ verdict: 'CHANGES_REQUIRED', findings: { ...NO_FINDINGS, major: 2 } })] }), NOW);
  assert.strictEqual(phase(v, 'Skeptic').status, 'warn');
  const row = v.rows.find(r => r.label === 'Skeptic · plan');
  assert.strictEqual(row.status, 'warn');
  assert.match(row.detail, /CHANGES_REQUIRED · 2 major/);
  assert.strictEqual(row.meta, '1m00s');
});

test('plan skeptic APPROVE -> done', () => {
  const v = deriveFlow(state({ agents: [agent({ verdict: 'APPROVE' })] }), NOW);
  assert.strictEqual(phase(v, 'Skeptic').status, 'done');
});

test('build 1/2', () => {
  const agents = [
    agent({ verdict: 'APPROVE' }),
    agent({ type: 'backend-dev', role: 'impl', summary: 'STATUS: DONE' }),
    agent({ type: 'frontend-dev', role: 'impl', status: 'run', endedAt: null })
  ];
  const v = deriveFlow(state({ agents }, { dirtyAt: T0 + 3 * MIN }), NOW);
  assert.strictEqual(phase(v, 'Build').status, 'run');
  assert.strictEqual(phase(v, 'Build').count, '1/2');
  assert.strictEqual(v.label, 'Build 1/2');
});

test('no plan skeptic but build started -> Skeptic skip', () => {
  const v = deriveFlow(state({ agents: [agent({ type: 'backend-dev', role: 'impl', status: 'run', endedAt: null })] }), NOW);
  assert.strictEqual(phase(v, 'Skeptic').status, 'skip');
  const v2 = deriveFlow(state({}, { dirtyAt: T0 + MIN }), NOW);
  assert.strictEqual(phase(v2, 'Skeptic').status, 'skip');
  assert.strictEqual(phase(v2, 'Build').status, 'done');
});

test('stale review after a new edit -> wait + gate pending', () => {
  const diff = agent({ role: 'diff', verdict: 'APPROVE', startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const s = state({ agents: [diff], tests: { status: 'done', at: T0 + 4 * MIN, summary: 'node --test' } },
    { dirtyAt: T0 + 6 * MIN, skepticAt: T0 + 5 * MIN });
  const v = deriveFlow(s, NOW);
  assert.strictEqual(v.gate, 'pending');
  const diffRow = v.rows.find(r => r.label === 'Skeptic · diff');
  assert.strictEqual(diffRow.status, 'wait');
  assert.strictEqual(diffRow.meta, 'stale');
  assert.strictEqual(v.rows.find(r => r.label === 'Tests').status, 'wait');
  assert.strictEqual(phase(v, 'Verify').status, 'wait');

  // the same review, finished after the edit, counts
  const fresh = deriveFlow(state({ agents: [diff], tests: { status: 'done', at: T0 + 4 * MIN } },
    { dirtyAt: T0 + 3 * MIN, skepticAt: T0 + 5 * MIN }), NOW);
  assert.strictEqual(phase(fresh, 'Verify').status, 'done');
  assert.strictEqual(fresh.gate, 'none');
});

test('security HIGH -> fail, needsYou + label when waiting for user', () => {
  const sec = agent({ type: 'security-reviewer', role: 'diff', verdict: 'CHANGES_REQUIRED', findings: { ...NO_FINDINGS, high: 1, minor: 1 }, startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const s = state({ agents: [sec], waitingForUser: true, gate: 'open' },
    { dirtyAt: T0 + 3 * MIN, securityDirtyAt: T0 + 3 * MIN, securityAt: T0 + 5 * MIN, skepticAt: T0 + 5 * MIN });
  const v = deriveFlow(s, NOW);
  assert.strictEqual(phase(v, 'Verify').status, 'fail');
  assert.strictEqual(v.needsYou, true);
  assert.strictEqual(v.label, 'Needs you · security HIGH');
  assert.strictEqual(v.round, 2);
  assert.strictEqual(v.gate, 'open');
});

test('Skeptic BLOCKER label', () => {
  const sk = agent({ role: 'diff', verdict: 'CHANGES_REQUIRED', findings: { ...NO_FINDINGS, blocker: 1, high: 2 }, startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const v = deriveFlow(state({ agents: [sk], waitingForUser: true }, { dirtyAt: T0 + 3 * MIN, skepticAt: T0 + 5 * MIN }), NOW);
  assert.strictEqual(v.label, 'Needs you · Skeptic BLOCKER');
});

test('waitingForUser without failures -> waiting for reply', () => {
  const v = deriveFlow(state({ waitingForUser: true, gate: 'open' }), NOW);
  assert.strictEqual(v.needsYou, true);
  assert.strictEqual(v.label, 'Needs you · waiting for reply');
});

test('gate blocked alone -> Verify · reviewing, not needsYou', () => {
  const v = deriveFlow(state({ gate: 'blocked' }, { dirtyAt: T0 + 3 * MIN }), NOW);
  assert.strictEqual(v.gate, 'blocked');
  assert.strictEqual(v.needsYou, false);
  assert.strictEqual(v.label, 'Verify · reviewing');
});

test('security fail without waitingForUser is not needsYou', () => {
  const sec = agent({ type: 'security-reviewer', role: 'diff', verdict: 'CHANGES_REQUIRED', findings: { ...NO_FINDINGS, critical: 1 }, startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const v = deriveFlow(state({ agents: [sec] }, { dirtyAt: T0 + 3 * MIN, securityDirtyAt: T0 + 3 * MIN }), NOW);
  assert.strictEqual(phase(v, 'Verify').status, 'fail');
  assert.strictEqual(v.needsYou, false);
});

test('security not triggered -> skip row', () => {
  const v = deriveFlow(state({}, { dirtyAt: T0 + 3 * MIN }), NOW);
  const row = v.rows.find(r => r.label === 'Security review');
  assert.strictEqual(row.status, 'skip');
});

test('cancelled agents are ignored', () => {
  const agents = [
    agent({ type: 'backend-dev', role: 'impl', summary: 'STATUS: DONE' }),
    agent({ type: 'frontend-dev', role: 'impl', status: 'cancelled' })
  ];
  const v = deriveFlow(state({ agents }, { dirtyAt: T0 + 3 * MIN }), NOW);
  assert.strictEqual(phase(v, 'Build').status, 'done');
  assert.ok(!v.rows.some(r => r.label === 'frontend-dev'));
  // only a cancelled agent -> plan still running
  const v2 = deriveFlow(state({ agents: [agent({ status: 'cancelled' })] }), NOW);
  assert.strictEqual(phase(v2, 'Plan').status, 'run');
});

test('done -> Done phase, hidden after 30 min', () => {
  const diff = agent({ role: 'diff', verdict: 'APPROVE', startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const s = state({ agents: [diff], endedAt: T0 + 6 * MIN, gate: 'open', waitingForUser: true, tests: { status: 'done', at: T0 + 4 * MIN } },
    { dirtyAt: T0 + 3 * MIN, skepticAt: T0 + 5 * MIN, updatedAt: T0 + 6 * MIN });
  const v = deriveFlow(s, T0 + 7 * MIN);
  assert.strictEqual(phase(v, 'Done').status, 'done');
  assert.strictEqual(v.label, 'Done');
  assert.strictEqual(v.needsYou, false);
  assert.strictEqual(deriveFlow(s, T0 + 37 * MIN), null);
});

test('state not updated for 2 h -> hidden', () => {
  assert.notStrictEqual(deriveFlow(state(), T0 + 10 * MIN + 119 * MIN), null);
  assert.strictEqual(deriveFlow(state(), T0 + 10 * MIN + 121 * MIN), null);
});

test('tests running/failing in verify', () => {
  const v = deriveFlow(state({ tests: { status: 'fail', at: T0 + 4 * MIN, summary: 'npm test' }, waitingForUser: true }, { dirtyAt: T0 + 3 * MIN }), NOW);
  assert.strictEqual(phase(v, 'Verify').status, 'fail');
  assert.strictEqual(v.label, 'Needs you · tests failed');
});

test('fmtDuration', () => {
  assert.strictEqual(fmtDuration(65000), '1m05s');
  assert.strictEqual(fmtDuration(0), '0m00s');
});

// Sticky Done: the hook keeps endedAt on later Bash/test events; the view must stay Done.
test('done flow + later test run -> still Done', () => {
  const diff = agent({ role: 'diff', verdict: 'APPROVE', startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const s = state({ agents: [diff], endedAt: T0 + 6 * MIN, gate: 'open', waitingForUser: true, tests: { status: 'done', at: T0 + 8 * MIN, summary: 'npm test' } },
    { dirtyAt: T0 + 3 * MIN, skepticAt: T0 + 5 * MIN, updatedAt: T0 + 8 * MIN });
  const v = deriveFlow(s, T0 + 9 * MIN);
  assert.strictEqual(v.label, 'Done');
  assert.strictEqual(phase(v, 'Done').status, 'done');
  assert.strictEqual(v.needsYou, false);
});

// Reopened by a repo edit: hook cleared endedAt/gate/waitingForUser and bumped dirtyAt.
test('done flow reopened by repo edit -> Verify wait, gate pending', () => {
  const diff = agent({ role: 'diff', verdict: 'APPROVE', startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const s = state({ agents: [diff], endedAt: null, gate: 'none', waitingForUser: false, tests: { status: 'done', at: T0 + 4 * MIN } },
    { dirtyAt: T0 + 8 * MIN, skepticAt: T0 + 5 * MIN, updatedAt: T0 + 8 * MIN });
  const v = deriveFlow(s, T0 + 9 * MIN);
  assert.strictEqual(phase(v, 'Done').status, 'wait');
  assert.strictEqual(phase(v, 'Verify').status, 'wait');
  assert.strictEqual(v.gate, 'pending');
  assert.match(v.label, /^Verify/);
});

test('plan skeptic CHANGES_REQUIRED with BLOCKER -> warn, not fail', () => {
  const sk = agent({ verdict: 'CHANGES_REQUIRED', findings: { ...NO_FINDINGS, blocker: 1, high: 2 } });
  const v = deriveFlow(state({ agents: [sk] }), NOW);
  assert.strictEqual(phase(v, 'Skeptic').status, 'warn');
  assert.strictEqual(v.rows.find(r => r.label === 'Skeptic · plan').status, 'warn');
  assert.strictEqual(phase(v, 'Verify').status, 'wait');
  // the same findings on a diff review fail Verify
  const diff = agent({ role: 'diff', verdict: 'CHANGES_REQUIRED', findings: { ...NO_FINDINGS, blocker: 1 }, startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const v2 = deriveFlow(state({ agents: [sk, diff] }, { dirtyAt: T0 + 3 * MIN }), NOW);
  assert.strictEqual(phase(v2, 'Skeptic').status, 'warn');
  assert.strictEqual(phase(v2, 'Verify').status, 'fail');
});

test('ended flow with every Verify item skipped -> Verify done, not wait', () => {
  // skepticAt is newer than dirtyAt, but the diff-skeptic agent is not in flow.agents
  const base = { dirtyAt: T0 + 3 * MIN, skepticAt: T0 + 5 * MIN, updatedAt: T0 + 6 * MIN };
  const v = deriveFlow(state({ endedAt: T0 + 6 * MIN, gate: 'open' }, base), T0 + 7 * MIN);
  assert.strictEqual(phase(v, 'Verify').status, 'done');
  assert.strictEqual(phase(v, 'Done').status, 'done');
});

test('ended flow without tests -> Verify done (never-run items skipped)', () => {
  const diff = agent({ role: 'diff', verdict: 'APPROVE', startedAt: T0 + 4 * MIN, endedAt: T0 + 5 * MIN });
  const base = { dirtyAt: T0 + 3 * MIN, skepticAt: T0 + 5 * MIN, updatedAt: T0 + 6 * MIN };
  const ended = deriveFlow(state({ agents: [diff], endedAt: T0 + 6 * MIN, gate: 'open' }, base), T0 + 7 * MIN);
  assert.strictEqual(phase(ended, 'Verify').status, 'done');
  // not ended yet: missing tests still keep Verify running
  const open = deriveFlow(state({ agents: [diff] }, base), T0 + 7 * MIN);
  assert.strictEqual(phase(open, 'Verify').status, 'run');
});
