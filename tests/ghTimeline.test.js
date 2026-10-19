const test = require('node:test');
const assert = require('node:assert');
const { normalizeTimeline, copilotReviewState, normalizeReviewThreads, attachReviewThreads } = require('../ghTimeline');

const user = (login, type = 'User') => ({ login, type, id: 1, avatar_url: 'x' });
const norm = (e) => normalizeTimeline([e])[0];
const U = 'https://github.com/o/r/pull/1';

test('main kinds map to whitelisted fields', () => {
  assert.deepStrictEqual(norm({ event: 'commented', user: user('a'), body_html: '<p>x</p>', html_url: U, created_at: 't' }),
    { kind: 'comment', at: 't', actor: null, author: 'a', bodyHTML: '<p>x</p>', url: U });
  const r = norm({ event: 'reviewed', user: user('Copilot', 'Bot'), state: 'commented', body_html: 'b', html_url: U, submitted_at: 's' });
  assert.strictEqual(r.kind, 'review'); assert.strictEqual(r.state, 'COMMENTED');
  assert.strictEqual(r.authorIsBot, true); assert.strictEqual(r.at, 's');
  const c = norm({ event: 'committed', sha: 'abc', message: 'first\n\nrest', author: { name: 'N', date: 'd1' }, committer: { date: 'd2' }, html_url: U });
  assert.deepStrictEqual([c.kind, c.sha, c.message, c.author, c.at], ['commit', 'abc', 'first', 'N', 'd2']);
  const rq = norm({ event: 'review_requested', actor: user('me'), requested_reviewer: user('Copilot', 'Bot'), created_at: 't' });
  assert.deepStrictEqual([rq.kind, rq.actor, rq.reviewer, rq.reviewerIsBot], ['review_requested', 'me', 'Copilot', true]);
  assert.strictEqual(norm({ event: 'review_request_removed', requested_team: { name: 'core' } }).reviewer, 'core');
  assert.strictEqual(norm({ event: 'merged', commit_id: '68dfd87f47e3757e' }).commit, '68dfd87');
  assert.strictEqual(norm({ event: 'closed', actor: user('x') }).actor, 'x');
  assert.deepStrictEqual(norm({ event: 'labeled', label: { name: 'bug', color: 'f00', id: 5 } }).label, { name: 'bug', color: 'f00' });
  assert.strictEqual(norm({ event: 'assigned', assignee: user('z') }).assignee, 'z');
  assert.strictEqual(norm({ event: 'milestoned', milestone: { title: 'v1' } }).milestone, 'v1');
  const rn = norm({ event: 'renamed', rename: { from: 'a', to: 'b' } });
  assert.deepStrictEqual([rn.from, rn.to], ['a', 'b']);
  const d = norm({ event: 'review_dismissed', dismissed_review: { state: 'approved', message: 'm' } });
  assert.deepStrictEqual([d.state, d.message], ['APPROVED', 'm']);
  assert.strictEqual(norm({ event: 'referenced', commit_id: 'b9d825697f1c' }).commit, 'b9d8256');
});

test('non-github urls are dropped', () => {
  for (const bad of ['file:///c:/x.exe', '\\\\host\\share\\x.exe', 'http://github.com/x', 'https://github.com.evil.io/x'])
    assert.strictEqual(norm({ event: 'commented', html_url: bad }).url, null, bad);
});

test('hyphenated cross-referenced', () => {
  const x = norm({ event: 'cross-referenced', actor: user('a'), source: { issue: { number: 7, title: 'T', html_url: U, repository: { full_name: 'o/r' }, pull_request: {} } } });
  assert.deepStrictEqual(x, { kind: 'cross_referenced', at: null, actor: 'a', source: { repo: 'o/r', number: 7, title: 'T', url: U, isPr: true } });
  assert.strictEqual(norm({ event: 'cross-referenced', source: { issue: { number: 1 } } }).source.isPr, false);
});

test('copilot events classified by app', () => {
  const ev = (event, app) => norm({ event, actor: user('me'), performed_via_github_app: app });
  assert.deepStrictEqual(ev('copilot_work_started', { name: 'Copilot Pull Request Reviewer', slug: 'x' }),
    { kind: 'copilot', at: null, actor: 'me', phase: 'started', via: 'review' });
  assert.strictEqual(ev('copilot_work_finished', { slug: 'copilot-pull-request-reviewer' }).via, 'review');
  assert.strictEqual(ev('copilot_work_finished_failure', { name: 'Copilot SWE Agent' }).phase, 'failed');
  assert.strictEqual(ev('copilot_work_started', { slug: 'copilot-swe-agent' }).via, 'agent');
  assert.strictEqual(ev('copilot_work_started', null).via, 'other');
});

test('noise dropped, pending review dropped, non-objects skipped', () => {
  const raw = ['subscribed', 'unsubscribed', 'mentioned', 'line-commented', 'commit-commented', 'comment_deleted']
    .map((event) => ({ event }));
  raw.push({ event: 'reviewed', state: 'pending' }, null, 'str', 5, {}, { event: 'closed' });
  assert.deepStrictEqual(normalizeTimeline(raw).map((t) => t.kind), ['closed']);
  assert.deepStrictEqual(normalizeTimeline(null), []);
});

test('unknown -> other, bad names nulled', () => {
  assert.deepStrictEqual(norm({ event: 'pinned', actor: user('a') }), { kind: 'other', at: null, actor: 'a', event: 'pinned' });
  assert.strictEqual(norm({ event: '<img onerror>' }).event, null);
});

test('order preserved, no sorting', () => {
  const t = normalizeTimeline([
    { event: 'closed', created_at: '2026-03-01T00:00:00Z' },
    { event: 'reopened' },
    { event: 'locked', created_at: '2026-01-01T00:00:00Z' }]);
  assert.deepStrictEqual(t.map((x) => x.kind), ['closed', 'reopened', 'locked']);
});

test('no raw object leakage', () => {
  const t = normalizeTimeline([
    { event: 'commented', user: user('a'), actor: user('a'), body_html: 'b', secret: 1 },
    { event: 'review_requested', requested_reviewer: user('r'), actor: user('a') },
    { event: 'cross-referenced', source: { issue: { number: 1, user: user('q') } } }]);
  const walk = (v) => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      assert.ok(!['user', 'avatar_url', 'secret', 'requested_reviewer'].includes(k), k);
      walk(x);
    }
  };
  walk(t);
  for (const e of t) for (const [k, v] of Object.entries(e)) {
    assert.ok(v === null || typeof v !== 'object' || ['label', 'source'].includes(k), k);
  }
});

const NOW = Date.parse('2026-10-19T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const started = (min, via = 'review') => ({ kind: 'copilot', via, phase: 'started', at: ago(min) });
const reqd = (name = 'Copilot', bot = true) => ({ kind: 'review_requested', reviewer: name, reviewerIsBot: bot });
const copReview = { kind: 'review', author: 'Copilot', authorIsBot: true, state: 'COMMENTED' };

test('copilotReviewState', () => {
  assert.strictEqual(copilotReviewState([], NOW), null);
  assert.strictEqual(copilotReviewState([reqd()], NOW), 'requested');
  assert.strictEqual(copilotReviewState([reqd(), started(5)], NOW), 'reviewing');
  assert.strictEqual(copilotReviewState([reqd(), started(31)], NOW), null);
  assert.strictEqual(copilotReviewState([reqd(), started(10), copReview], NOW), null);
  assert.strictEqual(copilotReviewState([reqd(), started(10), copReview, reqd()], NOW), 'requested');
  assert.strictEqual(copilotReviewState([started(5), { kind: 'copilot', via: 'review', phase: 'failed' }], NOW), 'failed');
  assert.strictEqual(copilotReviewState([started(5), { kind: 'copilot', via: 'review', phase: 'finished' }], NOW), null);
  assert.strictEqual(copilotReviewState([reqd(), { kind: 'review_request_removed', reviewer: 'Copilot', reviewerIsBot: true }], NOW), null);
  assert.strictEqual(copilotReviewState([started(5, 'agent')], NOW), null);
  assert.strictEqual(copilotReviewState([reqd('copilotfan', false)], NOW), null);
  assert.strictEqual(copilotReviewState([{ kind: 'review', author: 'copilotfan', authorIsBot: false }, reqd()], NOW), 'requested');
});

// ---------- inline review threads ----------
const gqlComment = (o = {}) => ({ author: { login: 'Copilot', __typename: 'Bot' }, createdAt: '2026-01-01T10:00:00Z',
  bodyHTML: '<p>c</p>', url: U, pullRequestReview: { databaseId: 7 }, ...o });
const gqlThread = (o = {}) => ({ isResolved: false, isOutdated: false, path: 'a.js', line: 3, originalLine: 2, subjectType: 'LINE',
  comments: { totalCount: 1, nodes: [gqlComment()] }, ...o });
const rev = (id, at, o = {}) => ({ kind: 'review', id, at, actor: null, author: 'x', state: 'COMMENTED', bodyHTML: null, url: null, ...o });

test('reviewed keeps a numeric id', () => {
  assert.strictEqual(norm({ event: 'reviewed', id: 42, user: user('a'), state: 'commented' }).id, 42);
  assert.strictEqual(norm({ event: 'reviewed', id: '42', user: user('a'), state: 'commented' }).id, null);
});

test('normalizeReviewThreads maps and filters', () => {
  assert.deepStrictEqual(normalizeReviewThreads(null), []);
  assert.deepStrictEqual(normalizeReviewThreads('x'), []);
  const [t] = normalizeReviewThreads([gqlThread()]);
  assert.deepStrictEqual(t, { path: 'a.js', line: 3, fileLevel: false, outdated: false, resolved: false, reviewId: 7, more: 0,
    comments: [{ author: 'Copilot', authorIsBot: true, at: '2026-01-01T10:00:00Z', bodyHTML: '<p>c</p>', url: U }] });
  const [f, o, r] = normalizeReviewThreads([
    gqlThread({ subjectType: 'FILE', line: null, originalLine: null }),
    gqlThread({ isOutdated: true, line: null, originalLine: 9 }),
    gqlThread({ isResolved: true, comments: { totalCount: 5, nodes: [gqlComment({ author: { login: 'me', __typename: 'User' }, url: 'http://evil' })] } })]);
  assert.deepStrictEqual([f.fileLevel, f.line], [true, null]);
  assert.deepStrictEqual([o.outdated, o.line], [true, 9]);
  assert.deepStrictEqual([r.resolved, r.more, r.comments[0].authorIsBot, r.comments[0].url], [true, 4, false, null]);
  assert.deepStrictEqual(normalizeReviewThreads([null, 5, {}, gqlThread({ comments: { totalCount: 0, nodes: [] } }), gqlThread({ comments: { nodes: [null] } })]), []);
});

test('attachReviewThreads attaches to the matching review', () => {
  const tl = [rev(7, '2026-01-01T09:00:00Z'), rev(8, '2026-01-01T11:00:00Z')];
  const ts = normalizeReviewThreads([gqlThread(), gqlThread({ path: 'b.js' })]);
  const out = attachReviewThreads(tl, ts);
  assert.deepStrictEqual(out[0].threads.map((t) => t.path), ['a.js', 'b.js']);
  assert.strictEqual(out[1].threads, undefined);
  assert.strictEqual(attachReviewThreads('x', ts), 'x');
});

test('orphan threads become a synthetic review at the right position', () => {
  const tl = [rev(1, '2026-01-01T09:00:00Z'), { kind: 'commit', at: '2026-01-01T12:00:00Z' }];
  const out = attachReviewThreads(tl, normalizeReviewThreads([gqlThread()]));
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual([out[1].kind, out[1].state, out[1].author, out[1].authorIsBot, out[1].bodyHTML, out[1].threads.length],
    ['review', 'COMMENTED', 'Copilot', true, null, 1]);
  assert.strictEqual(out[2].kind, 'commit');
  const late = attachReviewThreads(tl, normalizeReviewThreads([gqlThread({ comments: { totalCount: 1, nodes: [gqlComment({ createdAt: '2026-02-01T00:00:00Z' })] } })]));
  assert.strictEqual(late[2].kind, 'review');
});

test('orphans sharing a reviewId group into one review', () => {
  const ts = normalizeReviewThreads([gqlThread(), gqlThread({ path: 'b.js' }),
    gqlThread({ path: 'c.js', comments: { totalCount: 1, nodes: [gqlComment({ pullRequestReview: { databaseId: 9 } })] } })]);
  const out = attachReviewThreads([], ts);
  assert.deepStrictEqual(out.map((e) => e.threads.map((t) => t.path)), [['a.js', 'b.js'], ['c.js']]);
});

test('attachReviewThreads does not mutate its input', () => {
  const tl = [rev(7, '2026-01-01T09:00:00Z')];
  const snap = JSON.stringify(tl);
  const out = attachReviewThreads(tl, normalizeReviewThreads([gqlThread()]));
  assert.strictEqual(JSON.stringify(tl), snap);
  assert.notStrictEqual(out[0], tl[0]);
  assert.strictEqual(tl[0].threads, undefined);
});

test('normalizeReviewThreads drops pending (unsubmitted) comments', () => {
  const c = (state, login) => ({ state, author: { login, __typename: 'User' }, createdAt: '2024-01-01T00:00:00Z',
    bodyHTML: '<p>x</p>', url: U, pullRequestReview: { databaseId: 9 } });
  const th = (nodes) => ({ path: 'a.js', line: 1, subjectType: 'LINE', comments: { totalCount: nodes.length, nodes } });
  assert.deepStrictEqual(normalizeReviewThreads([th([c('PENDING', 'me')])]), []);
  const [t] = normalizeReviewThreads([th([c('SUBMITTED', 'bob'), c('PENDING', 'me')])]);
  assert.deepStrictEqual(t.comments.map((x) => x.author), ['bob']);
});
