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
      return { kind: 'review', at: str(e.submitted_at), actor, author: login(u), authorIsBot: u.type === 'Bot',
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

module.exports = { normalizeTimeline, copilotReviewState };
