// Pure normalizer for REST issue-timeline events (no electron). Output keeps input order and
// carries only whitelisted primitives, never raw API objects.

const DROP = new Set(['subscribed', 'unsubscribed', 'mentioned', 'line-commented', 'commit-commented', 'comment_deleted']);
const PLAIN = new Set(['merged', 'closed', 'reopened', 'ready_for_review', 'convert_to_draft', 'head_ref_force_pushed',
  'head_ref_deleted', 'head_ref_restored', 'base_ref_changed', 'base_ref_force_pushed', 'auto_merge_enabled',
  'auto_merge_disabled', 'added_to_merge_queue', 'removed_from_merge_queue', 'locked', 'unlocked', 'deployed',
  'review_dismissed']);
const COPILOT_PHASE = { copilot_work_started: 'started', copilot_work_finished: 'finished', copilot_work_finished_failure: 'failed' };
const THIRTY_MIN = 30 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v : null);
// Links open via openExternal, so only https://github.com pages pass.
const ghUrl = (v) => (typeof v === 'string' && /^https:\/\/github\.com\//i.test(v) ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : {});
const login = (u) => str(obj(u).login);
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 7) : null);

function copilotVia(app) {
  const a = obj(app);
  const name = String(a.name || '').toLowerCase();
  const slug = String(a.slug || '').toLowerCase();
  if (name === 'copilot pull request reviewer' || slug.includes('pull-request-reviewer')) return 'review';
  if (name === 'copilot swe agent' || slug.includes('swe-agent')) return 'agent';
  return 'other';
}

function normalizeOne(e) {
  const ev = e.event;
  if (typeof ev !== 'string' || DROP.has(ev)) return null;
  const actor = login(e.actor);
  const at = str(e.created_at);
  switch (ev) {
    case 'commented':
      return { kind: 'comment', at, actor, author: login(e.user), bodyHTML: str(e.body_html), url: ghUrl(e.html_url) };
    case 'reviewed': {
      const state = String(e.state || '').toUpperCase();
      if (state === 'PENDING') return null;
      const u = obj(e.user);
      return { kind: 'review', id: typeof e.id === 'number' ? e.id : null, at: str(e.submitted_at), actor, author: login(u), authorIsBot: u.type === 'Bot',
        state, bodyHTML: str(e.body_html), url: ghUrl(e.html_url) };
    }
    case 'committed': {
      const c = obj(e.committer), a = obj(e.author);
      return { kind: 'commit', at: str(c.date) || str(a.date), actor: null, sha: str(e.sha),
        message: String(e.message || '').split('\n')[0], author: str(a.name), url: ghUrl(e.html_url) };
    }
    case 'review_requested':
    case 'review_request_removed': {
      const rr = obj(e.requested_reviewer);
      return { kind: ev, at, actor, reviewer: str(rr.login) || str(obj(e.requested_team).name), reviewerIsBot: rr.type === 'Bot' };
    }
    case 'copilot_work_started':
    case 'copilot_work_finished':
    case 'copilot_work_finished_failure':
      return { kind: 'copilot', at, actor, phase: COPILOT_PHASE[ev], via: copilotVia(e.performed_via_github_app) };
    case 'labeled':
    case 'unlabeled': {
      const l = obj(e.label);
      return { kind: ev, at, actor, label: { name: str(l.name), color: str(l.color) } };
    }
    case 'assigned':
    case 'unassigned':
      return { kind: ev, at, actor, assignee: login(e.assignee) };
    case 'milestoned':
    case 'demilestoned':
      return { kind: ev, at, actor, milestone: str(obj(e.milestone).title) };
    case 'renamed':
      return { kind: 'renamed', at, actor, from: str(obj(e.rename).from), to: str(obj(e.rename).to) };
    case 'cross-referenced': {
      const i = obj(obj(e.source).issue);
      return { kind: 'cross_referenced', at, actor, source: {
        repo: str(obj(i.repository).full_name), number: typeof i.number === 'number' ? i.number : null,
        title: str(i.title), url: ghUrl(i.html_url), isPr: !!i.pull_request } };
    }
    case 'referenced':
      return { kind: 'referenced', at, actor, commit: short(e.commit_id) };
    default:
      if (PLAIN.has(ev)) {
        const o = { kind: ev, at, actor };
        if (ev === 'merged') o.commit = short(e.commit_id);
        if (ev === 'review_dismissed') {
          const d = obj(e.dismissed_review);
          o.state = str(d.state) && d.state.toUpperCase(); o.message = str(d.message);
        }
        return o;
      }
      return { kind: 'other', at, actor, event: /^[a-z_-]{1,60}$/.test(ev) ? ev : null };
  }
}

function normalizeTimeline(rawEvents) {
  const out = [];
  for (const e of Array.isArray(rawEvents) ? rawEvents : []) {
    if (!e || typeof e !== 'object') continue;
    const n = normalizeOne(e);
    if (n) out.push(n);
  }
  return out;
}

// Latest Copilot-reviewer signal -> 'requested' | 'reviewing' | 'failed' | null.
function copilotReviewState(timeline, now = Date.now()) {
  let state = null, startAt = null;
  for (const t of Array.isArray(timeline) ? timeline : []) {
    if (!t) continue;
    if (t.kind === 'copilot' && t.via === 'review') {
      if (t.phase === 'started') { state = 'reviewing'; startAt = t.at; }
      else if (t.phase === 'failed') state = 'failed';
      else state = null;
    } else if (t.kind === 'review' && t.authorIsBot && /^copilot/i.test(t.author || '')) state = null;
    else if (t.kind === 'review_requested' && t.reviewerIsBot && /^copilot/i.test(t.reviewer || '')) state = 'requested';
    else if (t.kind === 'review_request_removed' && t.reviewerIsBot && /^copilot/i.test(t.reviewer || '')) state = null;
  }
  if (state === 'reviewing') {
    const ms = Date.parse(startAt);
    if (!(now - ms <= THIRTY_MIN)) return null;
  }
  return state;
}

// GraphQL reviewThreads nodes -> whitelisted threads (inline file comments).
function normalizeReviewThreads(nodes) {
  const out = [];
  const num = (v) => (typeof v === 'number' ? v : null);
  for (const t of Array.isArray(nodes) ? nodes : []) {
    if (!t || typeof t !== 'object') continue;
    // PENDING: the viewer's own unsubmitted draft comments, not posted yet.
    const cn = obj(t.comments), list = Array.isArray(cn.nodes) ? cn.nodes.filter((c) => c && typeof c === 'object' && c.state !== 'PENDING') : [];
    if (!list.length) continue;
    const comments = list.map((c) => {
      const a = obj(c.author);
      return { author: str(a.login), authorIsBot: a.__typename === 'Bot', at: str(c.createdAt), bodyHTML: str(c.bodyHTML), url: ghUrl(c.url) };
    });
    const total = num(cn.totalCount);
    out.push({ path: str(t.path), line: t.line != null ? num(t.line) : num(t.originalLine), fileLevel: t.subjectType === 'FILE',
      outdated: !!t.isOutdated, resolved: !!t.isResolved, reviewId: num(obj(list[0].pullRequestReview).databaseId),
      more: total == null ? 0 : Math.max(0, total - list.length), comments });
  }
  return out;
}

// New timeline with threads attached to their review (ev.threads); threads whose review is
// not in the timeline become one synthetic review per reviewId, placed by time without re-sorting.
function attachReviewThreads(timeline, threads) {
  if (!Array.isArray(timeline)) return timeline;
  const out = timeline.slice(), byId = new Map();
  out.forEach((ev, i) => { if (ev && ev.kind === 'review' && typeof ev.id === 'number') byId.set(ev.id, i); });
  const copied = new Set(), orphans = [], orphanById = new Map();
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || !Array.isArray(t.comments) || !t.comments.length) continue;
    if (t.reviewId != null && byId.has(t.reviewId)) {
      const i = byId.get(t.reviewId);
      if (!copied.has(i)) { out[i] = Object.assign({}, out[i], { threads: [] }); copied.add(i); }
      out[i].threads.push(t);
    } else if (t.reviewId != null && orphanById.has(t.reviewId)) orphanById.get(t.reviewId).threads.push(t);
    else {
      const c = t.comments[0];
      const ev = { kind: 'review', state: 'COMMENTED', actor: null, author: c.author, authorIsBot: c.authorIsBot,
        at: c.at, bodyHTML: null, url: null, threads: [t] };
      orphans.push(ev);
      if (t.reviewId != null) orphanById.set(t.reviewId, ev);
    }
  }
  for (const ev of orphans) {
    const at = Date.parse(ev.at);
    let pos = Number.isNaN(at) ? -1 : out.findIndex((x) => x && Date.parse(x.at) > at);
    if (pos < 0) pos = out.length;
    out.splice(pos, 0, ev);
  }
  return out;
}

module.exports = { normalizeTimeline, copilotReviewState, normalizeReviewThreads, attachReviewThreads };
