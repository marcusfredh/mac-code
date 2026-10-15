// GitHub integration (main process).
//
// Everything goes through the `gh` CLI: it already holds the user's token (keyring),
// handles SSO-authorised org access and API pagination, so Mac Code never sees or
// stores a credential. The renderer only gets narrow, read-mostly IPC calls — there is
// no generic "run any gh command" channel.
//
// Links to github.com can also open in a small built-in browser window. It runs in its
// own persistent partition (so a GitHub login there survives restarts), with no
// preload and a sandboxed renderer, so a web page in it can never reach Mac Code's APIs.

const { BrowserWindow, shell, session } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveWorktreePath, parseWorktreeList } = require('./settings');

const GH_TIMEOUT_MS = 30000;

// Run gh, never throw: resolve with { code, stdout, stderr }.
function runGh(args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile('gh', args, {
      cwd: opts.cwd || undefined,
      windowsHide: true,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: (stderr || '') || (err ? err.message : ''),
        missing: !!(err && err.code === 'ENOENT')
      });
    });
    if (opts.input != null) { try { child.stdin.end(opts.input); } catch (_) {} }
  });
}

// Run gh and parse JSON stdout into { ok, data } / { ok:false, error }.
async function ghJson(args, opts) {
  const r = await runGh(args, opts);
  if (r.missing) return { ok: false, error: 'GitHub CLI (gh) is not installed', missing: true };
  if (r.code !== 0) return { ok: false, error: firstErrorLine(r.stderr || r.stdout) };
  try { return { ok: true, data: JSON.parse(r.stdout || 'null') }; }
  catch (e) { return { ok: false, error: 'Bad JSON from gh: ' + e.message }; }
}

function firstErrorLine(s) {
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|not found|could not|denied|forbidden|unauthorized|saml|sso/i.test(l)) ||
    lines[0] || 'gh failed';
}

// owner/name, letters digits . _ - only. Everything that reaches a gh argument is
// checked, so a crafted value can't smuggle a flag into the command line.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function validRepo(repo) { return typeof repo === 'string' && REPO_RE.test(repo); }
function validNumber(n) { const v = Number(n); return Number.isInteger(v) && v > 0 && v < 1e9 ? v : null; }

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

// github.com remote URL -> "owner/name". https, ssh and git@ forms; .git optional.
function repoFromRemote(url) {
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? m[1] + '/' + m[2] : null;
}

const PR_LIST_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,' +
  'statusCheckRollup,updatedAt,url,additions,deletions,labels,state';
const ISSUE_LIST_FIELDS = 'number,title,author,labels,assignees,updatedAt,url,state,comments';
const RUN_LIST_FIELDS = 'databaseId,number,displayTitle,headBranch,status,conclusion,workflowName,event,createdAt,url';
const SEARCH_FIELDS = 'number,title,repository,url,updatedAt,author,state,isDraft,labels';

// Collapse a statusCheckRollup array (pr list / pr view) into one verdict.
function checksSummary(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  let pass = 0, fail = 0, pending = 0;
  for (const c of list) {
    const concl = String(c.conclusion || c.state || '').toUpperCase();
    const status = String(c.status || '').toUpperCase();
    if (status && status !== 'COMPLETED') { pending++; continue; }
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(concl)) pass++;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(concl)) pending++;
    else fail++;
  }
  const total = pass + fail + pending;
  const state = !total ? 'none' : fail ? 'failure' : pending ? 'pending' : 'success';
  return { state, pass, fail, pending, total };
}

// Only these list flavours exist; each maps to fixed gh arguments.
const PR_FILTERS = {
  open:   ['--state', 'open'],
  closed: ['--state', 'closed'],
  merged: ['--state', 'merged'],
  mine:   ['--state', 'open', '--author', '@me'],
  review: ['--state', 'open']
};
// Filters that are expressed as search qualifiers; the user's own text is appended.
const PR_FILTER_QUERY = { review: 'review-requested:@me' };
const ISSUE_FILTERS = {
  open:     ['--state', 'open'],
  closed:   ['--state', 'closed'],
  mine:     ['--state', 'open', '--assignee', '@me'],
  created:  ['--state', 'open', '--author', '@me']
};
const INBOX = {
  prsMine:   ['prs', '--author=@me', '--state=open'],
  prsReview: ['prs', '--review-requested=@me', '--state=open'],
  issuesMine:['issues', '--assignee=@me', '--state=open']
};

// Search text goes to gh as one argv entry after --search, never through a shell, and
// may not start with "-" so it can't be read as a flag.
function cleanSearch(q) {
  const s = String(q || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return s && !s.startsWith('-') ? s : '';
}

const DETAIL_QUERY = `
query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issueOrPullRequest(number: $n) {
      __typename
      ... on Issue {
        number title url state stateReason createdAt updatedAt bodyHTML
        author { login }
        labels(first: 20) { nodes { name color } }
        assignees(first: 10) { nodes { login } }
        comments(last: 60) { totalCount nodes { author { login } createdAt bodyHTML url } }
      }
      ... on PullRequest {
        number title url state isDraft merged createdAt updatedAt bodyHTML
        author { login }
        headRefName baseRefName additions deletions changedFiles mergeable reviewDecision
        labels(first: 20) { nodes { name color } }
        assignees(first: 10) { nodes { login } }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
        comments(last: 60) { totalCount nodes { author { login } createdAt bodyHTML url } }
        reviews(last: 40) { nodes { author { login } state createdAt bodyHTML url } }
        files(first: 100) { totalCount nodes { path additions deletions changeType } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 60) { nodes {
          __typename
          ... on CheckRun { name conclusion status detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } } } } }
      }
    }
  }
}`;

// ---------- built-in GitHub browser window ----------
let ghWindow = null;

function isHttpUrl(u) {
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:'; }
  catch (_) { return false; }
}
function isGitHubHost(u) {
  try { const h = new URL(u).hostname.toLowerCase(); return h === 'github.com' || h.endsWith('.github.com'); }
  catch (_) { return false; }
}

// raw/objects/user-attachments/avatars: GitHub redirects downloads and attachments here.
function isGitHubContentHost(u) {
  try { const h = new URL(u).hostname.toLowerCase(); return h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com'); }
  catch (_) { return false; }
}

// GitHub pages that hand off to an identity provider (SAML/OIDC SSO, EMU). OAuth app
// authorization (/login/oauth) is deliberately not one: it redirects to the app's own
// callback, which may be any site.
const GH_AUTH_PATH = /^\/(login|session|sessions|sso|saml|(orgs|enterprises)\/[^/]+\/(sso|saml))(\/|$)/i;
function isGitHubAuthUrl(u) {
  try {
    const p = new URL(u);
    return isGitHubHost(u) && GH_AUTH_PATH.test(p.pathname) && !/^\/login\/oauth(\/|$)/i.test(p.pathname);
  } catch (_) { return false; }
}

// Pages in the GitHub window get no device or OS permissions (camera, mic, location,
// notifications, ...). Copy buttons need clipboard write; video players use fullscreen.
const GH_ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
let ghSessionHardened = false;
function hardenGitHubSession() {
  if (ghSessionHardened) return;
  ghSessionHardened = true;
  const ses = session.fromPartition('persist:github');
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(GH_ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => GH_ALLOWED_PERMISSIONS.has(permission));
}

function openGitHubWindow(url, parent) {
  if (!isHttpUrl(url)) return { ok: false, error: 'not a web URL' };
  if (!isGitHubHost(url)) { shell.openExternal(url); return { ok: true, external: true }; }
  if (ghWindow && !ghWindow.isDestroyed()) {
    ghWindow.loadURL(url);
    if (ghWindow.isMinimized()) ghWindow.restore();
    ghWindow.show(); ghWindow.focus();
    return { ok: true };
  }
  const bounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  const width = bounds ? Math.min(1280, Math.round(bounds.width * 0.8)) : 1200;
  const height = bounds ? Math.min(1000, Math.round(bounds.height * 0.85)) : 900;
  hardenGitHubSession();
  ghWindow = new BrowserWindow({
    width, height,
    x: bounds ? Math.round(bounds.x + (bounds.width - width) / 2) : undefined,
    y: bounds ? Math.round(bounds.y + (bounds.height - height) / 2) : undefined,
    title: 'GitHub — Mac Code',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:github',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const wc = ghWindow.webContents;
  // target=_blank: stay in this window for github.com, hand everything else to the
  // default browser.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isGitHubHost(target)) { setImmediate(() => wc.loadURL(target)); }
    else if (isHttpUrl(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  // Top-level pages stay on GitHub, so a link in an issue or README can't load an
  // arbitrary site in this address-bar-less window. The one exception is a sign-in
  // flow: once a GitHub login/SSO page hands off to an identity provider, any host is
  // allowed (customer IdPs live on their own domains) until the flow lands back on
  // GitHub. Both link/form navigations and server redirects are checked.
  let authFlow = false;
  let navFrom = '';   // URL the current main-frame navigation leg comes from
  const allowTopLevel = (from, target) => {
    if (!isHttpUrl(target)) return false;
    if (isGitHubHost(target) || isGitHubContentHost(target)) return true;
    if (authFlow) return true;
    if (from && isGitHubAuthUrl(from)) { authFlow = true; return true; }
    return false;
  };
  const gate = (e, from, target) => {
    if (allowTopLevel(from, target)) return true;
    e.preventDefault();
    if (isHttpUrl(target)) shell.openExternal(target);
    return false;
  };
  wc.on('will-navigate', (e, target) => { gate(e, wc.getURL(), e.url || target); });
  wc.on('did-start-navigation', (e, target, isInPlace, isMainFrame) => {
    const main = e.isMainFrame !== undefined ? e.isMainFrame : isMainFrame;
    if (main && !(e.isSameDocument !== undefined ? e.isSameDocument : isInPlace)) navFrom = e.url || target;
  });
  wc.on('will-redirect', (e, target, _isInPlace, isMainFrame) => {
    const main = e.isMainFrame !== undefined ? e.isMainFrame : isMainFrame;
    if (!main) return;
    const to = e.url || target;
    if (gate(e, navFrom, to)) navFrom = to;
  });
  wc.on('did-navigate', (_e, u) => { if (isGitHubHost(u)) authFlow = false; });
  // No address bar, so prefix the title with the host whenever the page isn't GitHub
  // (an identity-provider page could otherwise pose as anything).
  const showHost = () => {
    if (!ghWindow || ghWindow.isDestroyed()) return;
    const u = wc.getURL();
    const title = wc.getTitle() || 'GitHub — Mac Code';
    let host = '';
    try { host = new URL(u).hostname; } catch (_) {}
    ghWindow.setTitle(isGitHubHost(u) || !host ? title : '[' + host + '] ' + title);
  };
  wc.on('did-navigate', showHost);
  wc.on('page-title-updated', (e) => { e.preventDefault(); showHost(); });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    // Electron 32+ moved history onto navigationHistory; 31 only has the wc methods.
    const nav = wc.navigationHistory || wc;
    if (input.alt && key === 'arrowleft') { if (nav.canGoBack()) nav.goBack(); e.preventDefault(); }
    else if (input.alt && key === 'arrowright') { if (nav.canGoForward()) nav.goForward(); e.preventDefault(); }
    else if (key === 'f5' || (input.control && key === 'r')) { wc.reload(); e.preventDefault(); }
    else if (input.control && key === 'w') { ghWindow.close(); e.preventDefault(); }
    else if (input.control && input.shift && key === 'o') { shell.openExternal(wc.getURL()); e.preventDefault(); }
  });
  ghWindow.on('closed', () => { ghWindow = null; });
  ghWindow.loadURL(url);
  return { ok: true };
}

// ---------- IPC ----------
function register(ipcMain, getMainWindow, getSettings) {
  ipcMain.handle('gh:status', async () => {
    const r = await ghJson(['api', 'user', '--jq', '{login: .login, name: .name}']);
    if (!r.ok) return { ok: false, error: r.error, missing: !!r.missing };
    return { ok: true, login: r.data.login, name: r.data.name };
  });

  ipcMain.handle('gh:repoForCwd', async (_e, cwd) => {
    if (!cwd || typeof cwd !== 'string') return { repo: null };
    const root = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (!root) return { repo: null };
    const url = await runGit(cwd, ['remote', 'get-url', 'origin']);
    // The main clone behind a worktree: the parent of the shared (common) .git dir.
    const common = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const mainRoot = common && /[\\/]\.git$/i.test(common) ? path.dirname(path.resolve(common)) : path.resolve(root);
    return { repo: repoFromRemote(url), root: root.replace(/\//g, '\\'), mainRoot };
  });

  ipcMain.handle('gh:myRepos', async () => {
    return ghJson(['api', 'user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member',
      '--jq', '[.[] | {nameWithOwner: .full_name, private: .private, pushedAt: .pushed_at}]']);
  });

  ipcMain.handle('gh:prs', async (_e, { repo, filter, search } = {}) => {
    if (!validRepo(repo)) return { ok: false, error: 'bad repo' };
    const args = ['pr', 'list', '--repo', repo, '--limit', '50', '--json', PR_LIST_FIELDS, ...(PR_FILTERS[filter] || PR_FILTERS.open)];
    const q = [PR_FILTER_QUERY[filter], cleanSearch(search)].filter(Boolean).join(' ');
    if (q) args.push('--search', q);
    const r = await ghJson(args);
    if (r.ok) for (const pr of r.data || []) { pr.checks = checksSummary(pr.statusCheckRollup); delete pr.statusCheckRollup; }
    return r;
  });

  ipcMain.handle('gh:issues', async (_e, { repo, filter, search } = {}) => {
    if (!validRepo(repo)) return { ok: false, error: 'bad repo' };
    const args = ['issue', 'list', '--repo', repo, '--limit', '50', '--json', ISSUE_LIST_FIELDS, ...(ISSUE_FILTERS[filter] || ISSUE_FILTERS.open)];
    const q = cleanSearch(search);
    if (q) args.push('--search', q);
    const r = await ghJson(args);
    if (r.ok) for (const it of r.data || []) it.comments = Array.isArray(it.comments) ? it.comments.length : 0;
    return r;
  });

  ipcMain.handle('gh:runs', async (_e, { repo } = {}) => {
    if (!validRepo(repo)) return { ok: false, error: 'bad repo' };
    return ghJson(['run', 'list', '--repo', repo, '--limit', '40', '--json', RUN_LIST_FIELDS]);
  });

  ipcMain.handle('gh:inbox', async (_e, { kind } = {}) => {
    const base = INBOX[kind];
    if (!base) return { ok: false, error: 'bad inbox' };
    const fields = base[0] === 'prs' ? SEARCH_FIELDS : SEARCH_FIELDS.replace(',isDraft', '');
    return ghJson(['search', ...base, '--limit', '50', '--sort', 'updated', '--json', fields]);
  });

  ipcMain.handle('gh:item', async (_e, { repo, number } = {}) => {
    const n = validNumber(number);
    if (!validRepo(repo) || !n) return { ok: false, error: 'bad item' };
    const [owner, name] = repo.split('/');
    const r = await ghJson(['api', 'graphql', '-f', 'query=' + DETAIL_QUERY,
      '-f', 'owner=' + owner, '-f', 'name=' + name, '-F', 'n=' + n]);
    if (!r.ok) return r;
    const item = r.data && r.data.data && r.data.data.repository && r.data.data.repository.issueOrPullRequest;
    if (!item) return { ok: false, error: 'Not found: ' + repo + '#' + n };
    item.repo = repo;
    return { ok: true, data: item };
  });

  // PR for the branch checked out in `cwd` (gh resolves the branch and its upstream).
  ipcMain.handle('gh:prForBranch', async (_e, cwd) => {
    if (!cwd || typeof cwd !== 'string') return { ok: false };
    const r = await ghJson(['pr', 'view', '--json', 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup,headRefName'], { cwd });
    if (!r.ok) return { ok: false, none: /no pull requests? found/i.test(r.error), error: r.error };
    const pr = r.data;
    pr.checks = checksSummary(pr.statusCheckRollup);
    delete pr.statusCheckRollup;
    const url = await runGit(cwd, ['remote', 'get-url', 'origin']);
    pr.repo = repoFromRemote(url) || (/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url) || [])[1] || null;
    return { ok: true, data: pr };
  });

  ipcMain.handle('gh:openWindow', (_e, url) => openGitHubWindow(String(url || ''), getMainWindow()));

  // ---------- worktrees for "Fix with Claude" / "Review with Claude" ----------
  // New work never lands in the user's main checkout: it gets its own worktree at
  // <parent of main clone>\worktrees\<clone name>\<branch with / -> ->, the same layout
  // Mac Code's own repos use, or at github.worktreeTemplate when that is set (validated
  // in settings.js). A worktree that already has the branch checked out (anywhere but
  // the main clone) is reused, as is an existing worktree at the target path.
  ipcMain.handle('gh:worktree', async (_e, { root, branch, detach } = {}) => {
    if (!root || typeof root !== 'string') return { ok: false, error: 'no local clone' };
    const name = String(branch || '');
    if (!name || name.startsWith('-')) return { ok: false, error: 'bad branch name' };
    const fmt = await runGitFull(root, ['check-ref-format', '--branch', name]);
    if (fmt.code !== 0) return { ok: false, error: 'bad branch name: ' + name };

    const list = await runGitFull(root, ['worktree', 'list', '--porcelain']);
    if (list.code !== 0) return { ok: false, error: firstErrorLine(list.stderr) };
    const entries = parseWorktreeList(list.stdout);
    const trees = entries.map((w) => w.path);
    const mainRoot = trees[0];
    if (!mainRoot) return { ok: false, error: 'not a git repository' };
    const existing = entries.slice(1).find((w) => w.branch === 'refs/heads/' + name);
    if (existing) return { ok: true, path: existing.path, reused: true };
    const template = getSettings ? (getSettings().github || {}).worktreeTemplate : '';
    const target = resolveWorktreePath(template, mainRoot, name) ||
      path.join(path.dirname(mainRoot), 'worktrees', path.basename(mainRoot), name.replace(/[\\/]/g, '-'));
    if (trees.some((t) => t.toLowerCase() === target.toLowerCase())) return { ok: true, path: target, reused: true };
    if (fs.existsSync(target)) return { ok: false, error: 'folder exists but is not a worktree: ' + target };

    const def = await defaultBranch(mainRoot);
    const fetch = await runGitFull(mainRoot, ['fetch', 'origin', def]);
    const base = fetch.code === 0 ? 'origin/' + def : def;
    const hasBranch = (await runGitFull(mainRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name])).code === 0;
    const args = detach ? ['worktree', 'add', '--detach', target, base]
      : hasBranch ? ['worktree', 'add', target, name]
      : ['worktree', 'add', '-b', name, target, base];
    const r = await runGitFull(mainRoot, args);
    if (r.code !== 0) return { ok: false, error: firstErrorLine(r.stderr || r.stdout) };
    return { ok: true, path: target, base };
  });

  // ---------- secrets, variables, environments ----------
  // Values go to gh on stdin, never on the command line (argv is visible to every
  // process on the machine), and are never logged or returned. Secret values cannot
  // be read back at all — GitHub's API is write-only for them.
  ipcMain.handle('gh:ownerType', async (_e, owner) => {
    if (!OWNER_RE.test(String(owner || ''))) return { ok: false, error: 'bad owner' };
    return ghJson(['api', 'users/' + owner, '--jq', '{type: .type}']);
  });

  ipcMain.handle('gh:secretList', async (_e, scope = {}) => {
    const s = scopeArgs(scope);
    if (!s) return { ok: false, error: 'bad scope' };
    const fields = scope.org ? 'name,updatedAt,visibility' : 'name,updatedAt';
    return ghJson(['secret', 'list', ...s, '--json', fields]);
  });
  ipcMain.handle('gh:secretSet', async (_e, { scope = {}, name, value, visibility } = {}) => {
    const s = scopeArgs(scope);
    if (!s) return { ok: false, error: 'bad scope' };
    if (!validSecretName(name)) return { ok: false, error: 'Invalid name — letters, digits and _ only, not starting with a digit or GITHUB_' };
    if (typeof value !== 'string' || !value.length) return { ok: false, error: 'Value is empty' };
    const extra = scope.org ? ['--visibility', VISIBILITIES.has(visibility) ? visibility : 'private'] : [];
    return ghRun(['secret', 'set', name, ...s, ...extra], { input: value });
  });
  ipcMain.handle('gh:secretDelete', async (_e, { scope = {}, name } = {}) => {
    const s = scopeArgs(scope);
    if (!s || !validSecretName(name)) return { ok: false, error: 'bad request' };
    return ghRun(['secret', 'delete', name, ...s]);
  });

  ipcMain.handle('gh:varList', async (_e, scope = {}) => {
    const s = scopeArgs(scope);
    if (!s) return { ok: false, error: 'bad scope' };
    const fields = scope.org ? 'name,value,updatedAt,visibility' : 'name,value,updatedAt';
    return ghJson(['variable', 'list', ...s, '--json', fields]);
  });
  ipcMain.handle('gh:varSet', async (_e, { scope = {}, name, value, visibility } = {}) => {
    const s = scopeArgs(scope);
    if (!s) return { ok: false, error: 'bad scope' };
    if (!validSecretName(name)) return { ok: false, error: 'Invalid name — letters, digits and _ only, not starting with a digit or GITHUB_' };
    if (typeof value !== 'string') return { ok: false, error: 'bad value' };
    const extra = scope.org ? ['--visibility', VISIBILITIES.has(visibility) ? visibility : 'private'] : [];
    return ghRun(['variable', 'set', name, ...s, ...extra], { input: value });
  });
  ipcMain.handle('gh:varDelete', async (_e, { scope = {}, name } = {}) => {
    const s = scopeArgs(scope);
    if (!s || !validSecretName(name)) return { ok: false, error: 'bad request' };
    return ghRun(['variable', 'delete', name, ...s]);
  });

  ipcMain.handle('gh:envList', async (_e, { repo } = {}) => {
    if (!validRepo(repo)) return { ok: false, error: 'bad repo' };
    const r = await ghJson(['api', `repos/${repo}/environments?per_page=100`]);
    if (!r.ok) return r;
    const envs = ((r.data && r.data.environments) || []).map((e) => ({
      name: e.name,
      updatedAt: e.updated_at,
      url: e.html_url,
      branchPolicy: !e.deployment_branch_policy ? 'all'
        : e.deployment_branch_policy.protected_branches ? 'protected' : 'custom',
      waitTimer: ((e.protection_rules || []).find((p) => p.type === 'wait_timer') || {}).wait_timer || 0,
      preventSelfReview: !!((e.protection_rules || []).find((p) => p.type === 'required_reviewers') || {}).prevent_self_review,
      reviewers: (((e.protection_rules || []).find((p) => p.type === 'required_reviewers') || {}).reviewers || [])
        .map((x) => x.type === 'Team' ? { type: 'Team', name: x.reviewer && (x.reviewer.slug || x.reviewer.name), id: x.reviewer && x.reviewer.id }
          : { type: 'User', name: x.reviewer && x.reviewer.login, id: x.reviewer && x.reviewer.id })
    }));
    return { ok: true, data: envs };
  });

  // Create or update an environment. Reviewers come in as names ("login" or
  // "org/team-slug") and are resolved to the numeric ids the API wants.
  ipcMain.handle('gh:envSave', async (_e, { repo, name, waitTimer, preventSelfReview, reviewers, branchPolicy } = {}) => {
    if (!validRepo(repo) || !validEnvName(name)) return { ok: false, error: 'Invalid environment name' };
    const wait = Math.max(0, Math.min(43200, Math.round(Number(waitTimer) || 0)));
    const resolved = [];
    for (const raw of (Array.isArray(reviewers) ? reviewers : []).slice(0, 6)) {
      const who = String(raw || '').trim().replace(/^@/, '');
      if (!who) continue;
      const team = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(who);
      if (team) {
        const t = await ghJson(['api', `orgs/${team[1]}/teams/${team[2]}`, '--jq', '{id: .id}']);
        if (!t.ok) return { ok: false, error: 'Team not found: ' + who };
        resolved.push({ type: 'Team', id: t.data.id });
      } else if (OWNER_RE.test(who)) {
        const u = await ghJson(['api', 'users/' + who, '--jq', '{id: .id}']);
        if (!u.ok) return { ok: false, error: 'User not found: ' + who };
        resolved.push({ type: 'User', id: u.data.id });
      } else return { ok: false, error: 'Bad reviewer: ' + who };
    }
    const body = {
      wait_timer: wait,
      prevent_self_review: !!preventSelfReview,
      reviewers: resolved,
      deployment_branch_policy: branchPolicy === 'protected' ? { protected_branches: true, custom_branch_policies: false }
        : branchPolicy === 'custom' ? { protected_branches: false, custom_branch_policies: true }
        : null
    };
    return ghRun(['api', '-X', 'PUT', `repos/${repo}/environments/${encodeURIComponent(name)}`, '--input', '-'],
      { input: JSON.stringify(body) });
  });
  ipcMain.handle('gh:envDelete', async (_e, { repo, name } = {}) => {
    if (!validRepo(repo) || !validEnvName(name)) return { ok: false, error: 'bad request' };
    return ghRun(['api', '-X', 'DELETE', `repos/${repo}/environments/${encodeURIComponent(name)}`]);
  });
}

// ---------- helpers for the write paths ----------
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const VISIBILITIES = new Set(['private', 'all']);

// Same rules GitHub enforces for secret and variable names.
function validSecretName(n) {
  return typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(n) && !/^GITHUB_/i.test(n);
}
function validEnvName(n) {
  return typeof n === 'string' && n.length <= 255 && /^[A-Za-z0-9 ._()-]+$/.test(n) && !n.startsWith('-') && n.trim() === n;
}
// { repo } | { repo, env } | { org } -> gh scope flags, or null if anything is off.
function scopeArgs(scope) {
  if (scope.org) return OWNER_RE.test(scope.org) ? ['--org', scope.org] : null;
  if (!validRepo(scope.repo)) return null;
  if (scope.env != null) return validEnvName(scope.env) ? ['--repo', scope.repo, '--env', scope.env] : null;
  return ['--repo', scope.repo];
}

// Run a gh write and report only success or the error line — never echo stdout,
// which for some commands can include what was sent.
async function ghRun(args, opts) {
  const r = await runGh(args, opts);
  if (r.missing) return { ok: false, error: 'GitHub CLI (gh) is not installed' };
  if (r.code !== 0) return { ok: false, error: firstErrorLine(r.stderr || r.stdout) };
  return { ok: true };
}

function runGitFull(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err ? err.message : '')) });
    });
  });
}

async function defaultBranch(cwd) {
  const head = (await runGitFull(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim();
  if (head) return head.replace(/^origin\//, '');
  for (const cand of ['main', 'master']) {
    if ((await runGitFull(cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + cand])).code === 0) return cand;
  }
  return 'main';
}

// The popup is its own top-level window; without this it would keep the app alive
// after the main window closes.
function closeGitHubWindow() {
  if (ghWindow && !ghWindow.isDestroyed()) ghWindow.destroy();
  ghWindow = null;
}

module.exports = { register, repoFromRemote, checksSummary, closeGitHubWindow };
