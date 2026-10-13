// Derives a renderable view of an /orchestrate flow from the state file the
// orchestrate-gate hook writes (~/.claude/state/orchestrate/<session>.json).
// Pure: no I/O, no dependencies — main.js feeds it parsed JSON and a clock.

const ENDED_TTL = 30 * 60 * 1000;   // finished flows disappear after 30 min
const STALE_TTL = 2 * 3600 * 1000;  // untouched state files disappear after 2 h
const SEVERITIES = ['blocker', 'critical', 'high', 'major', 'medium', 'minor', 'low'];

function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function severe(findings) {
  const f = findings || {};
  return (f.blocker || 0) + (f.critical || 0) + (f.high || 0) > 0;
}

// Highest severity with a non-zero count, upper-cased ('HIGH'), or null.
function topSeverity(findings) {
  const f = findings || {};
  const s = SEVERITIES.find(k => f[k] > 0);
  return s ? s.toUpperCase() : null;
}

function latest(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i];
  return null;
}

// Status of one finished-or-running agent on its own (ignores staleness). Only diff
// reviews can fail; a plan review asking for changes is a warning.
function agentStatus(a) {
  if (a.status === 'run') return 'run';
  if (a.verdict === 'CHANGES_REQUIRED') return a.role === 'diff' && severe(a.findings) ? 'fail' : 'warn';
  return 'done';
}

// A review counts only if it finished after the last edit.
function reviewStatus(a, dirtyAt) {
  if (!a) return 'wait';
  if (a.status === 'run') return 'run';
  if (dirtyAt && (a.endedAt || a.startedAt || 0) < dirtyAt) return 'wait';
  return agentStatus(a);
}

function agentLabel(a) {
  if (a.type === 'skeptic') return a.role === 'plan' ? 'Skeptic · plan' : 'Skeptic · diff';
  if (a.type === 'security-reviewer') return 'Security review';
  return a.type;
}

function agentDetail(a) {
  if (a.verdict) {
    const f = a.findings || {};
    const counts = SEVERITIES.filter(k => f[k] > 0).map(k => `${f[k]} ${k}`);
    return counts.length ? `${a.verdict} · ${counts.join(', ')}` : a.verdict;
  }
  if (a.summary) return a.summary;
  if (a.status === 'run') return a.background ? 'running in background' : 'running';
  return '';
}

function agentMeta(a, now) {
  if (a.status === 'run') return fmtDuration(now - (a.startedAt || now));
  return fmtDuration((a.endedAt || now) - (a.startedAt || now));
}

function agentRow(a, now) {
  return { kind: 'item', label: agentLabel(a), status: agentStatus(a), detail: agentDetail(a), meta: agentMeta(a, now), sub: true };
}

// fail > run > all done/warn (warn if any warn) > some done -> run > wait
function combine(statuses) {
  const s = statuses.filter(x => x !== 'skip');
  if (!s.length) return 'wait';
  if (s.includes('fail')) return 'fail';
  if (s.includes('run')) return 'run';
  if (s.every(x => x === 'done' || x === 'warn')) return s.includes('warn') ? 'warn' : 'done';
  if (s.some(x => x === 'done' || x === 'warn')) return 'run';
  return 'wait';
}

function deriveFlow(state, now) {
  if (!state || !state.flow) return null;
  now = now || Date.now();
  const flow = state.flow;
  const updatedAt = state.updatedAt || 0;
  if (now - updatedAt > STALE_TTL) return null;
  if (flow.endedAt && now - flow.endedAt > ENDED_TTL) return null;

  const start = flow.startedAt || 0;
  const dirtyAt = state.dirtyAt || 0;
  const edited = dirtyAt >= start && dirtyAt > 0;
  const agents = (flow.agents || []).filter(a => a && a.status !== 'cancelled');

  // Plan
  const plan = agents.length || edited ? 'done' : 'run';

  // Skeptic (plan review)
  const planSkeptics = agents.filter(a => a.type === 'skeptic' && a.role === 'plan');
  const planSk = planSkeptics[planSkeptics.length - 1] || null;
  const impl = agents.filter(a => a.role === 'impl');
  const buildStarted = impl.length > 0 || edited;
  const skeptic = planSk ? agentStatus(planSk) : buildStarted ? 'skip' : 'wait';

  // Build
  const implDone = impl.filter(a => a.status === 'done').length;
  const implRunning = impl.some(a => a.status === 'run');
  const buildCount = impl.length ? `${implDone}/${impl.length}` : null;
  const build = implRunning ? 'run' : impl.length || edited ? 'done' : 'wait';

  // Verify
  const tests = flow.tests || null;
  let testsStatus = 'wait';
  if (tests && !(dirtyAt && tests.at < dirtyAt)) {
    testsStatus = tests.status === 'fail' ? 'fail' : tests.status === 'run' ? 'run' : 'done';
  }
  const diffSk = latest(agents, a => a.type === 'skeptic' && a.role === 'diff');
  const sec = latest(agents, a => a.type === 'security-reviewer');
  const secTriggered = !!state.securityDirtyAt && state.securityDirtyAt >= start;
  const diffStatus = reviewStatus(diffSk, dirtyAt);
  const secStatus = secTriggered ? reviewStatus(sec, dirtyAt) : 'skip';
  // Once the flow has ended, items that never ran (e.g. no tests) are skipped, not pending.
  const verifyItems = [testsStatus, diffStatus, secStatus].map(x => flow.endedAt && x === 'wait' ? 'skip' : x);
  // An ended flow whose items were all skipped still verified: the gate let it end.
  const verify = flow.endedAt && verifyItems.every(x => x === 'skip') ? 'done' : combine(verifyItems);

  // Done
  const done = flow.endedAt ? 'done' : 'wait';

  // Gate
  let gate = 'none';
  const skPending = dirtyAt && (!state.skepticAt || state.skepticAt < dirtyAt);
  const secPending = state.securityDirtyAt && (!state.securityAt || state.securityAt < state.securityDirtyAt);
  if (flow.gate === 'blocked') gate = 'blocked';
  else if (skPending || secPending) gate = 'pending';
  else if (flow.gate === 'open') gate = 'open';

  const round = 1 + agents.filter(a => a.role === 'diff' && a.status === 'done' && a.verdict === 'CHANGES_REQUIRED').length;
  const needsYou = !!flow.waitingForUser && !flow.endedAt;

  const phases = [
    { name: 'Plan', status: plan },
    { name: 'Skeptic', status: skeptic },
    { name: 'Build', status: build },
    { name: 'Verify', status: verify },
    { name: 'Done', status: done }
  ];
  if (build === 'run' && buildCount) phases[2].count = buildCount;

  // Label
  let label;
  const failing = secStatus === 'fail' ? 'security' : diffStatus === 'fail' ? 'skeptic' : testsStatus === 'fail' ? 'tests' : null;
  if (flow.endedAt) label = 'Done';
  else if (needsYou) {
    if (failing === 'security') label = `Needs you · security ${topSeverity(sec.findings)}`;
    else if (failing === 'skeptic') label = `Needs you · Skeptic ${topSeverity(diffSk.findings)}`;
    else if (failing === 'tests') label = 'Needs you · tests failed';
    else label = 'Needs you · waiting for reply';
  } else if (gate === 'blocked') label = 'Verify · reviewing';
  else if (build === 'run') label = buildCount ? `Build ${buildCount}` : 'Build';
  else if (skeptic === 'run') label = 'Skeptic';
  else if (plan === 'run') label = 'Plan';
  else if (build === 'done') {
    if (diffStatus === 'run' || secStatus === 'run') label = 'Verify · reviews';
    else if (testsStatus === 'run' || testsStatus === 'wait') label = 'Verify · tests';
    else label = 'Verify · reviews';
  } else if (skeptic === 'wait') label = 'Skeptic';
  else label = buildCount ? `Build ${buildCount}` : 'Build';

  // Rows: one group per phase, agents (and tests) as sub items in start order.
  const rows = [];
  const group = (name, status, detail = '', meta = '') => rows.push({ kind: 'group', label: name, status, detail, meta, sub: false });
  group('Plan', plan, flow.class ? `class ${flow.class}` : '', fmtDuration((agents[0] ? agents[0].startedAt : now) - start));
  group('Skeptic', skeptic, skeptic === 'skip' ? 'no plan review' : '');
  for (const a of planSkeptics) rows.push(agentRow(a, now));
  group('Build', build, buildCount ? `${buildCount} done` : edited ? 'edited directly' : '');
  for (const a of agents) if (a.role === 'impl' || a.role === 'other') rows.push(agentRow(a, now));
  group('Verify', verify, `round ${round}`);
  if (tests) {
    rows.push({ kind: 'item', label: 'Tests', status: testsStatus, detail: tests.summary || '', meta: testsStatus === 'wait' ? 'stale' : '', sub: true });
  }
  for (const a of agents) {
    if (a.role !== 'diff') continue;
    const row = agentRow(a, now);
    if (a === diffSk || a === sec) {
      row.status = a === sec && !secTriggered ? row.status : reviewStatus(a, dirtyAt);
      if (row.status === 'wait') row.meta = 'stale';
    }
    rows.push(row);
  }
  if (!secTriggered) rows.push({ kind: 'item', label: 'Security review', status: 'skip', detail: 'not triggered', meta: '', sub: true });
  group('Done', done, flow.endedAt ? `gate ${gate}` : '');

  return {
    sessionId: state.sessionId || null,
    flowKey: state.flowKey || null,
    cwd: state.cwd || null,
    updatedAt,
    class: flow.class || null,
    round,
    gate,
    needsYou,
    label,
    phases,
    rows
  };
}

module.exports = { deriveFlow, fmtDuration };
