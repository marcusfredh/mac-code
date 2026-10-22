// Deployment status: parsing of the followed-repo list and the rules that turn GitHub
// deployments into rows and a toolbar icon state. Pure (no DOM, no gh, no electron) so
// it can be unit-tested; it is shared by main (github.js, settings.js validate with it)
// and the renderer (window.deployStatus).
//
// A followed entry is 'owner/repo' or 'owner/repo@workflow.yml' (only deployments made
// by that workflow's runs count).
(() => {
  'use strict';

  const MAX_REPOS = 20;
  // Same character set as github.js REPO_RE, but neither part may start with '-' (a
  // value must never look like a flag) or be only dots ('..' would walk the API path).
  const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const WORKFLOW_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\.ya?ml$/;
  const STATES = ['waiting', 'queued', 'in_progress', 'pending', 'success', 'failure', 'error', 'inactive'];

  function validRepoName(repo) {
    if (typeof repo !== 'string' || !REPO_RE.test(repo)) return false;
    return repo.split('/').every((p) => !p.startsWith('-') && !/^\.+$/.test(p));
  }

  function clip(s) { return s.length > 60 ? s.slice(0, 57) + '...' : s; }

  // 'a/b, c/d@deploy.yml; e/f' -> { entries: [{ repo, workflow, raw }], errors: [string] }.
  // Commas, semicolons and whitespace separate. Duplicates (case-insensitive) are dropped;
  // more than MAX_REPOS entries is an error and the rest are cut off.
  function parseRepoList(str) {
    const entries = [];
    const errors = [];
    const seen = new Set();
    let over = false;
    for (const raw of String(str == null ? '' : str).split(/[\s,;]+/)) {
      if (!raw) continue;
      const parts = raw.split('@');
      const repo = parts[0];
      const workflow = parts.length === 2 ? parts[1] : null;
      if (parts.length > 2 || !validRepoName(repo)) { errors.push('Ogiltigt repo: "' + clip(raw) + '"'); continue; }
      if (parts.length === 2 && !WORKFLOW_RE.test(workflow)) { errors.push('Ogiltigt workflow-filnamn: "' + clip(raw) + '"'); continue; }
      const key = (repo + '@' + (workflow || '')).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (entries.length >= MAX_REPOS) { over = true; continue; }
      entries.push({ repo, workflow, raw });
    }
    if (over) errors.push('Högst ' + MAX_REPOS + ' repon');
    return { entries, errors };
  }

  // Run, deployment and environment ids: positive safe integers (run ids pass 1e9).
  function validId(n) { return typeof n === 'number' && Number.isSafeInteger(n) && n > 0; }

  // '.../actions/runs/123/job/456' -> 123, else null.
  function runIdFromUrl(url) {
    const m = /\/actions\/runs\/(\d+)/.exec(typeof url === 'string' ? url : '');
    if (!m) return null;
    const n = Number(m[1]);
    return validId(n) ? n : null;
  }

  // Any GitHub deployment or deployment-status state (REST lowercase, GraphQL uppercase)
  // -> one of STATES. Unknown or missing is 'pending'.
  const STATE_MAP = {
    waiting: 'waiting', queued: 'queued', in_progress: 'in_progress', pending: 'pending',
    success: 'success', active: 'success',
    failure: 'failure', error: 'error',
    inactive: 'inactive', abandoned: 'inactive', destroyed: 'inactive'
  };
  function mapState(raw) {
    const k = String(raw == null ? '' : raw).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(STATE_MAP, k) ? STATE_MAP[k] : 'pending';
  }

  function isWaiting(r) { return r.state === 'waiting' || !!r.waiting; }
  function isRunning(r) { return r.state === 'queued' || r.state === 'in_progress' || r.state === 'pending'; }
  function isFailed(r) { return r.state === 'failure' || r.state === 'error'; }

  function seenHas(seen, row) {
    if (!seen) return false;
    const id = row.deploymentId;
    if (typeof seen === 'function') return !!seen(row);
    if (seen instanceof Set) return seen.has(id) || seen.has(String(id));
    if (Array.isArray(seen)) return seen.includes(id) || seen.includes(String(id));
    if (typeof seen === 'object') return Object.prototype.hasOwnProperty.call(seen, String(id)) && !!seen[String(id)];
    return false;
  }

  // Toolbar icon for a set of rows. `seen` holds the deploymentIds of failures the user
  // has already looked at (Set, array, { id: true } or a predicate on the row).
  // Precedence: waiting > running > failed (unseen) > idle; inactive and success are idle.
  function iconState(rows, opts) {
    const seen = opts && opts.seen;
    let approvable = 0, waiting = 0, running = 0, failedUnseen = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r) continue;
      // Approvable only when the UI can offer it: deployReview needs the run's sha.
      if (r.waiting && r.waiting.canApprove && r.waiting.sha) approvable++;
      if (isWaiting(r)) waiting++;
      else if (isRunning(r)) running++;
      else if (isFailed(r) && !seenHas(seen, r)) failedUnseen++;
    }
    const mode = approvable > 0 || waiting > 0 ? 'waiting' : running ? 'running' : failedUnseen ? 'failed' : 'idle';
    return { mode, approvable, failedUnseen };
  }

  function rank(r) {
    if (isWaiting(r)) return 0;
    if (isRunning(r)) return 1;
    if (isFailed(r)) return 2;
    if (r.state === 'success') return 3;
    return 4;
  }
  function stamp(r) { const t = Date.parse(r.updatedAt || r.createdAt || ''); return Number.isFinite(t) ? t : 0; }

  // Waiting, then queued/in_progress/pending, failure/error, success, inactive; newest
  // first inside each group. Returns a new array.
  function sortRows(rows) {
    return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) =>
      rank(a) - rank(b) || stamp(b) - stamp(a) || String(a.environment).localeCompare(String(b.environment)));
  }

  function httpsUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }
  function str(s) { return typeof s === 'string' && s ? s : null; }

  // A GraphQL Deployment node -> internal record, or null when it has no usable id.
  // { environment, state, deploymentId, createdAt, updatedAt, sha, actor, runId, logUrl, environmentUrl }
  function normalizeDeployment(environment, node) {
    if (!node || !validId(node.databaseId)) return null;
    const st = node.latestStatus || null;
    const times = [node.updatedAt, st && st.createdAt].filter((t) => typeof t === 'string' && Number.isFinite(Date.parse(t)));
    const updatedAt = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || str(node.createdAt);
    const logUrl = httpsUrl(st && st.logUrl);
    return {
      environment: str(node.environment) || environment,
      state: mapState(st ? st.state : node.state),
      deploymentId: node.databaseId,
      createdAt: str(node.createdAt),
      updatedAt,
      sha: str(node.commitOid),
      actor: str(node.creator && node.creator.login),
      runId: runIdFromUrl(logUrl),
      logUrl,
      environmentUrl: httpsUrl(st && st.environmentUrl)
    };
  }

  // Newest first (createdAt, then id).
  function newestFirst(deps) {
    return deps.filter(Boolean).sort((a, b) =>
      (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0) || b.deploymentId - a.deploymentId);
  }

  // Internal run info -> the Row.run shape.
  function publicRun(run) {
    if (!run || !validId(run.id)) return null;
    return {
      id: run.id,
      number: validId(run.number) ? run.number : null,
      title: str(run.title),
      url: httpsUrl(run.url),
      workflow: str(run.workflow)
    };
  }

  // Normalized deployment + internal run info (or null) -> Row.
  function makeRow(dep, run) {
    const r = publicRun(run);
    return {
      environment: dep.environment,
      state: dep.state,
      deploymentId: dep.deploymentId,
      createdAt: dep.createdAt,
      updatedAt: dep.updatedAt,
      sha: dep.sha,
      actor: dep.actor,
      run: r,
      url: (r && r.url) || dep.logUrl || dep.environmentUrl || null,
      waiting: null
    };
  }

  // Attach pending environment gates to rows (mutates and returns `rows`).
  // pendings: [{ runId, run: internal run info | null, entries: pending_deployments response }]
  // Per environment the newest waiting run wins; moreWaiting counts the other runs waiting
  // on it. row.waiting is self-contained (its own run, sha and actor, all from the waiting
  // run), and nothing else on an existing row is touched: the row keeps describing its
  // deployment, so a gate can never borrow another run's commit or author. An environment
  // with no row yet gets one (state 'waiting', deploymentId 0) built from the waiting run.
  function attachWaiting(rows, pendings) {
    const byEnv = new Map();   // env name lowercased -> { name, list: [{ runId, envId, canApprove, run }] }
    for (const p of Array.isArray(pendings) ? pendings : []) {
      if (!p || !validId(p.runId)) continue;
      for (const e of Array.isArray(p.entries) ? p.entries : []) {
        const env = e && e.environment;
        if (!env || typeof env.name !== 'string' || !env.name || !validId(env.id)) continue;
        const key = env.name.toLowerCase();
        if (!byEnv.has(key)) byEnv.set(key, { name: env.name, list: [] });
        const g = byEnv.get(key);
        if (!g.list.some((x) => x.runId === p.runId)) {
          g.list.push({ runId: p.runId, envId: env.id, canApprove: e.current_user_can_approve === true, run: p.run || null });
        }
      }
    }
    for (const [key, g] of byEnv) {
      g.list.sort((a, b) => b.runId - a.runId);
      const win = g.list[0];
      const runInfo = win.run && win.run.id === win.runId ? win.run : { id: win.runId };
      const waiting = {
        runId: win.runId, envId: win.envId, canApprove: win.canApprove, moreWaiting: g.list.length - 1,
        run: publicRun(runInfo), sha: str(runInfo.sha), actor: str(runInfo.actor)
      };
      let row = rows.find((r) => String(r.environment).toLowerCase() === key);
      if (!row) {
        const at = str(runInfo.createdAt);
        row = {
          environment: g.name, state: 'waiting', deploymentId: 0, createdAt: at, updatedAt: at,
          sha: waiting.sha, actor: waiting.actor, run: waiting.run, url: (waiting.run && waiting.run.url) || null, waiting: null
        };
        rows.push(row);
      }
      row.waiting = waiting;
    }
    return rows;
  }

  const api = {
    MAX_REPOS, STATES, parseRepoList, validId, runIdFromUrl, mapState, iconState, sortRows,
    normalizeDeployment, newestFirst, publicRun, makeRow, attachWaiting
  };
  if (typeof window !== 'undefined') window.deployStatus = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
