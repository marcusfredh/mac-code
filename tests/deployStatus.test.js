const test = require('node:test');
const assert = require('node:assert');
const DS = require('../deployStatus');
const { parseRepoList, validId, runIdFromUrl, mapState, iconState, sortRows, normalizeDeployment, newestFirst, makeRow, attachWaiting } = DS;

test('parseRepoList: separators, workflow suffix, raw kept', () => {
  const r = parseRepoList(' a/b, c/d@deploy.yml;e/f\n g.h/i_j-k@ci.yaml\t');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.entries, [
    { repo: 'a/b', workflow: null, raw: 'a/b' },
    { repo: 'c/d', workflow: 'deploy.yml', raw: 'c/d@deploy.yml' },
    { repo: 'e/f', workflow: null, raw: 'e/f' },
    { repo: 'g.h/i_j-k', workflow: 'ci.yaml', raw: 'g.h/i_j-k@ci.yaml' }
  ]);
  assert.deepStrictEqual(parseRepoList(''), { entries: [], errors: [] });
  assert.deepStrictEqual(parseRepoList(null), { entries: [], errors: [] });
  assert.deepStrictEqual(parseRepoList(' ,; '), { entries: [], errors: [] });
});

test('parseRepoList: bad repos and workflows are errors', () => {
  for (const bad of ['-a/b', 'a/-b', 'a', 'a/b/c', 'a/..', './b', 'a/b@', '@x.yml', 'a/b@x.yml@y.yml', 'å/b', 'a/b?x']) {
    const r = parseRepoList(bad);
    assert.strictEqual(r.entries.length, 0, bad);
    assert.strictEqual(r.errors.length, 1, bad);
  }
  for (const bad of ['a/b@x', 'a/b@-x.yml', 'a/b@x.json', 'a/b@dir/x.yml', 'a/b@.yml.txt']) {
    const r = parseRepoList(bad);
    assert.strictEqual(r.entries.length, 0, bad);
    assert.match(r.errors[0], /workflow|repo/i, bad);
  }
  assert.strictEqual(parseRepoList('a/b@.hidden.yml').entries.length, 1);
  // Good entries survive next to bad ones.
  const mixed = parseRepoList('a/b, -x/y, c/d');
  assert.deepStrictEqual(mixed.entries.map((e) => e.repo), ['a/b', 'c/d']);
  assert.strictEqual(mixed.errors.length, 1);
});

test('parseRepoList: case-insensitive dedupe, repo and repo@wf are distinct', () => {
  const r = parseRepoList('A/B a/b a/b@D.yml a/b@d.yml');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.entries.map((e) => e.raw), ['A/B', 'a/b@D.yml']);
});

test('parseRepoList: max 20, the rest cut off with an error', () => {
  const list = Array.from({ length: 22 }, (_, i) => 'o/r' + i).join(',');
  const r = parseRepoList(list);
  assert.strictEqual(r.entries.length, 20);
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(parseRepoList(Array.from({ length: 20 }, (_, i) => 'o/r' + i).join(' ')).errors.length, 0);
  // Duplicates do not count towards the cap.
  assert.strictEqual(parseRepoList(Array.from({ length: 20 }, (_, i) => 'o/r' + i).join(' ') + ' o/r0 O/R1').errors.length, 0);
});

test('validId: positive safe integers only (run ids above 1e9 pass)', () => {
  for (const ok of [1, 42, 39624591320, Number.MAX_SAFE_INTEGER]) assert.strictEqual(validId(ok), true, String(ok));
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', null, undefined, {}, [], true]) {
    assert.strictEqual(validId(bad), false, String(bad));
  }
});

test('runIdFromUrl', () => {
  assert.strictEqual(runIdFromUrl('https://github.com/cli/cli/actions/runs/39624591320/job/119306585102'), 39624591320);
  assert.strictEqual(runIdFromUrl('https://github.com/o/r/actions/runs/7'), 7);
  assert.strictEqual(runIdFromUrl('https://github.com/o/r/actions/runs/0'), null);
  assert.strictEqual(runIdFromUrl('https://github.com/o/r/actions/runs/99999999999999999999'), null);
  assert.strictEqual(runIdFromUrl('https://cli.github.io/cli'), null);
  assert.strictEqual(runIdFromUrl(null), null);
  assert.strictEqual(runIdFromUrl(123), null);
});

test('mapState: every GitHub state, case-insensitive, unknown -> pending', () => {
  const cases = {
    WAITING: 'waiting', queued: 'queued', IN_PROGRESS: 'in_progress', pending: 'pending',
    SUCCESS: 'success', ACTIVE: 'success', failure: 'failure', ERROR: 'error',
    INACTIVE: 'inactive', ABANDONED: 'inactive', destroyed: 'inactive'
  };
  for (const [raw, want] of Object.entries(cases)) assert.strictEqual(mapState(raw), want, raw);
  for (const raw of ['', null, undefined, 'bogus', 'toString', '__proto__', 42]) assert.strictEqual(mapState(raw), 'pending', String(raw));
});

const row = (state, extra = {}) => ({ environment: extra.environment || state, state, deploymentId: extra.id || 1,
  createdAt: extra.at || '2026-01-01T00:00:00Z', updatedAt: extra.at || '2026-01-01T00:00:00Z', waiting: extra.waiting || null });

test('iconState: precedence waiting > running > failed(unseen) > idle', () => {
  assert.deepStrictEqual(iconState([]), { mode: 'idle', approvable: 0, failedUnseen: 0 });
  assert.deepStrictEqual(iconState([row('success'), row('inactive')]), { mode: 'idle', approvable: 0, failedUnseen: 0 });
  assert.strictEqual(iconState([row('failure', { id: 5 }), row('success')]).mode, 'failed');
  assert.strictEqual(iconState([row('error', { id: 5 })]).failedUnseen, 1);
  assert.strictEqual(iconState([row('failure', { id: 5 }), row('in_progress')]).mode, 'running');
  assert.strictEqual(iconState([row('queued')]).mode, 'running');
  assert.strictEqual(iconState([row('pending')]).mode, 'running');
  assert.strictEqual(iconState([row('waiting'), row('in_progress'), row('failure')]).mode, 'waiting');
  assert.strictEqual(iconState(null).mode, 'idle');
});

test('iconState: approvable counts, waiting without approval still waiting', () => {
  const w1 = row('waiting', { waiting: { runId: 1, envId: 1, canApprove: true, moreWaiting: 0, sha: 'abc1234' } });
  const w2 = row('waiting', { waiting: { runId: 2, envId: 2, canApprove: false, moreWaiting: 0, sha: 'abc1234' } });
  assert.deepStrictEqual(iconState([w1, w2, row('in_progress')]), { mode: 'waiting', approvable: 1, failedUnseen: 0 });
  assert.deepStrictEqual(iconState([w2]), { mode: 'waiting', approvable: 0, failedUnseen: 0 });
  // A gate attached to a row in another state still counts as waiting.
  const gated = row('success', { waiting: { runId: 3, envId: 3, canApprove: true, moreWaiting: 0, sha: 'abc1234' } });
  assert.deepStrictEqual(iconState([gated]), { mode: 'waiting', approvable: 1, failedUnseen: 0 });
  // No sha: the UI cannot offer approve, so it is waiting but not approvable.
  const noSha = row('waiting', { waiting: { runId: 4, envId: 4, canApprove: true, moreWaiting: 0, sha: null } });
  assert.deepStrictEqual(iconState([noSha]), { mode: 'waiting', approvable: 0, failedUnseen: 0 });
});

test('iconState: seen failures are neutral (Set, array, object, predicate)', () => {
  const rows = [row('failure', { id: 7 }), row('error', { id: 8 })];
  assert.strictEqual(iconState(rows, { seen: new Set([7]) }).failedUnseen, 1);
  assert.strictEqual(iconState(rows, { seen: new Set(['7', '8']) }).mode, 'idle');
  assert.strictEqual(iconState(rows, { seen: [7, 8] }).mode, 'idle');
  assert.strictEqual(iconState(rows, { seen: { 8: true } }).failedUnseen, 1);
  assert.strictEqual(iconState(rows, { seen: (r) => r.deploymentId === 7 }).failedUnseen, 1);
  assert.strictEqual(iconState(rows, {}).failedUnseen, 2);
});

test('sortRows: group order then newest first, input untouched', () => {
  const rows = [
    row('inactive', { environment: 'i', at: '2026-05-01T00:00:00Z' }),
    row('success', { environment: 's-old', at: '2026-01-01T00:00:00Z' }),
    row('success', { environment: 's-new', at: '2026-03-01T00:00:00Z' }),
    row('error', { environment: 'e', at: '2026-02-01T00:00:00Z' }),
    row('failure', { environment: 'f', at: '2026-04-01T00:00:00Z' }),
    row('pending', { environment: 'p', at: '2026-01-01T00:00:00Z' }),
    row('in_progress', { environment: 'ip', at: '2026-02-01T00:00:00Z' }),
    row('queued', { environment: 'q', at: '2026-03-01T00:00:00Z' }),
    row('waiting', { environment: 'w', at: '2026-01-01T00:00:00Z' })
  ];
  const before = rows.map((r) => r.environment);
  assert.deepStrictEqual(sortRows(rows).map((r) => r.environment), ['w', 'q', 'ip', 'p', 'f', 'e', 's-new', 's-old', 'i']);
  assert.deepStrictEqual(rows.map((r) => r.environment), before);
  assert.deepStrictEqual(sortRows(null), []);
});

const node = (id, at, extra = {}) => ({
  databaseId: id, environment: extra.environment || 'production', state: extra.depState || 'ACTIVE', createdAt: at, updatedAt: at,
  commitOid: 'abc', creator: { login: 'me' },
  latestStatus: extra.noStatus ? null : { state: extra.state || 'SUCCESS', logUrl: extra.logUrl === undefined ? `https://github.com/o/r/actions/runs/${id * 10}/job/1` : extra.logUrl,
    environmentUrl: extra.envUrl || null, createdAt: extra.statusAt || at }
});

test('normalizeDeployment and makeRow', () => {
  const d = normalizeDeployment('production', node(5, '2026-01-01T00:00:00Z', { statusAt: '2026-01-01T00:05:00Z', state: 'IN_PROGRESS' }));
  assert.deepStrictEqual(d, {
    environment: 'production', state: 'in_progress', deploymentId: 5, createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:05:00Z', sha: 'abc', actor: 'me', runId: 50,
    logUrl: 'https://github.com/o/r/actions/runs/50/job/1', environmentUrl: null
  });
  assert.strictEqual(normalizeDeployment('x', { databaseId: 'nope' }), null);
  assert.strictEqual(normalizeDeployment('x', null), null);
  // No status yet: the deployment's own state; non-https urls dropped.
  const n = normalizeDeployment('stage', node(6, '2026-01-01T00:00:00Z', { noStatus: true, depState: 'QUEUED' }));
  assert.strictEqual(n.state, 'queued');
  assert.strictEqual(n.runId, null);
  const js = normalizeDeployment('stage', node(7, '2026-01-01T00:00:00Z', { logUrl: 'javascript:alert(1)', envUrl: 'https://app.example' }));
  assert.strictEqual(js.logUrl, null);
  assert.strictEqual(js.environmentUrl, 'https://app.example');

  const withRun = makeRow(d, { id: 50, number: 3, title: 'T', url: 'https://github.com/o/r/actions/runs/50', workflow: 'deploy.yml', createdAt: 'x', sha: 'y' });
  assert.deepStrictEqual(withRun.run, { id: 50, number: 3, title: 'T', url: 'https://github.com/o/r/actions/runs/50', workflow: 'deploy.yml' });
  assert.strictEqual(withRun.url, 'https://github.com/o/r/actions/runs/50');
  assert.strictEqual(withRun.waiting, null);
  assert.deepStrictEqual(Object.keys(withRun).sort(),
    ['actor', 'createdAt', 'deploymentId', 'environment', 'run', 'sha', 'state', 'updatedAt', 'url', 'waiting']);
  assert.strictEqual(makeRow(d, null).url, d.logUrl);
  assert.strictEqual(makeRow(js, null).url, 'https://app.example');
});

test('newestFirst', () => {
  const deps = [node(1, '2026-01-01T00:00:00Z'), node(3, '2026-03-01T00:00:00Z'), node(2, '2026-03-01T00:00:00Z')]
    .map((n) => normalizeDeployment('p', n));
  assert.deepStrictEqual(newestFirst([...deps, null]).map((d) => d.deploymentId), [3, 2, 1]);
});

const gate = (id, name, can) => ({ environment: { id, name }, current_user_can_approve: can, wait_timer: 0, reviewers: [] });
const runInfo = (id) => ({ id, number: id, title: 'run ' + id, url: `https://github.com/o/r/actions/runs/${id}`, workflow: 'deploy.yml',
  createdAt: '2026-02-01T00:00:00Z', sha: 'sha' + id, actor: 'user' + id });
const pubRun = (id) => ({ id, number: id, title: 'run ' + id, url: `https://github.com/o/r/actions/runs/${id}`, workflow: 'deploy.yml' });
const gateOf = (id, envId, canApprove, moreWaiting = 0) => ({ runId: id, envId, canApprove, moreWaiting, run: pubRun(id), sha: 'sha' + id, actor: 'user' + id });
const snapshot = (r) => ({ state: r.state, deploymentId: r.deploymentId, run: r.run, url: r.url, sha: r.sha, actor: r.actor, createdAt: r.createdAt, updatedAt: r.updatedAt });

test('attachWaiting: attaches by env name with that env id and flag; new env gets a row from the run', () => {
  const prod = makeRow(normalizeDeployment('production', node(1, '2026-01-01T00:00:00Z', { state: 'WAITING' })), runInfo(10));
  const stage = makeRow(normalizeDeployment('staging', node(2, '2026-01-01T00:00:00Z', { environment: 'staging' })), runInfo(20));
  const rows = attachWaiting([prod, stage], [{ runId: 10, run: runInfo(10), entries: [gate(111, 'Production', true), gate(222, 'qa', false)] }]);
  assert.deepStrictEqual(prod.waiting, gateOf(10, 111, true));
  assert.strictEqual(prod.state, 'waiting');
  assert.strictEqual(stage.waiting, null);
  const qa = rows.find((r) => r.environment === 'qa');
  assert.deepStrictEqual(qa.waiting, gateOf(10, 222, false));
  assert.strictEqual(qa.state, 'waiting');
  assert.strictEqual(qa.deploymentId, 0);
  assert.strictEqual(qa.sha, 'sha10');
  assert.strictEqual(qa.actor, 'user10');
  assert.strictEqual(qa.createdAt, '2026-02-01T00:00:00Z');
  assert.deepStrictEqual(qa.run, pubRun(10));
  assert.strictEqual(qa.url, 'https://github.com/o/r/actions/runs/10');
});

test('attachWaiting: newest run wins, moreWaiting counts the others', () => {
  const rows = attachWaiting([], [
    { runId: 30, run: runInfo(30), entries: [gate(1, 'prod', false)] },
    { runId: 50, run: runInfo(50), entries: [gate(1, 'prod', true)] },
    { runId: 40, run: runInfo(40), entries: [gate(1, 'prod', true)] }
  ]);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].waiting, gateOf(50, 1, true, 2));
  assert.strictEqual(rows[0].run.id, 50);
  assert.strictEqual(rows[0].sha, 'sha50');
});

test('attachWaiting: a newer waiting run never rewrites the older deployment row', () => {
  // Deployment from run 10 (commit abc by me); run 99 by someone else now waits on prod.
  const older = makeRow(normalizeDeployment('prod', node(1, '2026-01-01T00:00:00Z', { environment: 'prod' })), runInfo(10));
  const before = snapshot(older);
  attachWaiting([older], [{ runId: 99, run: runInfo(99), entries: [gate(5, 'prod', true)] }]);
  assert.deepStrictEqual(snapshot(older), before);
  assert.strictEqual(older.sha, 'abc');
  assert.strictEqual(older.run.id, 10);
  // The gate carries run 99's own commit and author.
  assert.deepStrictEqual(older.waiting, gateOf(99, 5, true));
  assert.strictEqual(iconState([older]).mode, 'waiting');
  assert.strictEqual(iconState([older]).approvable, 1);
});

test('attachWaiting: stale waiting row (run 300) with an older run (250) waiting keeps both apart', () => {
  const stale = makeRow(normalizeDeployment('prod', node(3, '2026-03-01T00:00:00Z', { environment: 'prod', state: 'WAITING' })), runInfo(300));
  const before = snapshot(stale);
  attachWaiting([stale], [{ runId: 250, run: runInfo(250), entries: [gate(5, 'prod', true)] }]);
  assert.deepStrictEqual(snapshot(stale), before);
  assert.strictEqual(stale.run.id, 300);
  assert.deepStrictEqual(stale.waiting, gateOf(250, 5, true));
  assert.strictEqual(stale.waiting.run.id, stale.waiting.runId);
});

test('attachWaiting: an older run still waiting behind a newer success is a gate, row stays success', () => {
  const newer = makeRow(normalizeDeployment('prod', node(2, '2026-01-01T00:00:00Z', { environment: 'prod' })), runInfo(200));
  attachWaiting([newer], [{ runId: 99, run: runInfo(99), entries: [gate(5, 'prod', true)] }]);
  assert.strictEqual(newer.state, 'success');
  assert.strictEqual(newer.run.id, 200);
  assert.deepStrictEqual(newer.waiting, gateOf(99, 5, true));
  assert.strictEqual(sortRows([makeRow(normalizeDeployment('x', node(9, '2026-09-01T00:00:00Z', { environment: 'x', state: 'IN_PROGRESS' })), null), newer])[0], newer);
});

test('attachWaiting: run info for another run id is never used for the gate', () => {
  const rows = attachWaiting([], [{ runId: 7, run: runInfo(8), entries: [gate(1, 'prod', true)] }]);
  assert.strictEqual(rows[0].waiting.run.id, 7);
  assert.strictEqual(rows[0].waiting.sha, null);
  assert.strictEqual(rows[0].waiting.actor, null);
});

test('attachWaiting: junk entries ignored', () => {
  const rows = attachWaiting([], [
    null, { runId: 0, entries: [gate(1, 'a', true)] }, { runId: 5, entries: null },
    { runId: 6, run: null, entries: [null, { environment: { id: 'x', name: 'b' } }, { environment: { id: 2, name: '' } }, gate(3, 'c', 'yes')] }
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].environment, 'c');
  assert.strictEqual(rows[0].waiting.canApprove, false);
  assert.strictEqual(rows[0].run.id, 6);
  assert.strictEqual(rows[0].run.url, null);
  assert.strictEqual(rows[0].waiting.sha, null);
});
