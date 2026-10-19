// GitHub dashboard surface.
//
// One view per GitHub tab or per GitHub overlay (renderer.js hosts both): a sidebar with an inbox (review requests, my PRs, assigned
// issues — across every repo) and a list of pinned repos, a list of PRs / issues /
// Actions runs for the selection, and a detail pane for one PR or issue. All data
// comes from window.ghApi (the gh CLI in the main process); nothing here holds a token.
//
// Item bodies and comments arrive as GitHub-rendered HTML. GitHub has already
// sanitised it, but it is still cleaned again here against a small allowlist before it
// touches the DOM, since this renderer has Mac Code's own APIs on window.

(() => {
  'use strict';

  const REPOS_KEY = 'ghRepos';
  const INBOX_POLL_MS = 3 * 60 * 1000;

  const INBOXES = [
    { key: 'prsReview',  label: 'Review requested', kind: 'pr' },
    { key: 'prsMine',    label: 'My pull requests', kind: 'pr' },
    { key: 'issuesMine', label: 'Assigned issues',  kind: 'issue' }
  ];
  const VIEWS = [
    { key: 'prs',     label: 'Pull requests' },
    { key: 'issues',  label: 'Issues' },
    { key: 'actions', label: 'Actions' },
    { key: 'settings', label: 'Settings' }
  ];
  const FILTERS = {
    prs:    [['open', 'Open'], ['review', 'Review requested'], ['mine', 'Mine'], ['merged', 'Merged'], ['closed', 'Closed']],
    issues: [['open', 'Open'], ['mine', 'Assigned to me'], ['created', 'Created by me'], ['closed', 'Closed']]
  };

  // ---------- small helpers ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(path, vb = '0 0 16 16') {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', vb);
    s.innerHTML = path;
    return s;
  }
  function readJson(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function writeJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} }

  // github.links / github.pollSeconds live in the app settings (settingsView.js).
  function setting(key, fallback) {
    const v = window.getAppSetting ? window.getAppSetting('github', key) : undefined;
    return v === undefined ? fallback : v;
  }
  function linksInApp() { return setting('links', 'app') !== 'browser'; }
  // 0 = no timer: refresh only when the tab is shown or on R / the refresh button.
  function pollMs() { return Number(setting('pollSeconds', 60)) * 1000; }

  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24); if (d < 30) return d + 'd ago';
    const mo = Math.round(d / 30); if (mo < 12) return mo + 'mo ago';
    return Math.round(mo / 12) + 'y ago';
  }
  function login(a) { return (a && (a.login || a.name)) || 'ghost'; }

  // Label chip with GitHub's colour, text picked for contrast.
  function labelChip(l) {
    const chip = el('span', 'gh-label', l.name);
    const hex = /^[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '808080';
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    chip.style.setProperty('--lc', `rgb(${r}, ${g}, ${b})`);
    chip.style.setProperty('--lc-bg', `rgba(${r}, ${g}, ${b}, 0.18)`);
    chip.style.setProperty('--lc-fg', (0.299 * r + 0.587 * g + 0.114 * b) > 110 ? `rgb(${r}, ${g}, ${b})` : '#d0d0d0');
    return chip;
  }

  // ---------- icons (Octicon-like shapes) ----------
  const ICON = {
    prOpen:   '<circle cx="4" cy="3.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="4" cy="12.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="12" cy="12.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    prMerged: '<circle cx="4" cy="3.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="4" cy="12.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="12" cy="9" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M4 5.1v5.8M4.5 5.5c1 2 3 3.5 5.9 3.5" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/>',
    prClosed: '<circle cx="4" cy="3.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="4" cy="12.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="12" cy="12.5" r="1.6" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M4 5.1v5.8M12 7v3.9M10.3 2.3l3.4 3.4M13.7 2.3l-3.4 3.4" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/>',
    issueOpen:   '<circle cx="8" cy="8" r="6" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/>',
    issueClosed: '<circle cx="8" cy="8" r="6" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M5.3 8.2l1.9 1.9 3.6-3.8" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    issueNotPlanned: '<circle cx="8" cy="8" r="6" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M4 12L12 4" stroke="currentColor" stroke-width="1.3"/>',
    check: '<path d="M3.5 8.5l3 3 6-7" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    cross: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round"/>',
    dot:   '<circle cx="8" cy="8" r="3.2" fill="currentColor"/>',
    skip:  '<circle cx="8" cy="8" r="5.5" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M4.5 11.5l7-7" stroke="currentColor" stroke-width="1.3"/>',
    refresh: '<path d="M13 5.5A5.5 5.5 0 1 0 13.5 9M13.5 2v3.5H10" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    external: '<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    window: '<rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M2 5.5h12" stroke="currentColor" stroke-width="1.3"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.3" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" stroke="currentColor" fill="none" stroke-width="1.3"/>',
    branch: '<circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" fill="none" stroke-width="1.3"/><circle cx="11.5" cy="5" r="1.5" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" stroke="currentColor" fill="none" stroke-width="1.3"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round"/>',
    pin: '<path d="M8 1.8v12.4M1.8 8h12.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    comment: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke="currentColor" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
    play: '<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>',
    claude: '<path d="M8 1.5l1.3 4.1 4.2-.9-2.9 3.3 2.9 3.3-4.2-.9L8 14.5l-1.3-4.1-4.2.9 2.9-3.3-2.9-3.3 4.2.9z" fill="currentColor"/>',
    lock: '<rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" fill="none" stroke-width="1.3"/>',
    edit: '<path d="M10.5 2.5l3 3-8 8H2.5v-3z" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linejoin="round"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linejoin="round"/>',
    plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    upload: '<path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
    copilot: '<rect x="2.5" y="5" width="11" height="7.5" rx="3" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M8 5V3M6 8.2v1.4M10 8.2v1.4" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/>',
    tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linejoin="round"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/>',
    env: '<rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" fill="none" stroke-width="1.3"/><path d="M5 7l2 1.5L5 10M8.5 10h2.5" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  function icon(name, cls) { const s = svg(ICON[name]); s.classList.add('gh-ico'); if (cls) s.classList.add(cls); return s; }

  function prIcon(pr) {
    const state = String(pr.state || '').toUpperCase();
    if (pr.merged || state === 'MERGED') return icon('prMerged', 'merged');
    if (state === 'CLOSED') return icon('prClosed', 'closed');
    return icon('prOpen', pr.isDraft ? 'draft' : 'open');
  }
  function issueIcon(it) {
    const state = String(it.state || '').toUpperCase();
    if (state === 'CLOSED') return String(it.stateReason || '').toUpperCase() === 'NOT_PLANNED'
      ? icon('issueNotPlanned', 'draft') : icon('issueClosed', 'merged');
    return icon('issueOpen', 'open');
  }
  function checksIcon(state, title) {
    const map = { success: ['check', 'ok'], failure: ['cross', 'fail'], pending: ['dot', 'pending'] };
    const m = map[state];
    if (!m) return null;
    const s = icon(m[0], m[1]);
    const wrap = el('span', 'gh-checks'); wrap.title = title || state;
    wrap.appendChild(s);
    return wrap;
  }
  function runIcon(run) {
    const status = String(run.status || '').toLowerCase();
    if (status && status !== 'completed') return icon('dot', 'pending');
    const c = String(run.conclusion || '').toLowerCase();
    if (c === 'success') return icon('check', 'ok');
    if (c === 'skipped' || c === 'cancelled' || c === 'neutral') return icon('skip', 'draft');
    return icon('cross', 'fail');
  }
  function reviewBadge(decision) {
    const d = String(decision || '').toUpperCase();
    if (d === 'APPROVED') return el('span', 'gh-badge ok', 'Approved');
    if (d === 'CHANGES_REQUESTED') return el('span', 'gh-badge fail', 'Changes requested');
    if (d === 'REVIEW_REQUIRED') return el('span', 'gh-badge', 'Review required');
    return null;
  }

  // ---------- HTML sanitiser for GitHub-rendered bodies ----------
  const KEEP_TAGS = new Set(['A', 'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
    'STRONG', 'EM', 'B', 'I', 'DEL', 'S', 'INS', 'CODE', 'PRE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY',
    'TR', 'TH', 'TD', 'IMG', 'SPAN', 'DIV', 'DETAILS', 'SUMMARY', 'SUP', 'SUB', 'KBD', 'INPUT', 'DL', 'DT', 'DD', 'MARK']);
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG', 'MATH',
    'LINK', 'META', 'BASE', 'TEMPLATE', 'VIDEO', 'AUDIO', 'SOURCE', 'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT']);
  const KEEP_ATTRS = { A: ['href', 'title'], IMG: ['src', 'alt', 'title', 'width', 'height'],
    TD: ['align', 'colspan', 'rowspan'], TH: ['align', 'colspan', 'rowspan'], DETAILS: ['open'],
    INPUT: ['type', 'checked'], OL: ['start'] };

  function safeUrl(u, httpsOnly) {
    try {
      const p = new URL(u, 'https://github.com/');
      if (p.protocol === 'https:') return p.href;
      if (!httpsOnly && (p.protocol === 'http:' || p.protocol === 'mailto:')) return p.href;
    } catch (_) {}
    return null;
  }

  function cleanNode(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) { child.remove(); continue; }
      const tag = child.tagName.toUpperCase();
      if (DROP_TAGS.has(tag)) { child.remove(); continue; }
      cleanNode(child);
      if (!KEEP_TAGS.has(tag)) { child.replaceWith(...Array.from(child.childNodes)); continue; }
      const allowed = KEEP_ATTRS[tag] || [];
      for (const attr of Array.from(child.attributes)) {
        if (!allowed.includes(attr.name.toLowerCase())) child.removeAttribute(attr.name);
      }
      if (tag === 'A') {
        const href = child.getAttribute('href');
        const u = href ? safeUrl(href, false) : null;
        if (u) { child.setAttribute('href', u); child.classList.add('gh-link'); }
        else child.removeAttribute('href');
      } else if (tag === 'IMG') {
        const u = safeUrl(child.getAttribute('src') || '', true);
        if (u) { child.setAttribute('src', u); child.setAttribute('loading', 'lazy'); child.setAttribute('referrerpolicy', 'no-referrer'); }
        else child.remove();
      } else if (tag === 'INPUT') {
        if ((child.getAttribute('type') || '').toLowerCase() !== 'checkbox') { child.remove(); continue; }
        child.setAttribute('disabled', '');
      }
    }
  }

  function renderBody(target, html, emptyText) {
    target.innerHTML = '';
    if (!html || !String(html).trim()) {
      target.appendChild(el('div', 'gh-empty-body', emptyText || 'No description provided.'));
      return;
    }
    const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    cleanNode(doc.body);
    for (const n of Array.from(doc.body.childNodes)) target.appendChild(document.importNode(n, true));
  }

  // ---------- the view ----------
  function createGitHubView(opts = {}) {
    const openLink = opts.openLink || ((url) => window.fileApi.openExternal(url));

    const st = {
      user: null, authError: null,
      repos: readJson(REPOS_KEY, []).filter((r) => typeof r === 'string'),
      here: null,                          // { repo, root } of the active tab's folder
      sel: null,                           // { kind:'inbox', key } | { kind:'repo', repo }
      view: 'prs', filter: { prs: 'open', issues: 'open' }, search: '',
      items: [], listError: null, loading: false, loadedAt: 0,
      cursor: -1,
      detail: null,                        // { repo, number }
      detailData: null,
      inboxCounts: {}, inboxAt: 0,
      myRepos: null,
      active: false, disposed: false
    };
    let listSeq = 0, detailSeq = 0, pollTimer = null;
    const copilotNotes = new Map();        // repo#n -> { kind:'fail'|'warn', text, at } shown under the actions
    const copilotPending = new Set();      // repo#n with a Copilot review request in flight
    let mergeDlg = null;                   // { key, update(d) } while the merge dialog is open
    let unknownRetryKey = null;            // repo#n already re-fetched for UNKNOWN mergeability
    let unknownRetryTimer = null;          // that re-fetch, while it is still pending
    let linksCb = null;                    // the sidebar's "Open GitHub links in Mac Code"

    // ---- skeleton ----
    const root = el('div', 'gh-root');
    root.tabIndex = -1;
    const side = el('div', 'gh-side scroll');
    const main = el('div', 'gh-main');
    root.append(side, main);

    const toolbar = el('div', 'gh-toolbar');
    const titleEl = el('div', 'gh-title');
    const segEl = el('div', 'gh-seg');
    const filterEl = el('select', 'gh-select');
    const searchEl = el('input', 'gh-search');
    searchEl.placeholder = 'Filter…  ( / )';
    searchEl.spellcheck = false;
    const statusEl = el('span', 'gh-status');
    const refreshBtn = el('button', 'gh-icon-btn'); refreshBtn.title = 'Refresh (R)'; refreshBtn.appendChild(icon('refresh'));
    const webBtn = el('button', 'gh-icon-btn'); webBtn.title = 'Open on github.com'; webBtn.appendChild(icon('external'));
    toolbar.append(titleEl, segEl, filterEl, searchEl, statusEl, refreshBtn, webBtn);

    const body = el('div', 'gh-body');
    const listEl = el('div', 'gh-list scroll');
    const detailEl = el('div', 'gh-detail scroll');
    body.append(listEl, detailEl);
    main.append(toolbar, body);

    // ---- sidebar ----
    // Rebuilt wholesale on every change (polls included) — except the open-tabs picker,
    // which sits between the two rebuilt parts so a rebuild never closes its popup or
    // drops its focus. The parts are display: contents, so the sidebar's flex layout
    // sees their children directly.
    const sideTop = el('div', 'gh-side-part');
    const sideBottom = el('div', 'gh-side-part');
    let tabsPick = null, tabsPickSeq = 0;
    if (opts.getOpenTabRepos) tabsPick = openTabsPicker();
    side.append(sideTop);
    if (tabsPick) side.append(tabsPick);
    side.append(sideBottom);

    function renderSide() {
      sideTop.innerHTML = '';
      sideBottom.innerHTML = '';
      renderSideTop(sideTop);
      renderSideBottom(sideBottom);
      fillTabsPicker();
    }
    function renderSideTop(side) {
      const hdr = el('div', 'gh-side-hdr');
      hdr.appendChild(el('span', 'gh-side-brand', 'GitHub'));
      hdr.appendChild(el('span', 'gh-side-user', st.user ? '@' + st.user : st.authError ? 'not signed in' : '…'));
      side.appendChild(hdr);

      if (st.authError) {
        const warn = el('div', 'gh-auth-warn');
        warn.appendChild(el('div', null, st.authError));
        const hint = el('div', 'gh-auth-hint');
        hint.innerHTML = 'Run <code>gh auth login</code> in a terminal, then refresh.';
        warn.appendChild(hint);
        side.appendChild(warn);
      }

      side.appendChild(el('div', 'gh-side-sec', 'Inbox'));
      for (const ib of INBOXES) {
        const row = sideRow(ib.label, st.inboxCounts[ib.key]);
        if (st.sel && st.sel.kind === 'inbox' && st.sel.key === ib.key) row.classList.add('sel');
        row.addEventListener('click', () => select({ kind: 'inbox', key: ib.key }));
        side.appendChild(row);
      }

      side.appendChild(el('div', 'gh-side-sec', 'Repositories'));
    }
    function renderSideBottom(side) {
      const list = [];
      if (st.here && st.here.repo) list.push({ repo: st.here.repo, here: true });
      for (const r of st.repos) if (!list.some((x) => x.repo.toLowerCase() === r.toLowerCase())) list.push({ repo: r });
      if (st.sel && st.sel.kind === 'repo' && !list.some((x) => x.repo.toLowerCase() === st.sel.repo.toLowerCase())) {
        list.push({ repo: st.sel.repo, transient: true });
      }
      for (const item of list) {
        const [owner, name] = item.repo.split('/');
        const row = el('div', 'gh-side-row repo');
        const txt = el('span', 'gh-side-label');
        txt.appendChild(el('span', 'gh-repo-name', name));
        txt.appendChild(el('span', 'gh-repo-owner', owner));
        row.appendChild(txt);
        row.title = item.repo;
        if (item.here) row.appendChild(el('span', 'gh-here', 'here'));
        const pinned = st.repos.some((r) => r.toLowerCase() === item.repo.toLowerCase());
        if (pinned || item.transient) {
          const b = el('span', 'gh-side-x');
          b.title = pinned ? 'Unpin' : 'Pin';
          b.appendChild(icon(pinned ? 'close' : 'pin'));
          b.addEventListener('click', (e) => { e.stopPropagation(); pinned ? unpinRepo(item.repo) : pinRepo(item.repo); });
          row.appendChild(b);
        }
        if (st.sel && st.sel.kind === 'repo' && st.sel.repo.toLowerCase() === item.repo.toLowerCase()) row.classList.add('sel');
        row.addEventListener('click', () => select({ kind: 'repo', repo: item.repo }));
        side.appendChild(row);
      }

      // Add a repo: owner/name, with suggestions from the repos you've pushed to lately.
      const add = el('div', 'gh-add');
      const input = el('input', 'gh-add-input');
      input.placeholder = '+ Add repo (owner/name)';
      input.spellcheck = false;
      const dlId = 'gh-repos-dl-' + Math.random().toString(36).slice(2, 8);
      input.setAttribute('list', dlId);
      const dl = el('datalist'); dl.id = dlId;
      for (const r of st.myRepos || []) { const o = el('option'); o.value = r.nameWithOwner; dl.appendChild(o); }
      input.addEventListener('focus', () => { if (!st.myRepos) loadMyRepos(); });
      input.addEventListener('keydown', (e) => {
        // Esc leaves the field (like the search box) instead of being swallowed here.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.blur(); root.focus(); return; }
        if (e.key === 'Enter') {
          const v = input.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
          if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) { pinRepo(v); select({ kind: 'repo', repo: v }); }
          else input.classList.add('bad');
        } else input.classList.remove('bad');
        e.stopPropagation();
      });
      add.append(input, dl);
      side.appendChild(add);

      const foot = el('label', 'gh-side-foot');
      // Same setting as Settings → GitHub → links; "ask" shows as a mixed checkbox.
      const cb = el('input'); cb.type = 'checkbox';
      linksCb = cb;
      syncLinksCb();
      cb.addEventListener('change', () => {
        if (window.setAppSetting) window.setAppSetting('github', 'links', cb.checked ? 'app' : 'browser').then(syncLinksCb);
      });
      foot.append(cb, el('span', null, 'Open GitHub links in Mac Code'));
      foot.title = 'Clicking a github.com link opens it here (Ctrl+click: default browser). More choices in Settings (Ctrl+,)';
      side.appendChild(foot);
    }
    function syncLinksCb() {
      if (!linksCb) return;
      const mode = setting('links', 'app');
      linksCb.indeterminate = mode === 'ask';
      linksCb.checked = mode === 'app';
    }
    // "Open tabs" picker: jump to the repo behind any open tab without leaving GitHub.
    // Created once; refilled when the sidebar renders, when the view is shown, and on
    // hover/press so a tab that changed folder shows up before the popup opens.
    function openTabsPicker() {
      const sel = el('select', 'gh-select gh-tabs-pick');
      sel.title = 'Switch to the repo of an open tab';
      sel.setAttribute('aria-label', 'Repo of an open tab');
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (!v || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return;
        // Back to the view, so j/k/Esc work at once (and a stray letter can't type-ahead
        // into the picker and jump again).
        root.focus();
        select({ kind: 'repo', repo: v });
      });
      // On a closed select, arrows, Home/End/PageUp/PageDown and type-ahead letters change
      // the value at once — each a repo jump. Swallow them; navigation keys open the list
      // instead so it can be browsed (Alt+Down, F4 and Space open it natively).
      const NAV = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']);
      sel.addEventListener('keydown', (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (NAV.has(e.key)) {
          e.preventDefault();
          if (typeof sel.showPicker === 'function') { try { sel.showPicker(); } catch (_) {} }
        } else if (e.key.length === 1 && e.key !== ' ') e.preventDefault();
      });
      // Cached lookups resolve within the same task, and fillTabsPicker leaves the options
      // alone when nothing changed; hovering first gives a new folder's lookup time.
      sel.addEventListener('mouseenter', () => fillTabsPicker());
      sel.addEventListener('mousedown', () => fillTabsPicker());
      return sel;
    }
    async function fillTabsPicker() {
      const sel = tabsPick;
      if (!sel || !opts.getOpenTabRepos) return;
      const seq = ++tabsPickSeq;
      let list = [];
      try { list = (await opts.getOpenTabRepos()) || []; } catch (_) { list = []; }
      if (st.disposed || seq !== tabsPickSeq) return;
      const cur0 = st.sel && st.sel.kind === 'repo' ? st.sel.repo.toLowerCase() : '';
      const sig = cur0 + '|' + list.map((r) => r.repo + ':' + (r.tabs || []).join(',')).join('|');
      if (sel.dataset.sig === sig) return;
      sel.dataset.sig = sig;
      sel.textContent = '';
      const ph = el('option', null, list.length ? 'Open tabs…' : 'No open tab is in a GitHub repo');
      ph.value = '';
      sel.appendChild(ph);
      const cur = st.sel && st.sel.kind === 'repo' ? st.sel.repo.toLowerCase() : null;
      for (const r of list) {
        const o = el('option', null, r.repo + (r.tabs && r.tabs.length ? '  ·  ' + r.tabs.join(', ') : ''));
        o.value = r.repo;
        if (cur && r.repo.toLowerCase() === cur) o.selected = true;
        sel.appendChild(o);
      }
    }
    function sideRow(label, count) {
      const row = el('div', 'gh-side-row');
      row.appendChild(el('span', 'gh-side-label', label));
      if (count != null) row.appendChild(el('span', 'gh-count', String(count)));
      return row;
    }

    async function loadMyRepos() {
      st.myRepos = [];
      const r = await window.ghApi.myRepos();
      if (st.disposed) return;
      st.myRepos = r && r.ok ? r.data || [] : [];
      const dl = side.querySelector('datalist');
      if (dl) {
        dl.innerHTML = '';
        for (const x of st.myRepos) { const o = el('option'); o.value = x.nameWithOwner; dl.appendChild(o); }
      }
    }

    function pinRepo(repo) {
      if (!st.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
        st.repos.push(repo); writeJson(REPOS_KEY, st.repos);
      }
      renderSide();
    }
    function unpinRepo(repo) {
      st.repos = st.repos.filter((r) => r.toLowerCase() !== repo.toLowerCase());
      writeJson(REPOS_KEY, st.repos);
      renderSide();
    }

    // ---- toolbar ----
    function renderToolbar() {
      titleEl.innerHTML = '';
      segEl.innerHTML = '';
      filterEl.innerHTML = '';
      const sel = st.sel;
      if (!sel) return;
      if (sel.kind === 'inbox') {
        const ib = INBOXES.find((x) => x.key === sel.key);
        titleEl.textContent = ib ? ib.label : 'Inbox';
        segEl.style.display = 'none';
        filterEl.style.display = 'none';
      } else {
        titleEl.appendChild(el('span', 'gh-title-owner', sel.repo.split('/')[0] + ' / '));
        titleEl.appendChild(el('span', null, sel.repo.split('/')[1]));
        segEl.style.display = '';
        for (const v of VIEWS) {
          const b = el('button', 'gh-seg-btn' + (st.view === v.key ? ' on' : ''), v.label);
          b.addEventListener('click', () => {
            if (st.view === v.key) return;
            st.view = v.key; st.cursor = -1;
            if (v.key === 'settings' && st.detail) closeDetail();
            renderToolbar(); loadList(); notify();
          });
          segEl.appendChild(b);
        }
        const f = FILTERS[st.view];
        filterEl.style.display = f ? '' : 'none';
        if (f) {
          for (const [val, label] of f) { const o = el('option', null, label); o.value = val; filterEl.appendChild(o); }
          filterEl.value = st.filter[st.view];
        }
      }
      searchEl.style.display = sel.kind === 'repo' && (st.view === 'prs' || st.view === 'issues') ? '' : 'none';
      searchEl.value = st.search;
      webBtn.style.display = '';
    }

    filterEl.addEventListener('change', () => { st.filter[st.view] = filterEl.value; st.cursor = -1; loadList(); notify(); });
    let searchTimer = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st.search = searchEl.value.trim(); st.cursor = -1; loadList(); }, 450);
    });
    searchEl.addEventListener('keydown', (e) => {
      // preventDefault: the overlay host (renderer.js) closes on an Esc nobody handled.
      if (e.key === 'Escape') { e.preventDefault(); searchEl.blur(); root.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); root.focus(); moveCursor(1); }
      e.stopPropagation();
    });
    refreshBtn.addEventListener('click', () => refresh(true));
    webBtn.addEventListener('click', (e) => {
      const url = currentWebUrl();
      if (url) openLink(url, e, { web: true });
    });

    function currentWebUrl() {
      const sel = st.sel;
      if (!sel) return null;
      if (sel.kind === 'inbox') {
        if (sel.key === 'prsReview') return 'https://github.com/pulls/review-requested';
        if (sel.key === 'prsMine') return 'https://github.com/pulls';
        return 'https://github.com/issues/assigned';
      }
      if (st.view === 'settings') {
        return 'https://github.com/' + sel.repo + (set.tab === 'environments' ? '/settings/environments' : '/settings/' + set.tab + '/actions');
      }
      const tail = st.view === 'prs' ? '/pulls' : st.view === 'issues' ? '/issues' : '/actions';
      return 'https://github.com/' + sel.repo + tail;
    }

    function setStatus(text, cls) {
      statusEl.textContent = text || '';
      statusEl.className = 'gh-status' + (cls ? ' ' + cls : '');
    }
    function updateAgeStatus() {
      if (st.loading) setStatus('Loading…', 'busy');
      else if (st.listError) setStatus('Error', 'err');
      else if (st.loadedAt) setStatus('Updated ' + ago(new Date(st.loadedAt).toISOString()));
      else setStatus('');
    }

    // ---- list ----
    async function loadList(quiet) {
      const sel = st.sel;
      if (!sel) return;
      // Settings never auto-refresh: a form may be open, and nothing there changes by itself.
      if (sel.kind === 'repo' && st.view === 'settings') { listSeq++; if (!quiet) loadSettings(); return; }
      const seq = ++listSeq;
      st.loading = true;
      if (!quiet) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'gh-placeholder', 'Loading…')); }
      updateAgeStatus();
      let r;
      try {
        if (sel.kind === 'inbox') r = await window.ghApi.inbox({ kind: sel.key });
        else if (st.view === 'prs') r = await window.ghApi.prs({ repo: sel.repo, filter: st.filter.prs, search: st.search });
        else if (st.view === 'issues') r = await window.ghApi.issues({ repo: sel.repo, filter: st.filter.issues, search: st.search });
        else r = await window.ghApi.runs({ repo: sel.repo });
      } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      if (seq !== listSeq || st.disposed) return;
      st.loading = false;
      if (!r || !r.ok) {
        st.listError = (r && r.error) || 'Request failed';
        if (!quiet || !st.items.length) { st.items = []; renderList(); }
      } else {
        st.listError = null;
        st.items = Array.isArray(r.data) ? r.data : [];
        st.loadedAt = Date.now();
        if (sel.kind === 'inbox') { st.inboxCounts[sel.key] = st.items.length; renderSide(); }
        renderList();
      }
      updateAgeStatus();
    }

    function itemKind() {
      if (st.sel && st.sel.kind === 'inbox') return (INBOXES.find((x) => x.key === st.sel.key) || {}).kind || 'pr';
      return st.view === 'prs' ? 'pr' : st.view === 'issues' ? 'issue' : 'run';
    }
    function itemRepo(it) { return (it.repository && it.repository.nameWithOwner) || (st.sel && st.sel.repo) || null; }

    function renderList() {
      listEl.innerHTML = '';
      if (st.listError) {
        const box = el('div', 'gh-placeholder err');
        box.appendChild(el('div', null, st.listError));
        listEl.appendChild(box);
        return;
      }
      if (!st.items.length) { listEl.appendChild(el('div', 'gh-placeholder', 'Nothing here.')); return; }
      const kind = itemKind();
      st.items.forEach((it, i) => {
        const row = kind === 'run' ? runRow(it) : kind === 'pr' ? prRow(it) : issueRow(it);
        row.dataset.idx = String(i);
        if (i === st.cursor) row.classList.add('cursor');
        if (kind !== 'run' && st.detail && st.detail.number === it.number && st.detail.repo === itemRepo(it)) row.classList.add('sel');
        listEl.appendChild(row);
      });
    }

    function rowShell(iconEl, title, metaParts, right) {
      const row = el('div', 'gh-row');
      const ic = el('div', 'gh-row-ico'); ic.appendChild(iconEl);
      const mid = el('div', 'gh-row-mid');
      const t = el('div', 'gh-row-title'); t.appendChild(title);
      const meta = el('div', 'gh-row-meta');
      for (const p of metaParts.filter(Boolean)) {
        if (meta.childNodes.length) meta.appendChild(el('span', 'gh-meta-sep', '·'));
        meta.appendChild(typeof p === 'string' ? el('span', null, p) : p);
      }
      mid.append(t, meta);
      const rt = el('div', 'gh-row-right');
      for (const r of (right || []).filter(Boolean)) rt.appendChild(r);
      row.append(ic, mid, rt);
      return row;
    }
    function titleFrag(it) {
      const f = document.createDocumentFragment();
      f.appendChild(el('span', 'gh-row-text', it.title || '(untitled)'));
      for (const l of (it.labels || []).slice(0, 4)) f.appendChild(labelChip(l));
      return f;
    }

    function prRow(pr) {
      const repo = itemRepo(pr);
      const inInbox = st.sel && st.sel.kind === 'inbox';
      const branch = pr.headRefName ? el('span', 'gh-mono', pr.headRefName) : null;
      const diff = pr.additions != null ? (() => {
        const d = el('span', 'gh-diffstat');
        d.append(el('span', 'add', '+' + pr.additions), el('span', 'del', '−' + pr.deletions));
        return d;
      })() : null;
      const checks = pr.checks ? checksIcon(pr.checks.state,
        `${pr.checks.pass} passed, ${pr.checks.fail} failed, ${pr.checks.pending} pending`) : null;
      const row = rowShell(prIcon(pr), titleFrag(pr), [
        inInbox ? el('span', 'gh-meta-repo', repo) : null,
        '#' + pr.number, login(pr.author), branch, pr.isDraft ? 'draft' : null, ago(pr.updatedAt)
      ], [reviewBadge(pr.reviewDecision), checks, diff]);
      row.addEventListener('click', () => openDetail(repo, pr.number));
      return row;
    }
    function issueRow(it) {
      const repo = itemRepo(it);
      const inInbox = st.sel && st.sel.kind === 'inbox';
      const comments = it.comments ? (() => {
        const c = el('span', 'gh-comments'); c.append(icon('comment'), document.createTextNode(String(it.comments))); return c;
      })() : null;
      const assignees = (it.assignees || []).map(login).join(', ');
      const row = rowShell(issueIcon(it), titleFrag(it), [
        inInbox ? el('span', 'gh-meta-repo', repo) : null,
        '#' + it.number, login(it.author), assignees ? '→ ' + assignees : null, ago(it.updatedAt)
      ], [comments]);
      row.addEventListener('click', () => openDetail(repo, it.number));
      return row;
    }
    function runRow(run) {
      const f = document.createDocumentFragment();
      f.appendChild(el('span', 'gh-row-text', run.displayTitle || run.workflowName));
      const row = rowShell(runIcon(run), f, [
        run.workflowName, run.headBranch ? el('span', 'gh-mono', run.headBranch) : null, run.event,
        '#' + run.number, ago(run.createdAt)
      ], []);
      row.title = 'Open run (Ctrl+click: browser)';
      row.addEventListener('click', (e) => { if (run.url) openLink(run.url, e); });
      return row;
    }

    function moveCursor(d) {
      if (!st.items.length) return;
      st.cursor = Math.max(0, Math.min(st.items.length - 1, (st.cursor < 0 ? (d > 0 ? -1 : st.items.length) : st.cursor) + d));
      for (const r of listEl.querySelectorAll('.gh-row')) r.classList.toggle('cursor', r.dataset.idx === String(st.cursor));
      const cur = listEl.querySelector('.gh-row.cursor');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }
    function activateCursor(e) {
      const cur = listEl.querySelector('.gh-row.cursor');
      if (cur) cur.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: !!(e && e.ctrlKey) }));
    }

    // ---- detail ----
    async function openDetail(repo, number) {
      if (!repo || !number) return;
      st.detail = { repo, number };
      root.classList.add('has-detail');
      for (const r of listEl.querySelectorAll('.gh-row')) {
        const it = st.items[Number(r.dataset.idx)];
        r.classList.toggle('sel', !!it && it.number === number && itemRepo(it) === repo);
      }
      const seq = ++detailSeq;
      if (!st.detailData || st.detailData.repo !== repo || st.detailData.number !== number) {
        detailEl.innerHTML = '';
        detailEl.appendChild(el('div', 'gh-placeholder', 'Loading ' + repo + '#' + number + '…'));
      }
      notify();
      let r;
      try { r = await window.ghApi.item({ repo, number }); } catch (e) { r = { ok: false, error: String(e) }; }
      if (seq !== detailSeq || st.disposed) return;
      if (!r || !r.ok) {
        detailEl.innerHTML = '';
        const box = el('div', 'gh-placeholder err');
        box.appendChild(el('div', null, (r && r.error) || 'Could not load item'));
        const open = el('button', 'gh-btn', 'Open on github.com');
        open.addEventListener('click', (e) => openLink(`https://github.com/${repo}/issues/${number}`, e));
        box.appendChild(open);
        detailEl.append(closeRow(), box);
        return;
      }
      st.detailData = r.data;
      renderDetail(r.data);
      // GitHub computes mergeability lazily: UNKNOWN right after a push. Ask once more.
      const key = repo + '#' + number;
      if (!mergeUnknown(r.data)) {
        // Known now: a later push that makes it UNKNOWN again gets its own retry.
        if (unknownRetryKey === key) unknownRetryKey = null;
      } else if (unknownRetryKey !== key) {
        unknownRetryKey = key;
        clearTimeout(unknownRetryTimer);
        unknownRetryTimer = setTimeout(() => {
          unknownRetryTimer = null;
          if (!st.disposed && st.detail && st.detail.repo === repo && st.detail.number === number) openDetail(repo, number);
        }, 2000);
      }
    }
    // A retry that hasn't fired yet is dropped (hidden or disposed); the next load of
    // that item may schedule it again.
    function cancelUnknownRetry() {
      if (!unknownRetryTimer) return;
      clearTimeout(unknownRetryTimer);
      unknownRetryTimer = null;
      unknownRetryKey = null;
    }

    function closeDetail() {
      st.detail = null; st.detailData = null; detailSeq++;
      root.classList.remove('has-detail');
      detailEl.innerHTML = '';
      for (const r of listEl.querySelectorAll('.gh-row.sel')) r.classList.remove('sel');
      notify();
    }

    function closeRow() {
      const b = el('button', 'gh-icon-btn gh-detail-close'); b.title = 'Close (Esc)';
      b.appendChild(icon('close'));
      b.addEventListener('click', closeDetail);
      return b;
    }

    function actionBtn(iconName, label, onClick, title) {
      const b = el('button', 'gh-btn');
      b.appendChild(icon(iconName));
      b.appendChild(el('span', null, label));
      if (title) b.title = title;
      b.addEventListener('click', onClick);
      return b;
    }

    // Comment / review card (also the fallback Conversation rendering).
    function commentCard(ev, at) {
      const copilot = ev.kind === 'review' && ev.authorIsBot && /^copilot/i.test(String(ev.author || ''));
      const card = el('div', 'gh-comment' + (ev.kind === 'review' ? ' review ' + String(ev.state).toLowerCase() : '') + (copilot ? ' copilot' : ''));
      const ch = el('div', 'gh-comment-hdr');
      ch.appendChild(el('strong', null, typeof ev.author === 'string' ? ev.author : login(ev.author)));
      if (ev.kind === 'review') {
        const s = String(ev.state);
        ch.appendChild(el('span', 'gh-badge ' + (s === 'APPROVED' ? 'ok' : s === 'CHANGES_REQUESTED' ? 'fail' : ''),
          s === 'APPROVED' ? 'approved' : s === 'CHANGES_REQUESTED' ? 'requested changes' : s === 'DISMISSED' ? 'dismissed' : 'reviewed'));
      }
      const t = el('span', 'gh-comment-time', ago(at));
      if (ev.url) { t.classList.add('link'); t.title = 'Open comment'; t.addEventListener('click', (e) => openLink(ev.url, e)); }
      ch.appendChild(t);
      card.appendChild(ch);
      if (String(ev.bodyHTML || '').trim()) {
        const b = el('div', 'gh-md');
        renderBody(b, ev.bodyHTML);
        card.appendChild(b);
      }
      for (const th of Array.isArray(ev.threads) ? ev.threads : []) card.appendChild(threadBlock(th));
      return card;
    }

    // One inline review thread: collapsible file header, then its comments.
    // Threads the user opened or closed by hand, keyed by first comment URL, so a poll
    // refresh doesn't snap them back to the default.
    const threadToggled = new Map();
    function threadBlock(th) {
      const key = th.comments && th.comments[0] && th.comments[0].url;
      const collapsed = key && threadToggled.has(key) ? threadToggled.get(key) : !!th.resolved;
      const box = el('div', 'gh-thread' + (collapsed ? ' collapsed' : ''));
      const hdr = el('div', 'gh-thread-hdr'); hdr.tabIndex = 0; hdr.setAttribute('role', 'button');
      hdr.appendChild(el('span', 'gh-mono', String(th.path || '') + (!th.fileLevel && th.line != null ? ':' + th.line : '')));
      if (th.outdated) hdr.appendChild(el('span', 'gh-badge', 'outdated'));
      if (th.resolved) hdr.appendChild(el('span', 'gh-badge ok', 'resolved'));
      const toggle = () => {
        const c = box.classList.toggle('collapsed');
        if (key) threadToggled.set(key, c);
        hdr.setAttribute('aria-expanded', String(!c));
      };
      hdr.setAttribute('aria-expanded', String(!collapsed));
      hdr.addEventListener('click', toggle);
      hdr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      box.appendChild(hdr);
      for (const c of Array.isArray(th.comments) ? th.comments : []) {
        const row = el('div', 'gh-thread-c');
        const h = el('div', 'gh-comment-hdr');
        h.appendChild(el('strong', null, c.author || 'ghost'));
        const t = el('span', 'gh-comment-time', ago(c.at));
        if (c.url) { t.classList.add('link'); t.title = 'Open comment'; t.addEventListener('click', (e) => openLink(c.url, e)); }
        h.appendChild(t);
        row.appendChild(h);
        if (String(c.bodyHTML || '').trim()) { const b = el('div', 'gh-md'); renderBody(b, c.bodyHTML); row.appendChild(b); }
        box.appendChild(row);
      }
      if (th.more > 0) box.appendChild(el('div', 'gh-more', '+' + th.more + ' more repl' + (th.more === 1 ? 'y' : 'ies') + ' on github.com'));
      return box;
    }

    const isCopilotName = (n) => /^copilot/i.test(String(n || ''));
    const spaced = (v) => String(v == null ? '' : v).replace(/[_-]+/g, ' ').trim().toLowerCase();

    // One compact timeline row: icon on the line, bold actor, text, time at the right.
    function tlRow(ico, icoCls, actor, text, at, extra) {
      const row = el('div', 'gh-tl-row' + (extra ? ' ' + extra : ''));
      const i = el('span', 'gh-tl-ico');
      i.appendChild(icon(ico, icoCls));
      row.appendChild(i);
      const body = el('span', 'gh-tl-text');
      if (actor) { body.appendChild(el('strong', 'gh-tl-actor', actor)); body.appendChild(document.createTextNode(' ')); }
      if (text instanceof Node) body.appendChild(text); else body.appendChild(document.createTextNode(String(text == null ? '' : text)));
      row.appendChild(body);
      const t = ago(at);
      if (t) row.appendChild(el('span', 'gh-tl-time', t));
      return row;
    }

    // Row for one non-card, non-commit event.
    function eventRow(ev) {
      const a = ev.actor || null, at = ev.at;
      const row = (ico, cls, text, extra) => tlRow(ico, cls, a, text, at, extra);
      const k = ev.kind;
      switch (k) {
        case 'review': {
          const s = String(ev.state || '');
          const cp = ev.authorIsBot && isCopilotName(ev.author);
          return tlRow(s === 'APPROVED' ? 'check' : s === 'CHANGES_REQUESTED' ? 'cross' : 'eye', s === 'APPROVED' ? 'ok' : s === 'CHANGES_REQUESTED' ? 'fail' : '',
            ev.author || null, s === 'APPROVED' ? 'approved these changes' : s === 'CHANGES_REQUESTED' ? 'requested changes' : s === 'DISMISSED' ? 'review dismissed' : 'reviewed', at, cp ? 'copilot' : '');
        }
        case 'review_requested': case 'review_request_removed': {
          const cp = ev.reviewerIsBot && isCopilotName(ev.reviewer);
          const who = ev.reviewer || 'a reviewer';
          return row(cp ? 'copilot' : 'eye', '', (k === 'review_requested' ? 'requested a review from ' : 'removed the review request for ') + who, cp ? 'copilot' : '');
        }
        case 'copilot': {
          const ph = ev.phase, via = ev.via;
          let text;
          if (ph === 'failed') text = via === 'review' ? 'Copilot review failed' : via === 'agent' ? 'Copilot failed working' : 'Copilot failed work';
          else if (via === 'review') text = ph === 'finished' ? 'Copilot finished reviewing' : 'Copilot started reviewing' + (a ? ' on behalf of ' + a : '');
          else if (via === 'agent') text = 'Copilot ' + (ph === 'finished' ? 'finished' : 'started') + ' working';
          else text = 'Copilot ' + (ph === 'finished' ? 'finished' : 'started') + ' work';
          return tlRow('copilot', ph === 'failed' ? 'fail' : ph === 'finished' ? 'ok' : 'pending', null, text, at, 'copilot');
        }
        case 'merged': return row('prMerged', 'merged', 'merged' + (ev.commit ? ' commit ' + ev.commit : ''));
        case 'referenced': return row('dot', '', 'referenced this' + (ev.commit ? ' in commit ' + ev.commit : ''));
        case 'closed': return row('prClosed', 'closed', 'closed this');
        case 'reopened': return row('prOpen', 'open', 'reopened this');
        case 'ready_for_review': return row('prOpen', 'open', 'marked this as ready for review');
        case 'convert_to_draft': return row('prOpen', 'draft', 'marked this as a draft');
        case 'head_ref_force_pushed': return row('branch', '', 'force-pushed the branch');
        case 'head_ref_deleted': return row('branch', '', 'deleted the branch');
        case 'head_ref_restored': return row('branch', '', 'restored the branch');
        case 'base_ref_changed': return row('branch', '', 'changed the base branch');
        case 'base_ref_force_pushed': return row('branch', '', 'force-pushed the base branch');
        case 'auto_merge_enabled': return row('prMerged', 'merged', 'enabled auto-merge');
        case 'auto_merge_disabled': return row('prMerged', '', 'disabled auto-merge');
        case 'added_to_merge_queue': return row('prMerged', 'merged', 'added this to the merge queue');
        case 'removed_from_merge_queue': return row('prMerged', '', 'removed this from the merge queue');
        case 'locked': return row('lock', '', 'locked this conversation');
        case 'unlocked': return row('lock', '', 'unlocked this conversation');
        case 'deployed': return row('dot', '', 'deployed this');
        case 'review_dismissed': return row('cross', '', 'dismissed a review' + (ev.state ? ' (' + spaced(ev.state) + ')' : '') + (ev.message ? ': ' + ev.message : ''));
        case 'labeled': case 'unlabeled': {
          const f = document.createDocumentFragment();
          f.appendChild(document.createTextNode(k === 'labeled' ? 'added ' : 'removed '));
          f.appendChild(labelChip(ev.label || { name: 'label' }));
          return row('tag', '', f);
        }
        case 'assigned': return row('dot', '', 'assigned ' + (ev.assignee || 'someone'));
        case 'unassigned': return row('dot', '', 'unassigned ' + (ev.assignee || 'someone'));
        case 'milestoned': return row('dot', '', 'added this to the ' + (ev.milestone || '') + ' milestone');
        case 'demilestoned': return row('dot', '', 'removed this from the ' + (ev.milestone || '') + ' milestone');
        case 'renamed': return row('edit', '', 'changed the title from "' + (ev.from || '') + '" to "' + (ev.to || '') + '"');
        case 'cross_referenced': {
          const src = ev.source || {};
          const f = document.createDocumentFragment();
          f.appendChild(document.createTextNode('mentioned this in '));
          const lk = el('span', 'gh-tl-link', (src.repo || '') + (src.number != null ? '#' + src.number : '') + (src.title ? ' ' + src.title : ''));
          if (src.url) { lk.classList.add('link'); lk.addEventListener('click', (e) => openLink(src.url, e)); }
          f.appendChild(lk);
          return row(src.isPr ? 'prOpen' : 'issueOpen', '', f);
        }
        default: return row('dot', '', spaced(ev.event || k));
      }
    }

    function timelineSection(tl) {
      const box = el('div', 'gh-tl');
      let n = 0;
      for (let i = 0; i < tl.length; i++) {
        const ev = tl[i];
        if (!ev || typeof ev !== 'object') continue;
        if (ev.kind === 'comment' || (ev.kind === 'review' && (String(ev.bodyHTML || '').trim() || (Array.isArray(ev.threads) && ev.threads.length)))) {
          box.appendChild(commentCard(ev, ev.at)); n++;
        } else if (ev.kind === 'commit') {
          const group = [];
          while (i < tl.length && tl[i] && tl[i].kind === 'commit') group.push(tl[i++]);
          i--;
          const wrap = el('div', 'gh-tl-commits');
          wrap.appendChild(tlRow('dot', '', null, group.length === 1 ? 'Commit' : group.length + ' commits', group[0].at));
          for (const c of group) {
            const line = el('div', 'gh-tl-commit');
            line.appendChild(el('span', 'gh-mono', String(c.sha || '').slice(0, 7)));
            line.appendChild(el('span', 'gh-tl-msg', c.message || ''));
            if (c.url) { line.classList.add('link'); line.title = 'Open commit'; line.addEventListener('click', (e) => openLink(c.url, e)); }
            wrap.appendChild(line);
          }
          box.appendChild(wrap); n++;
        } else { const r = eventRow(ev); if (r) { box.appendChild(r); n++; } }
      }
      const sec = section('Timeline', n);
      if (!n) sec.appendChild(el('div', 'gh-empty-body', 'No activity yet.'));
      else sec.appendChild(box);
      return sec;
    }

    function renderDetail(d) {
      const isPr = d.__typename === 'PullRequest';
      const scrollTop = detailEl.scrollTop;
      const same = detailEl.dataset.key === d.repo + '#' + d.number;
      detailEl.innerHTML = '';
      detailEl.dataset.key = d.repo + '#' + d.number;

      // Head: title, state, actions.
      const head = el('div', 'gh-d-head');
      const top = el('div', 'gh-d-top');
      top.appendChild(el('span', 'gh-d-repo', d.repo));
      top.appendChild(closeRow());
      const h = el('h2', 'gh-d-title');
      h.appendChild(document.createTextNode(d.title + ' '));
      h.appendChild(el('span', 'gh-d-num', '#' + d.number));
      head.append(top, h);

      const stateRow = el('div', 'gh-d-state');
      const state = String(d.state || '').toUpperCase();
      const label = isPr ? (d.merged ? 'Merged' : state === 'CLOSED' ? 'Closed' : d.isDraft ? 'Draft' : 'Open')
        : state === 'CLOSED' ? 'Closed' : 'Open';
      const pill = el('span', 'gh-state ' + label.toLowerCase());
      pill.appendChild(isPr ? prIcon(d) : issueIcon(d));
      pill.appendChild(el('span', null, label));
      stateRow.appendChild(pill);
      if (isPr && state === 'OPEN' && !d.merged) {
        if (d.isInMergeQueue) stateRow.appendChild(el('span', 'gh-badge merge', queueLabel(d)));
        if (d.autoMergeRequest) stateRow.appendChild(el('span', 'gh-badge merge', autoMergeLabel(d)));
      }
      const prOpen = isPr && state === 'OPEN' && !d.merged;
      if (prOpen && d.copilotReview === 'reviewing') stateRow.appendChild(el('span', 'gh-badge pending', 'Copilot reviewing\u2026'));
      else if (prOpen && d.copilotReview === 'requested') stateRow.appendChild(el('span', 'gh-badge pending', 'Copilot review requested'));
      else if (prOpen && d.copilotReview === 'failed') stateRow.appendChild(el('span', 'gh-badge fail', 'Copilot review failed'));
      const by = el('span', 'gh-d-by');
      by.appendChild(el('strong', null, login(d.author)));
      by.appendChild(document.createTextNode(' opened ' + ago(d.createdAt)));
      stateRow.appendChild(by);
      if (isPr) {
        const br = el('span', 'gh-d-branch');
        br.appendChild(icon('branch'));
        br.appendChild(el('span', 'gh-mono', d.headRefName));
        br.appendChild(document.createTextNode(' → '));
        br.appendChild(el('span', 'gh-mono', d.baseRefName));
        stateRow.appendChild(br);
      }
      head.appendChild(stateRow);

      const actions = el('div', 'gh-d-actions');
      if (isPr && state === 'OPEN' && !d.merged && canMerge(d) && !d.isInMergeQueue) {
        const auto = !!d.autoMergeRequest;
        const mb = actionBtn('prMerged', auto ? 'Auto-merge on…' : mergeQueueRequired(d) ? 'Merge queue…' : 'Merge…',
          () => openMergeDialog(d), auto ? 'Auto-merge is enabled: view or turn it off' : 'Merge this pull request');
        if (!auto) mb.classList.add('primary');
        actions.appendChild(mb);
      }
      actions.appendChild(actionBtn('window', 'Window', () => window.ghApi.openWindow(d.url), 'Open in a Mac Code GitHub window'));
      actions.appendChild(actionBtn('external', 'Browser', () => window.fileApi.openExternal(d.url), 'Open in your default browser'));
      actions.appendChild(actionBtn('copy', 'Copy link', (e) => {
        navigator.clipboard.writeText(d.url).then(() => {
          const s = e.currentTarget.querySelector('span'); if (s) { s.textContent = 'Copied'; setTimeout(() => { s.textContent = 'Copy link'; }, 1200); }
        }).catch(() => {});
      }));
      if (opts.onWork && state === 'OPEN') {
        const work = (action) => startWork(action, d);
        if (isPr) {
          actions.appendChild(actionBtn('claude', 'Review with Claude', () => work('review'),
            'Check the PR out (detached) in its own worktree and start Claude on a review'));
          actions.appendChild(actionBtn('branch', 'Checkout', () => work('checkout'),
            'gh pr checkout in its own worktree, in a new terminal'));
        } else {
          actions.appendChild(actionBtn('claude', 'Fix with Claude', () => work('fix'),
            'New branch + worktree for this issue, then start Claude on it'));
        }
      }
      if (prOpen && window.ghApi && window.ghApi.requestCopilotReview &&
          ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE'].includes(repoInfo(d).viewerPermission) && !copilotRequested(d)) {
        const pending = copilotPending.has(d.repo + '#' + d.number);
        const cb = actionBtn('copilot', pending ? 'Requesting…' : copilotReviewed(d) ? 'Re-request Copilot review' : 'Request Copilot review',
          () => requestCopilot(d, cb), 'Ask Copilot to review this pull request');
        cb.disabled = pending;
        actions.appendChild(cb);
      }
      head.appendChild(actions);
      const noteKey = d.repo + '#' + d.number;
      const note = copilotNotes.get(noteKey);
      if (note && Date.now() - note.at < 5 * 60 * 1000 && !copilotRequested(d)) head.appendChild(el('div', 'gh-d-note ' + note.kind, note.text));
      else if (note) copilotNotes.delete(noteKey);
      detailEl.appendChild(head);

      // Facts: labels, assignees, review, diff.
      const facts = el('div', 'gh-d-facts');
      const fact = (k, v) => { if (!v) return; const r = el('div', 'gh-fact'); r.appendChild(el('span', 'gh-fact-k', k)); const vv = el('span', 'gh-fact-v'); vv.append(v); r.appendChild(vv); facts.appendChild(r); };
      const labels = (d.labels && d.labels.nodes) || [];
      if (labels.length) { const f = document.createDocumentFragment(); labels.forEach((l) => f.appendChild(labelChip(l))); fact('Labels', f); }
      const assignees = ((d.assignees && d.assignees.nodes) || []).map(login).join(', ');
      fact('Assignees', assignees);
      if (isPr) {
        const reqs = ((d.reviewRequests && d.reviewRequests.nodes) || [])
          .map((n) => n.requestedReviewer && (n.requestedReviewer.login || n.requestedReviewer.name)).filter(Boolean).join(', ');
        fact('Reviewers', reqs);
        const rb = reviewBadge(d.reviewDecision); if (rb) fact('Review', rb);
        const ds = el('span', 'gh-diffstat');
        ds.append(el('span', 'add', '+' + d.additions), el('span', 'del', '−' + d.deletions),
          el('span', 'files', d.changedFiles + ' file' + (d.changedFiles === 1 ? '' : 's')));
        fact('Changes', ds);
        if (d.mergeable === 'CONFLICTING') fact('Merge', el('span', 'gh-badge fail', 'Conflicts'));
      }
      if (facts.childNodes.length) detailEl.appendChild(facts);

      // Checks.
      if (isPr) {
        const rollup = d.commits && d.commits.nodes && d.commits.nodes[0] && d.commits.nodes[0].commit.statusCheckRollup;
        const ctx = (rollup && rollup.contexts && rollup.contexts.nodes) || [];
        if (ctx.length) {
          const sec = section('Checks', ctx.length);
          const list = el('div', 'gh-checklist');
          const order = (c) => { const s = checkState(c); return s === 'fail' ? 0 : s === 'pending' ? 1 : 2; };
          for (const c of ctx.slice().sort((a, b) => order(a) - order(b))) {
            const s = checkState(c);
            const row = el('div', 'gh-check-row');
            row.appendChild(icon(s === 'ok' ? 'check' : s === 'fail' ? 'cross' : s === 'skip' ? 'skip' : 'dot', s === 'skip' ? 'draft' : s));
            row.appendChild(el('span', 'gh-check-name', c.name || c.context));
            const url = c.detailsUrl || c.targetUrl;
            if (url) { row.classList.add('link'); row.addEventListener('click', (e) => openLink(url, e)); }
            list.appendChild(row);
          }
          sec.appendChild(list);
          sec.classList.toggle('collapsed', !ctx.some((c) => checkState(c) !== 'ok' && checkState(c) !== 'skip'));
          detailEl.appendChild(sec);
        }
      }

      // Description.
      const desc = el('div', 'gh-md');
      renderBody(desc, d.bodyHTML);
      detailEl.appendChild(desc);

      // Files.
      if (isPr && d.files && d.files.nodes && d.files.nodes.length) {
        const sec = section('Files changed', d.files.totalCount);
        sec.classList.add('collapsed');
        const list = el('div', 'gh-files');
        for (const f of d.files.nodes) {
          const row = el('div', 'gh-file-row');
          row.appendChild(el('span', 'gh-file-kind ' + String(f.changeType || '').toLowerCase(), (f.changeType || '?')[0]));
          row.appendChild(el('span', 'gh-file-path', f.path));
          const ds = el('span', 'gh-diffstat');
          ds.append(el('span', 'add', '+' + f.additions), el('span', 'del', '−' + f.deletions));
          row.appendChild(ds);
          list.appendChild(row);
        }
        if (d.files.totalCount > d.files.nodes.length) list.appendChild(el('div', 'gh-more', `+ ${d.files.totalCount - d.files.nodes.length} more on github.com`));
        sec.appendChild(list);
        detailEl.appendChild(sec);
      }

      // Timeline (full, in display order) or, if it failed to load, comments + reviews.
      if (Array.isArray(d.timeline)) detailEl.appendChild(timelineSection(d.timeline));
      else {
        const events = [];
        for (const c of (d.comments && d.comments.nodes) || []) events.push({ kind: 'comment', ...c });
        for (const r of (d.reviews && d.reviews.nodes) || []) {
          if (r.state === 'COMMENTED' && !String(r.bodyHTML || '').trim()) continue; // inline-only review
          events.push({ kind: 'review', ...r });
        }
        events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const total = (d.comments && d.comments.totalCount) || 0;
        const sec = section('Conversation', events.length);
        if (total > ((d.comments && d.comments.nodes) || []).length) {
          sec.appendChild(el('div', 'gh-more', `Showing the latest ${d.comments.nodes.length} of ${total} comments`));
        }
        if (!events.length) sec.appendChild(el('div', 'gh-empty-body', 'No comments yet.'));
        for (const ev of events) sec.appendChild(commentCard(ev, ev.createdAt));
        detailEl.appendChild(sec);
      }

      if (same) detailEl.scrollTop = scrollTop;
      // An open merge dialog for this PR follows every refresh (poll, retry, refetch).
      if (mergeDlg && mergeDlg.key === d.repo + '#' + d.number) mergeDlg.update(d);
    }

    function checkState(c) {
      if (c.__typename === 'StatusContext') {
        const s = String(c.state || '').toUpperCase();
        return s === 'SUCCESS' ? 'ok' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'fail';
      }
      if (String(c.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
      const k = String(c.conclusion || '').toUpperCase();
      if (k === 'SUCCESS') return 'ok';
      if (k === 'SKIPPED' || k === 'NEUTRAL' || k === 'CANCELLED') return 'skip';
      return 'fail';
    }

    function section(title, count) {
      const sec = el('div', 'gh-sec');
      const hdr = el('div', 'gh-sec-hdr');
      hdr.appendChild(el('span', 'gh-sec-chev', '▾'));
      hdr.appendChild(el('span', null, title));
      if (count != null) hdr.appendChild(el('span', 'gh-count', String(count)));
      hdr.addEventListener('click', () => sec.classList.toggle('collapsed'));
      sec.appendChild(hdr);
      return sec;
    }

    // Links inside rendered bodies go through the app's link router.
    detailEl.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      openLink(a.getAttribute('href'), e);
    });
    detailEl.addEventListener('auxclick', (e) => { if (e.target.closest && e.target.closest('a[href]')) e.preventDefault(); });

    // ---- modal ----
    // In-view dialog (never window.confirm: a native dialog blocks the whole app).
    // actions: [{ label, kind: 'primary'|'danger'|undefined, onClick(close, setError, setBusy) }]
    // Returns { close, setError, setBusy, buttons } (buttons: the action buttons, in order).
    // lockWhileBusy: while setBusy(true) is on, Cancel, X, Esc and the backdrop can't
    // close it (a gh write is running and its result belongs in the dialog).
    function showModal({ title, body, actions, wide, cancelLabel, onClose, lockWhileBusy }) {
      const overlay = el('div', 'gh-modal-overlay');
      const box = el('div', 'gh-modal' + (wide ? ' wide' : ''));
      const hdr = el('div', 'gh-modal-hdr');
      hdr.appendChild(el('span', null, title));
      const x = el('button', 'gh-icon-btn'); x.appendChild(icon('close'));
      hdr.appendChild(x);
      const content = el('div', 'gh-modal-body');
      if (body) content.appendChild(body);
      const err = el('div', 'gh-modal-err');
      const foot = el('div', 'gh-modal-foot');
      box.append(hdr, content, err, foot);
      overlay.appendChild(box);
      root.appendChild(overlay);
      let closed = false, locked = false;
      // Idempotent. Focus goes back to the view only if it was in the dialog: a close that
      // lands later (a gh call finishing) never takes focus from wherever the user went.
      const close = () => {
        if (closed) return;
        closed = true;
        // body: the focused button was disabled by setBusy, which drops focus there.
        const a = document.activeElement;
        const hadFocus = !a || a === document.body || box.contains(a);
        // Drop typed values with the DOM so nothing secret lingers in a detached node.
        for (const f of box.querySelectorAll('input, textarea')) f.value = '';
        overlay.remove();
        if (onClose) onClose();
        // Not while the view is hidden (overlay closed, tab in the background).
        if (hadFocus && root.getClientRects().length) root.focus();
      };
      const userClose = () => { if (!locked) close(); };
      const setError = (m) => { err.classList.remove('busy'); err.textContent = m || ''; err.style.display = m ? '' : 'none'; };
      const buttons = [];
      // Disable the action buttons while a write is in flight; `label` is progress text.
      const setBusy = (on, label) => {
        for (const b of buttons) b.disabled = !!on;
        if (lockWhileBusy) { locked = !!on; cancel.disabled = !!on; x.disabled = !!on; }
        if (label != null) {
          err.textContent = label;
          err.style.display = label ? '' : 'none';
          err.classList.toggle('busy', !!on);
        }
      };
      setError('');
      const cancel = el('button', 'gh-btn', cancelLabel || 'Cancel');
      cancel.addEventListener('click', userClose);
      foot.appendChild(cancel);
      for (const a of actions || []) {
        const b = el('button', 'gh-btn' + (a.kind ? ' ' + a.kind : ''), a.label);
        b.addEventListener('click', () => a.onClick(close, setError, setBusy));
        buttons.push(b);
        foot.appendChild(b);
      }
      x.addEventListener('click', userClose);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) userClose(); });
      box.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); userClose(); }
        if (e.key === 'Enter' && e.ctrlKey && buttons.length) buttons[buttons.length - 1].click();
      });
      box.tabIndex = -1;
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', title);
      x.title = 'Close (Esc)';
      x.setAttribute('aria-label', 'Close');
      requestAnimationFrame(() => { if (closed || !root.getClientRects().length) return; const f = box.querySelector('input:not([readonly]):not([type=checkbox]):not([type=radio]), textarea, select'); (f || box).focus(); });
      return { close, setError, setBusy, buttons };
    }
    function confirmModal(title, message, label, onYes) {
      const p = el('div', 'gh-modal-text', message);
      showModal({ title, body: p, actions: [{ label, kind: 'danger', onClick: async (close, setError, setBusy) => {
        setBusy(true, 'Working…');
        const r = await onYes();
        if (r && r.ok === false) { setBusy(false, ''); setError(r.error || 'Failed'); return; }
        close();
      } }] });
    }
    function field(labelText, input, hint) {
      const wrap = el('label', 'gh-field');
      wrap.appendChild(el('span', 'gh-field-label', labelText));
      wrap.appendChild(input);
      if (hint) wrap.appendChild(el('span', 'gh-field-hint', hint));
      return wrap;
    }
    function textInput(value, placeholder) {
      const i = el('input', 'gh-input'); i.value = value || ''; i.placeholder = placeholder || ''; i.spellcheck = false; i.autocomplete = 'off';
      return i;
    }

    // ---- merge (gh pr merge via ghApi.merge) ----
    // Direct merge, auto-merge, merge queue and "turn auto-merge off" all go through one
    // dialog. Whatever gh answers, the PR is fetched again afterwards and that fresh state
    // decides what the user is told: gh can fail after GitHub already did the work (or
    // succeed with a warning), so its exit code alone is not the truth.
    const MERGE_METHODS = [
      { key: 'squash', label: 'Squash and merge', hint: 'All commits become one commit on the base branch.', allowed: 'squashMergeAllowed' },
      { key: 'merge',  label: 'Create a merge commit', hint: 'All commits are kept, plus a merge commit.', allowed: 'mergeCommitAllowed' },
      { key: 'rebase', label: 'Rebase and merge', hint: 'All commits are replayed onto the base branch.', allowed: 'rebaseMergeAllowed' }
    ];
    const METHOD_NAME = { MERGE: 'merge commit', SQUASH: 'squash', REBASE: 'rebase' };
    const MERGE_STATE_TEXT = {
      CLEAN: ['ok', 'Ready to merge.'],
      HAS_HOOKS: ['ok', 'Ready to merge (the repository runs pre-receive hooks).'],
      UNSTABLE: ['pending', 'Can be merged, but some checks that are not required are failing or still running.'],
      BLOCKED: ['fail', 'Blocked: required reviews or checks are not satisfied yet.'],
      BEHIND: ['fail', 'The branch is behind the base branch and must be updated before it can be merged.'],
      DIRTY: ['fail', 'The branch has conflicts with the base branch.'],
      DRAFT: ['fail', 'This pull request is a draft.'],
      UNKNOWN: ['pending', 'GitHub is still working out whether this can be merged…']
    };

    function copilotRequested(d) {
      if (d.copilotReview === 'requested' || d.copilotReview === 'reviewing') return true;
      return ((d.reviewRequests && d.reviewRequests.nodes) || []).some((n) => n && n.requestedReviewer && /^copilot/i.test(String(n.requestedReviewer.login || '')));
    }
    function copilotReviewed(d) {
      return Array.isArray(d.timeline) && d.timeline.some((ev) => ev.kind === 'review' && ev.authorIsBot && /^copilot/i.test(String(ev.author || '')));
    }
    async function requestCopilot(d, btn) {
      const key = d.repo + '#' + d.number;
      if (copilotPending.has(key)) return;
      copilotPending.add(key);
      btn.disabled = true;
      const lab = btn.querySelector('span'); if (lab) lab.textContent = 'Requesting…';
      let r, f;
      try {
        try { r = await window.ghApi.requestCopilotReview({ repo: d.repo, number: d.number }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
        f = await fetchItem(d.repo, d.number);
      } finally { copilotPending.delete(key); }
      const fresh = f && f.ok ? f.data : null;
      if (st.disposed) return;
      if (!r || !r.ok) copilotNotes.set(key, { kind: 'fail', text: 'Could not request a Copilot review: ' + ((r && r.error) || 'unknown error'), at: Date.now() });
      else if (fresh && !copilotRequested(fresh)) copilotNotes.set(key, { kind: 'warn', text: 'gh accepted the request, but GitHub does not show Copilot as a reviewer. Is Copilot code review available for this repo and your account?', at: Date.now() });
      else copilotNotes.delete(key);
      applyFresh(d.repo, d.number, fresh);
    }
    function repoInfo(d) { return (d && d.repoInfo) || {}; }
    function canMerge(d) {
      return !!(window.ghApi && window.ghApi.merge) && ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repoInfo(d).viewerPermission);
    }
    function mergeQueueRequired(d) { return repoInfo(d).mergeQueueRequired === true; }
    function mergeUnknown(d) {
      return !!d && d.__typename === 'PullRequest' && String(d.state).toUpperCase() === 'OPEN' &&
        (d.mergeStateStatus === 'UNKNOWN' || d.mergeable === 'UNKNOWN');
    }
    function queueLabel(d) {
      const pos = d.mergeQueueEntry && Number.isInteger(d.mergeQueueEntry.position) ? d.mergeQueueEntry.position : null;
      return 'In merge queue' + (pos != null ? ' (#' + pos + ')' : '');
    }
    function autoMergeLabel(d) {
      const m = d.autoMergeRequest && METHOD_NAME[d.autoMergeRequest.mergeMethod];
      return 'Auto-merge on' + (m ? ' (' + m + ')' : '');
    }
    // Why this PR can't be merged at all right now (null = it may be).
    function mergeBlock(d) {
      if (d.isDraft || d.mergeStateStatus === 'DRAFT') return 'This pull request is a draft. Mark it as ready for review on GitHub first.';
      if (d.mergeable === 'CONFLICTING' || d.mergeStateStatus === 'DIRTY') return 'This branch has conflicts with the base branch. Resolve them first (for example with Checkout and a merge of the base branch).';
      return null;
    }
    function checksSummaryLine(d) {
      const rollup = d.commits && d.commits.nodes && d.commits.nodes[0] && d.commits.nodes[0].commit.statusCheckRollup;
      const ctx = (rollup && rollup.contexts && rollup.contexts.nodes) || [];
      if (!ctx.length) return ['ok', 'No checks on the latest commit.'];
      let ok = 0, fail = 0, pending = 0;
      for (const c of ctx) { const s = checkState(c); if (s === 'fail') fail++; else if (s === 'pending') pending++; else ok++; }
      const parts = [ok + ' passed'];
      if (fail) parts.push(fail + ' failing');
      if (pending) parts.push(pending + ' pending');
      return [fail ? 'fail' : pending ? 'pending' : 'ok', 'Checks: ' + parts.join(', ') + '.'];
    }
    function reviewLine(d) {
      const r = String(d.reviewDecision || '').toUpperCase();
      if (r === 'APPROVED') return ['ok', 'Review: approved.'];
      if (r === 'CHANGES_REQUESTED') return ['fail', 'Review: changes requested.'];
      if (r === 'REVIEW_REQUIRED') return ['pending', 'Review: an approving review is required.'];
      return ['ok', 'Review: no review required.'];
    }
    // gh's message plus a plain explanation where we recognise the cause.
    function explainMergeError(err, d) {
      const msg = String(err || 'Merge failed');
      let why = null;
      if (/head branch was modified|match-head-commit|head commit/i.test(msg)) {
        why = 'New commits were pushed to the pull request after this dialog opened. Review them, then merge again.';
      } else if (d && d.mergeStateStatus === 'BEHIND' || /not up to date|is behind|out-of-date/i.test(msg)) {
        why = 'The branch is behind the base branch. Update it first (for example "Update branch" on github.com).' +
          (repoInfo(d).autoMergeAllowed && !mergeQueueRequired(d) ? ' Or turn on auto-merge so it merges once it is up to date.' : '');
      } else if (/required status|status check|review|protected branch|base branch policy|not mergeable/i.test(msg)) {
        why = 'Branch protection blocks the merge: required reviews or checks are not satisfied.' +
          (repoInfo(d).autoMergeAllowed && !mergeQueueRequired(d) ? ' Turn on auto-merge to merge automatically once they are.' : '');
      } else if (/conflict/i.test(msg)) {
        why = 'The branch has conflicts with the base branch.';
      }
      return why ? why + '\n\ngh: ' + msg : msg;
    }
    async function fetchItem(repo, number) {
      try { return await window.ghApi.item({ repo, number }); } catch (e) { return { ok: false, error: String(e) }; }
    }
    // After a merge call: show the fresh state underneath and refresh the list.
    function applyFresh(repo, number, fresh) {
      if (st.disposed) return;
      if (st.detail && st.detail.repo === repo && st.detail.number === number) {
        // detailSeq++: a poll fetch started before the write must not render over this.
        if (fresh) { detailSeq++; st.detailData = fresh; renderDetail(fresh); }
        else openDetail(repo, number);
      }
      loadList(true);
    }

    function statusRow(kind, text) {
      const row = el('div', 'gh-merge-line');
      row.appendChild(icon(kind === 'ok' ? 'check' : kind === 'fail' ? 'cross' : 'dot', kind));
      row.appendChild(el('span', null, text));
      return row;
    }

    function openMergeDialog(d0) {
      const key = d0.repo + '#' + d0.number;
      const repo = d0.repo, number = d0.number;
      const headOid = d0.headRefOid;                 // what the user is looking at; --match-head-commit
      if (d0.autoMergeRequest) { openDisableAutoDialog(d0); return; }
      const info = repoInfo(d0);
      const queue = mergeQueueRequired(d0);
      const cross = d0.isCrossRepository === true;
      const body = el('div', 'gh-merge');
      const statusBox = el('div', 'gh-merge-status');
      statusBox.setAttribute('aria-live', 'polite');
      const blockBox = el('div', 'gh-merge-block');
      body.append(statusBox, blockBox);

      // Method (not with a merge queue: the queue's own rules decide).
      let radios = [];
      if (!queue) {
        let allowed = MERGE_METHODS.filter((m) => info[m.allowed] === true);
        if (!allowed.length) allowed = MERGE_METHODS;
        const want = setting('mergeMethod', 'merge');
        const pick = allowed.some((m) => m.key === want) ? want : allowed[0].key;
        const fs = el('fieldset', 'gh-merge-methods');
        fs.appendChild(el('legend', 'gh-field-label', 'Merge method'));
        const name = 'gh-merge-m-' + Math.random().toString(36).slice(2, 8);
        for (const m of allowed) {
          const lab = el('label', 'gh-check gh-merge-method');
          const r = el('input'); r.type = 'radio'; r.name = name; r.value = m.key; r.checked = m.key === pick;
          const txt = el('span');
          txt.appendChild(el('span', 'gh-merge-method-name', m.label));
          txt.appendChild(el('span', 'gh-field-hint', ' — ' + m.hint));
          lab.append(r, txt);
          fs.appendChild(lab);
          radios.push(r);
        }
        body.appendChild(fs);
      } else {
        body.appendChild(el('div', 'gh-modal-text',
          `${repo} requires a merge queue for ${d0.baseRefName}. The pull request is added to the queue and GitHub merges it after the queue's checks pass, with the method the queue is set up for.`));
      }

      // Auto-merge (repo must allow it; not with a queue, where adding already waits).
      let autoCb = null;
      if (!queue && info.autoMergeAllowed === true) {
        const lab = el('label', 'gh-check');
        autoCb = el('input'); autoCb.type = 'checkbox';
        autoCb.checked = d0.mergeStateStatus === 'BLOCKED' || d0.mergeStateStatus === 'BEHIND';
        lab.append(autoCb, el('span', null, 'Auto-merge when all requirements are met (gh pr merge --auto)'));
        body.appendChild(lab);
      }

      // Delete the head branch (never with auto-merge or a queue: gh can't, the repo setting applies).
      const delLab = el('label', 'gh-check');
      const delCb = el('input'); delCb.type = 'checkbox';
      delCb.checked = setting('deleteBranchOnMerge', false) === true;
      const delTxt = el('span');
      delTxt.append(document.createTextNode('Delete branch '), el('span', 'gh-mono', d0.headRefName || ''), document.createTextNode(' after merge'));
      delLab.append(delCb, delTxt);
      const delHint = el('div', 'gh-field-hint');
      body.append(delLab, delHint);

      const repoDeletes = info.deleteBranchOnMerge === true;
      function syncOptions() {
        const auto = !!(autoCb && autoCb.checked);
        const noDelete = queue || auto || cross;
        delCb.disabled = noDelete;
        delLab.classList.toggle('off', noDelete);
        if (cross) delHint.textContent = 'The branch lives in a fork, so it is not deleted from here.';
        else if (queue || auto) {
          delHint.textContent = (queue ? 'With the merge queue' : 'With auto-merge') +
            ', the repository setting "Automatically delete head branches" decides (currently ' + (repoDeletes ? 'on' : 'off') + ').';
        } else delHint.textContent = repoDeletes ? 'The repository also deletes merged head branches automatically.' : '';
        delHint.style.display = delHint.textContent ? '' : 'none';
        if (dlg && dlg.buttons[0]) dlg.buttons[0].textContent = confirmLabel();
      }
      function confirmLabel() {
        if (queue) return 'Add #' + number + ' to merge queue';
        if (autoCb && autoCb.checked) return 'Enable auto-merge for #' + number;
        return 'Merge #' + number;
      }

      let headMoved = false, running = false;
      function update(d) {
        statusBox.innerHTML = '';
        const ms = MERGE_STATE_TEXT[d.mergeStateStatus];
        statusBox.append(statusRow(...checksSummaryLine(d)), statusRow(...reviewLine(d)));
        if (ms) statusBox.appendChild(statusRow(ms[0], ms[1]));
        if (String(d.state).toUpperCase() !== 'OPEN' || d.merged) {
          blockBox.textContent = d.merged ? 'This pull request has been merged.' : 'This pull request is closed.';
        } else if (d.headRefOid && d.headRefOid !== headOid) {
          headMoved = true;
          blockBox.textContent = 'New commits were pushed after this dialog opened. Close it and review them before merging.';
        } else blockBox.textContent = mergeBlock(d) || '';
        blockBox.style.display = blockBox.textContent ? '' : 'none';
        if (dlg && dlg.buttons[0] && !running) dlg.buttons[0].disabled = !!blockBox.textContent;
      }

      const dlg = showModal({
        title: queue ? 'Merge queue: #' + number : 'Merge #' + number, wide: true, body, lockWhileBusy: true,
        onClose: () => { if (mergeDlg && mergeDlg.key === key) mergeDlg = null; },
        actions: [{ label: confirmLabel(), kind: 'primary', onClick: async (close, setError, setBusy) => {
          if (headMoved || running) return;
          if (!/^[0-9a-f]{40}$/.test(headOid || '')) { setError('The head commit of this pull request is unknown. Refresh and try again.'); return; }
          const auto = !!(autoCb && autoCb.checked);
          const radio = radios.find((r) => r.checked);
          const method = radio ? radio.value : null;
          const args = { repo, number, matchHead: headOid };
          if (queue) args.queue = true;
          else {
            args.method = method;
            if (auto) args.auto = true;
            else if (!cross && delCb.checked) args.deleteBranch = true;
          }
          running = true;
          setError('');
          setBusy(true, queue ? 'Adding to the merge queue…' : auto ? 'Enabling auto-merge…' : 'Merging…');
          let r;
          try { r = await window.ghApi.merge(args); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
          const f = await fetchItem(repo, number);
          if (st.disposed) return;
          const fresh = f && f.ok ? f.data : null;
          const done = !!fresh && (fresh.merged || String(fresh.state).toUpperCase() === 'MERGED' ||
            (queue && fresh.isInMergeQueue) || (auto && !!fresh.autoMergeRequest));
          running = false;
          if (r && r.ok || done) {
            close();
            applyFresh(repo, number, fresh);
            const what = fresh && fresh.merged ? 'Merged #' + number
              : fresh && fresh.isInMergeQueue ? '#' + number + ': ' + queueLabel(fresh)
              : fresh && fresh.autoMergeRequest ? '#' + number + ': ' + autoMergeLabel(fresh)
              : queue ? '#' + number + ' added to the merge queue' : auto ? 'Auto-merge enabled for #' + number : 'Merged #' + number;
            setStatus(what);
            if (!(r && r.ok)) {
              showModal({ title: what, cancelLabel: 'Close', actions: [],
                body: el('div', 'gh-modal-text', 'GitHub shows the change, but gh reported a problem:\n\n' + ((r && r.error) || 'unknown error')) });
            }
            return;
          }
          setBusy(false, '');
          if (fresh) { applyFresh(repo, number, fresh); update(fresh); }
          setError(explainMergeError(r && r.error, fresh || d0));
        } }]
      });
      mergeDlg = { key, update };
      if (autoCb) autoCb.addEventListener('change', syncOptions);
      syncOptions();
      update(d0);
    }

    function openDisableAutoDialog(d) {
      const key = d.repo + '#' + d.number;
      const repo = d.repo, number = d.number;
      const body = el('div', 'gh-merge');
      const text = el('div', 'gh-modal-text');
      function update(x) {
        text.textContent = x.autoMergeRequest
          ? autoMergeLabel(x) + (x.autoMergeRequest.enabledAt ? ', turned on ' + ago(x.autoMergeRequest.enabledAt) : '') +
            '. GitHub merges #' + number + ' by itself once the required reviews and checks pass.'
          : 'Auto-merge is no longer on for #' + number + '.';
      }
      body.appendChild(text);
      showModal({
        title: 'Auto-merge: #' + number, body, lockWhileBusy: true,
        onClose: () => { if (mergeDlg && mergeDlg.key === key) mergeDlg = null; },
        actions: [{ label: 'Turn off auto-merge', kind: 'danger', onClick: async (close, setError, setBusy) => {
          setError('');
          setBusy(true, 'Turning off auto-merge…');
          let r;
          try { r = await window.ghApi.merge({ repo, number, disableAuto: true }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
          const f = await fetchItem(repo, number);
          if (st.disposed) return;
          const fresh = f && f.ok ? f.data : null;
          if (r && r.ok || (fresh && !fresh.autoMergeRequest)) {
            close();
            applyFresh(repo, number, fresh);
            setStatus('Auto-merge off for #' + number);
            return;
          }
          setBusy(false, '');
          if (fresh) applyFresh(repo, number, fresh);
          setError((r && r.error) || 'Failed');
        } }]
      });
      mergeDlg = { key, update };
      update(d);
    }

    // ---- start work in a worktree (Fix / Review with Claude, Checkout) ----
    async function startWork(action, d) {
      let rootPath = (opts.getClone && opts.getClone(d.repo)) ||
        (st.here && st.here.repo && st.here.repo.toLowerCase() === d.repo.toLowerCase() ? st.here.root : null);
      const run = async (rp, close, setError, setBusy) => {
        if (setBusy) setBusy(true, 'Creating worktree…');
        else setStatus('Creating worktree…', 'busy');
        const r = await opts.onWork({ action, repo: d.repo, number: d.number, title: d.title, root: rp });
        if (!r || !r.ok) {
          const msg = (r && r.error) || 'Failed';
          if (setError) { setBusy(false, ''); setError(msg); }
          else { updateAgeStatus(); showModal({ title: 'Could not start', body: el('div', 'gh-modal-text', msg), actions: [] }); }
          return;
        }
        if (close) close();
        updateAgeStatus();
      };
      if (rootPath) { run(rootPath); return; }
      // No clone known for this repo yet: ask where it lives.
      const input = textInput('', 'C:\\dev\\' + d.repo.split('/')[1]);
      const body = el('div');
      const tpl = setting('worktreeTemplate', '');
      const where = tpl
        ? `A new worktree is created at ${tpl} (Settings → GitHub).`
        : 'A new worktree is created next to it under …\\worktrees\\ (change it in Settings → GitHub).';
      body.appendChild(el('div', 'gh-modal-text', `Where is your local clone of ${d.repo}? ${where} (Opening a terminal in the clone once also teaches Mac Code the path.)`));
      body.appendChild(field('Local clone', input));
      showModal({ title: 'Local clone', body, actions: [{ label: 'Continue', kind: 'primary', onClick: (close, setError, setBusy) => {
        const v = input.value.trim().replace(/^"|"$/g, '');
        if (!v) { setError('Enter a folder'); return; }
        run(v, close, setError, setBusy);
      } }] });
    }

    // ---- settings: secrets, variables, environments ----
    const SET_TABS = [['secrets', 'Secrets'], ['variables', 'Variables'], ['environments', 'Environments']];
    const set = { tab: 'secrets', scope: 'repo', envs: null, ownerIsOrg: null, data: null, error: null, repo: null };
    let setSeq = 0;

    function scopeObj() {
      const repo = st.sel.repo;
      if (set.scope === 'org') return { org: repo.split('/')[0] };
      if (set.scope.startsWith('env:')) return { repo, env: set.scope.slice(4) };
      return { repo };
    }
    function scopeLabel() {
      if (set.scope === 'org') return 'organization ' + st.sel.repo.split('/')[0];
      if (set.scope.startsWith('env:')) return 'environment "' + set.scope.slice(4) + '"';
      return 'repository ' + st.sel.repo;
    }

    async function loadSettings() {
      const repo = st.sel.repo;
      if (set.repo !== repo) { Object.assign(set, { repo, scope: 'repo', envs: null, ownerIsOrg: null, data: null }); }
      const seq = ++setSeq;
      set.error = null;
      st.loading = true; updateAgeStatus();
      renderSettings(true);
      const jobs = [];
      if (set.envs == null) jobs.push(window.ghApi.envList({ repo }).then((r) => { if (seq === setSeq) set.envs = r && r.ok ? r.data : []; }));
      if (set.ownerIsOrg == null) jobs.push(window.ghApi.ownerType(repo.split('/')[0]).then((r) => { if (seq === setSeq) set.ownerIsOrg = !!(r && r.ok && r.data.type === 'Organization'); }));
      await Promise.all(jobs);
      if (seq !== setSeq || st.disposed) return;
      if (set.scope.startsWith('env:') && !(set.envs || []).some((e) => 'env:' + e.name === set.scope)) set.scope = 'repo';
      let r;
      if (set.tab === 'environments') r = await window.ghApi.envList({ repo });
      else if (set.tab === 'secrets') r = await window.ghApi.secretList(scopeObj());
      else r = await window.ghApi.varList(scopeObj());
      if (seq !== setSeq || st.disposed) return;
      st.loading = false;
      if (!r || !r.ok) { set.error = (r && r.error) || 'Request failed'; set.data = []; }
      else {
        set.data = (r.data || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        if (set.tab === 'environments') set.envs = set.data;
        st.loadedAt = Date.now();
      }
      renderSettings(false);
      updateAgeStatus();
    }

    function renderSettings(loading) {
      listEl.innerHTML = '';
      const wrap = el('div', 'gh-settings');
      const bar = el('div', 'gh-set-bar');
      const seg = el('div', 'gh-seg');
      for (const [k, label] of SET_TABS) {
        const b = el('button', 'gh-seg-btn' + (set.tab === k ? ' on' : ''), label);
        b.addEventListener('click', () => { if (set.tab !== k) { set.tab = k; set.data = null; loadSettings(); } });
        seg.appendChild(b);
      }
      bar.appendChild(seg);

      if (set.tab !== 'environments') {
        const sc = el('select', 'gh-select');
        const add = (v, l) => { const o = el('option', null, l); o.value = v; sc.appendChild(o); };
        add('repo', 'Repository');
        for (const e of set.envs || []) add('env:' + e.name, 'Environment: ' + e.name);
        if (set.ownerIsOrg) add('org', 'Organization: ' + st.sel.repo.split('/')[0]);
        sc.value = set.scope;
        sc.addEventListener('change', () => { set.scope = sc.value; set.data = null; loadSettings(); });
        bar.appendChild(sc);
      }
      bar.appendChild(el('span', 'gh-set-gap'));
      if (set.tab === 'environments') {
        bar.appendChild(actionBtn('plus', 'New environment', () => editEnv(null)));
      } else {
        const noun = set.tab === 'secrets' ? 'secret' : 'variable';
        bar.appendChild(actionBtn('upload', 'Import .env', () => importEnvFile()));
        bar.appendChild(actionBtn('plus', 'New ' + noun, () => editEntry(null)));
      }
      wrap.appendChild(bar);

      const note = el('div', 'gh-set-note');
      if (set.tab === 'secrets') {
        note.appendChild(icon('lock'));
        note.appendChild(el('span', null, `Secrets for ${scopeLabel()}. Values are write-only — GitHub never returns them, so you can replace a secret but not read it.`));
      } else if (set.tab === 'variables') {
        note.appendChild(el('span', null, `Variables for ${scopeLabel()} — plain configuration, visible to anyone who can read the workflows.`));
      } else {
        note.appendChild(el('span', null, 'Deployment environments: protection rules, and their own secrets and variables (pick the environment as scope on the other tabs).'));
      }
      wrap.appendChild(note);

      if (loading && !set.data) wrap.appendChild(el('div', 'gh-placeholder', 'Loading…'));
      else if (set.error) {
        const e = el('div', 'gh-placeholder err');
        e.appendChild(el('div', null, set.error));
        if (/403|admin|permission|resource not accessible/i.test(set.error)) e.appendChild(el('div', 'gh-field-hint', 'Managing these needs admin (or maintain) access to the repository.'));
        wrap.appendChild(e);
      } else if (set.data && !set.data.length) {
        wrap.appendChild(el('div', 'gh-placeholder', set.tab === 'environments' ? 'No environments.' : `No ${set.tab} in this scope.`));
      } else if (set.data) {
        wrap.appendChild(set.tab === 'environments' ? envTable(set.data) : entryTable(set.data));
      }
      listEl.appendChild(wrap);
    }

    function entryTable(rows) {
      const isSecret = set.tab === 'secrets';
      const t = el('div', 'gh-table');
      for (const r of rows) {
        const row = el('div', 'gh-trow');
        const name = el('div', 'gh-tname');
        name.appendChild(el('span', 'gh-mono', r.name));
        if (r.visibility) name.appendChild(el('span', 'gh-badge', r.visibility));
        row.appendChild(name);
        if (isSecret) row.appendChild(el('div', 'gh-tval masked', '••••••••'));
        else { const v = el('div', 'gh-tval gh-mono', r.value); v.title = r.value; row.appendChild(v); }
        row.appendChild(el('div', 'gh-ttime', r.updatedAt ? 'updated ' + ago(r.updatedAt) : ''));
        const acts = el('div', 'gh-tacts');
        const ed = el('button', 'gh-icon-btn'); ed.title = isSecret ? 'Replace value' : 'Edit'; ed.appendChild(icon('edit'));
        ed.addEventListener('click', () => editEntry(r));
        const del = el('button', 'gh-icon-btn danger'); del.title = 'Delete'; del.appendChild(icon('trash'));
        del.addEventListener('click', () => confirmModal(`Delete ${isSecret ? 'secret' : 'variable'}`,
          `Delete ${r.name} from ${scopeLabel()}? Workflows that use it will break. This can't be undone.`, 'Delete',
          async () => {
            const res = isSecret ? await window.ghApi.secretDelete({ scope: scopeObj(), name: r.name })
              : await window.ghApi.varDelete({ scope: scopeObj(), name: r.name });
            if (res && res.ok) loadSettings();
            return res;
          }));
        acts.append(ed, del);
        row.appendChild(acts);
        t.appendChild(row);
      }
      return t;
    }

    function editEntry(existing) {
      const isSecret = set.tab === 'secrets';
      const noun = isSecret ? 'secret' : 'variable';
      const nameIn = textInput(existing ? existing.name : '', 'MY_' + noun.toUpperCase());
      if (existing) nameIn.readOnly = true;
      nameIn.addEventListener('input', () => { const p = nameIn.selectionStart; nameIn.value = nameIn.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); nameIn.setSelectionRange(p, p); });
      const val = el('textarea', 'gh-input gh-textarea' + (isSecret ? ' masked' : ''));
      val.rows = 4; val.spellcheck = false;
      if (!isSecret && existing) val.value = existing.value || '';
      const body = el('div');
      body.appendChild(field('Name', nameIn));
      body.appendChild(field('Value', val, isSecret ? (existing ? 'The current value can\'t be shown — whatever you enter replaces it.' : '') : ''));
      if (isSecret) {
        const show = el('label', 'gh-check');
        const cb = el('input'); cb.type = 'checkbox';
        cb.addEventListener('change', () => val.classList.toggle('masked', !cb.checked));
        show.append(cb, el('span', null, 'Show value'));
        body.appendChild(show);
      }
      let vis = null;
      if (set.scope === 'org') {
        vis = el('select', 'gh-select');
        for (const [v, l] of [['private', 'Private repositories'], ['all', 'All repositories']]) { const o = el('option', null, l); o.value = v; vis.appendChild(o); }
        vis.value = (existing && existing.visibility) === 'all' ? 'all' : 'private';
        body.appendChild(field('Repository access', vis));
      }
      body.appendChild(el('div', 'gh-field-hint', 'Saving to ' + scopeLabel() + '.'));
      showModal({ title: (existing ? (isSecret ? 'Replace ' : 'Edit ') : 'New ') + noun, body, actions: [{
        label: existing ? 'Save' : 'Add ' + noun, kind: 'primary', onClick: async (close, setError, setBusy) => {
          const name = nameIn.value.trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^GITHUB_/i.test(name)) { setError('Name: letters, digits and _ only; not starting with a digit or GITHUB_'); return; }
          if (isSecret && !val.value) { setError('Enter a value'); return; }
          if (!existing && (set.data || []).some((r) => r.name === name)) { setError(name + ' already exists here — edit it instead'); return; }
          setBusy(true, 'Saving…');
          const args = { scope: scopeObj(), name, value: val.value, visibility: vis ? vis.value : undefined };
          const r = isSecret ? await window.ghApi.secretSet(args) : await window.ghApi.varSet(args);
          if (!r || !r.ok) { setBusy(false, ''); setError((r && r.error) || 'Failed'); return; }
          close();
          loadSettings();
        }
      }] });
    }

    // KEY=VALUE lines, `export` prefix, # comments, single/double quotes (double quotes
    // understand \n). Returns [{ name, value, error? }].
    function parseDotEnv(text) {
      const out = [];
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        line = line.replace(/^export\s+/, '');
        const eq = line.indexOf('=');
        if (eq <= 0) { out.push({ name: line.slice(0, 40), value: '', error: 'no "="' }); continue; }
        const name = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.startsWith('"')) {
          // A double-quoted value may span lines until the closing quote.
          let v = value.slice(1);
          while (!/(^|[^\\])"\s*(#.*)?$/.test(v) && i + 1 < lines.length) v += '\n' + lines[++i];
          v = v.replace(/"\s*(#.*)?$/, '');
          value = v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        } else if (value.startsWith("'")) {
          value = value.replace(/^'|'\s*(#.*)?$/g, '');
        } else {
          value = value.replace(/\s+#.*$/, '');
        }
        const bad = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? 'invalid name' : /^GITHUB_/i.test(name) ? 'GITHUB_ is reserved' : '';
        out.push({ name, value, error: bad || (!value && set.tab === 'secrets' ? 'empty value' : '') });
      }
      return out;
    }

    function importEnvFile() {
      const isSecret = set.tab === 'secrets';
      const noun = isSecret ? 'secrets' : 'variables';
      const body = el('div');
      const area = el('textarea', 'gh-input gh-textarea masked');
      area.rows = 8; area.spellcheck = false;
      area.placeholder = 'API_KEY=...\nDATABASE_URL="..."';
      const file = el('input'); file.type = 'file'; file.style.display = 'none';
      const pick = el('button', 'gh-btn', 'Load file…');
      pick.addEventListener('click', () => file.click());
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (!f) return;
        f.text().then((t) => { area.value = t; renderPreview(); });
        file.value = '';
      });
      const show = el('label', 'gh-check');
      const cb = el('input'); cb.type = 'checkbox';
      cb.addEventListener('change', () => area.classList.toggle('masked', !cb.checked));
      show.append(cb, el('span', null, 'Show text'));
      const tools = el('div', 'gh-row-tools'); tools.append(pick, show, file);
      body.appendChild(el('div', 'gh-modal-text', `Paste a .env file (or load one). Each KEY=VALUE becomes one of the ${noun} in ${scopeLabel()}.`));
      body.appendChild(area);
      body.appendChild(tools);
      const preview = el('div', 'gh-import-list');
      body.appendChild(preview);
      let parsed = [];
      const existing = new Set((set.data || []).map((r) => r.name));
      function renderPreview() {
        parsed = parseDotEnv(area.value);
        preview.innerHTML = '';
        for (const p of parsed) {
          const row = el('label', 'gh-import-row' + (p.error ? ' bad' : ''));
          const c = el('input'); c.type = 'checkbox'; c.checked = !p.error; c.disabled = !!p.error;
          p.checkbox = c;
          row.appendChild(c);
          row.appendChild(el('span', 'gh-mono', p.name));
          row.appendChild(el('span', 'gh-import-val', p.error ? p.error
            : isSecret ? `•••• ${p.value.length} char${p.value.length === 1 ? '' : 's'}` : p.value));
          if (!p.error && existing.has(p.name)) row.appendChild(el('span', 'gh-badge', 'overwrite'));
          row.appendChild(p.status = el('span', 'gh-import-status'));
          preview.appendChild(row);
        }
      }
      let t = null;
      area.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderPreview, 250); });
      showModal({ title: 'Import ' + noun + ' from .env', wide: true, body, actions: [{
        label: 'Import', kind: 'primary', onClick: async (close, setError, setBusy) => {
          renderPreview();
          const todo = parsed.filter((p) => !p.error && p.checkbox.checked);
          if (!todo.length) { setError('Nothing selected'); return; }
          setBusy(true, `Importing 0 / ${todo.length}…`);
          let failed = 0;
          for (let i = 0; i < todo.length; i++) {
            const p = todo[i];
            const args = { scope: scopeObj(), name: p.name, value: p.value };
            const r = isSecret ? await window.ghApi.secretSet(args) : await window.ghApi.varSet(args);
            p.status.textContent = r && r.ok ? '✓' : '✗ ' + ((r && r.error) || 'failed');
            p.status.className = 'gh-import-status ' + (r && r.ok ? 'ok' : 'fail');
            if (!r || !r.ok) failed++;
            setBusy(true, `Importing ${i + 1} / ${todo.length}…`);
          }
          loadSettings();
          if (failed) { setBusy(false, ''); setError(`${failed} of ${todo.length} failed — see the list.`); }
          else close();
        }
      }] });
    }

    function envTable(envs) {
      const t = el('div', 'gh-table');
      for (const e of envs) {
        const row = el('div', 'gh-trow env');
        const name = el('div', 'gh-tname');
        name.appendChild(icon('env'));
        name.appendChild(el('span', null, e.name));
        row.appendChild(name);
        const rules = el('div', 'gh-tval gh-env-rules');
        const chips = [];
        if (e.reviewers.length) chips.push('Reviewers: ' + e.reviewers.map((r) => r.name).join(', '));
        if (e.preventSelfReview) chips.push('No self-review');
        if (e.waitTimer) chips.push('Wait ' + e.waitTimer + ' min');
        chips.push(e.branchPolicy === 'all' ? 'All branches' : e.branchPolicy === 'protected' ? 'Protected branches' : 'Custom branch rules');
        for (const c of chips) rules.appendChild(el('span', 'gh-badge', c));
        row.appendChild(rules);
        row.appendChild(el('div', 'gh-ttime', e.updatedAt ? 'updated ' + ago(e.updatedAt) : ''));
        const acts = el('div', 'gh-tacts');
        const sec = el('button', 'gh-icon-btn'); sec.title = 'Secrets & variables for this environment'; sec.appendChild(icon('lock'));
        sec.addEventListener('click', () => { set.tab = 'secrets'; set.scope = 'env:' + e.name; set.data = null; loadSettings(); });
        const ed = el('button', 'gh-icon-btn'); ed.title = 'Edit protection rules'; ed.appendChild(icon('edit'));
        ed.addEventListener('click', () => editEnv(e));
        const del = el('button', 'gh-icon-btn danger'); del.title = 'Delete environment'; del.appendChild(icon('trash'));
        del.addEventListener('click', () => confirmModal('Delete environment',
          `Delete environment "${e.name}" from ${st.sel.repo}? Its secrets, variables and protection rules are deleted with it. This can't be undone.`,
          'Delete environment', async () => {
            const r = await window.ghApi.envDelete({ repo: st.sel.repo, name: e.name });
            if (r && r.ok) { set.envs = null; loadSettings(); }
            return r;
          }));
        acts.append(sec, ed, del);
        row.appendChild(acts);
        t.appendChild(row);
      }
      return t;
    }

    function editEnv(e) {
      const nameIn = textInput(e ? e.name : '', 'production');
      if (e) nameIn.readOnly = true;
      const reviewers = textInput(e ? e.reviewers.map((r) => r.type === 'Team' ? st.sel.repo.split('/')[0] + '/' + r.name : r.name).join(', ') : '', 'login, org/team-slug');
      const wait = textInput(e ? String(e.waitTimer || 0) : '0', '0');
      wait.type = 'number'; wait.min = '0'; wait.max = '43200';
      const self = el('label', 'gh-check');
      const selfCb = el('input'); selfCb.type = 'checkbox'; selfCb.checked = !!(e && e.preventSelfReview);
      self.append(selfCb, el('span', null, 'Prevent self-review (the person who triggered a deployment can\'t approve it)'));
      const pol = el('select', 'gh-select');
      const opts2 = [['all', 'All branches'], ['protected', 'Protected branches only']];
      if (e && e.branchPolicy === 'custom') opts2.push(['custom', 'Custom branch rules (edit patterns on github.com)']);
      for (const [v, l] of opts2) { const o = el('option', null, l); o.value = v; pol.appendChild(o); }
      pol.value = e ? e.branchPolicy : 'all';
      const body = el('div');
      body.appendChild(field('Name', nameIn));
      body.appendChild(field('Required reviewers', reviewers, 'Up to 6, comma-separated. Leave empty for none.'));
      body.appendChild(self);
      body.appendChild(field('Wait timer (minutes)', wait));
      body.appendChild(field('Deployment branches', pol));
      showModal({ title: e ? 'Environment: ' + e.name : 'New environment', body, actions: [{
        label: e ? 'Save' : 'Create environment', kind: 'primary', onClick: async (close, setError, setBusy) => {
          const name = nameIn.value.trim();
          if (!name || !/^[A-Za-z0-9 ._()-]+$/.test(name) || name.startsWith('-')) { setError('Name: letters, digits, space and . _ - ( ) only'); return; }
          const list = reviewers.value.split(',').map((s) => s.trim()).filter(Boolean);
          if (list.length > 6) { setError('At most 6 reviewers'); return; }
          setBusy(true, 'Saving…');
          const r = await window.ghApi.envSave({ repo: st.sel.repo, name, reviewers: list,
            waitTimer: Number(wait.value) || 0, preventSelfReview: selfCb.checked, branchPolicy: pol.value });
          if (!r || !r.ok) { setBusy(false, ''); setError((r && r.error) || 'Failed'); return; }
          close();
          set.envs = null;
          loadSettings();
        }
      }] });
    }

    // ---- keyboard ----
    root.addEventListener('keydown', (e) => {
      // Esc peels the open detail first, from a field too, so it doesn't fall through to
      // the overlay. A field that handles Esc itself (the search box) has marked it.
      if (e.key === 'Escape') {
        if (!e.defaultPrevented && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && st.detail) { e.preventDefault(); closeDetail(); }
        return;
      }
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.ctrlKey || e.altKey || e.metaKey) { if (!(e.key === 'Enter' && e.ctrlKey)) return; }
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveCursor(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveCursor(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); activateCursor(e); }
      else if (e.key === '/') { e.preventDefault(); if (searchEl.style.display !== 'none') searchEl.focus(); }
      else if (e.key === 'r') { e.preventDefault(); refresh(true); }
    });

    // ---- selection / refresh ----
    function select(sel, keepDetail) {
      st.sel = sel;
      st.cursor = -1;
      st.items = [];
      st.loadedAt = 0;
      if (sel.kind === 'repo') st.search = '';
      if (!keepDetail && st.detail) closeDetail();
      renderSide();
      renderToolbar();
      loadList();
      notify();
    }

    async function loadInboxCounts() {
      st.inboxAt = Date.now();
      await Promise.all(INBOXES.map(async (ib) => {
        const r = await window.ghApi.inbox({ kind: ib.key });
        if (st.disposed) return;
        if (r && r.ok) st.inboxCounts[ib.key] = (r.data || []).length;
      }));
      if (!st.disposed) renderSide();
    }

    async function checkAuth() {
      const r = await window.ghApi.status();
      if (st.disposed) return;
      if (r && r.ok) { st.user = r.login; st.authError = null; }
      else { st.user = null; st.authError = (r && r.error) || 'gh is not signed in'; }
      renderSide();
      return !!(r && r.ok);
    }

    async function refresh(manual) {
      if (manual && st.authError) { const ok = await checkAuth(); if (!ok) return; }
      loadList(!manual);
      if (st.detail) openDetail(st.detail.repo, st.detail.number);
      if (manual || Date.now() - st.inboxAt > INBOX_POLL_MS) loadInboxCounts();
    }

    function schedulePoll() {
      clearInterval(pollTimer);
      pollTimer = null;
      const ms = pollMs();
      if (!st.active || st.disposed || !(ms > 0)) return;
      pollTimer = setInterval(() => {
        if (document.hidden) return;
        refresh(false);
      }, ms);
    }
    // Settings changes apply live: a new poll interval restarts the timer.
    const offSettings = window.onAppSettingsChanged ? window.onAppSettingsChanged((next, prev) => {
      const a = (prev && prev.github) || {}, b = (next && next.github) || {};
      if (a.pollSeconds !== b.pollSeconds) schedulePoll();
      if (a.links !== b.links) syncLinksCb();
    }) : null;
    // Keep the "Updated Xm ago" label honest between polls.
    const ageTimer = setInterval(() => { if (st.active && !st.loading) updateAgeStatus(); }, 15000);

    function notify() { if (opts.onStateChange) opts.onStateChange(); }

    // ---- public ----
    let booted = false;
    async function boot() {
      if (booted) return;
      booted = true;
      renderSide();
      const ok = await checkAuth();
      if (ok) loadInboxCounts();
    }

    return {
      el: root,
      // target: { repo?, view?, filter?, number?, inbox? }
      open(target = {}) {
        boot();
        const prevView = st.view;
        if (target.view && VIEWS.some((v) => v.key === target.view)) st.view = target.view;
        if (target.filter && st.view !== 'actions') st.filter[st.view] = target.filter;
        if (target.inbox) select({ kind: 'inbox', key: target.inbox }, !!target.number);
        else if (target.repo) {
          const changed = !st.sel || st.sel.kind !== 'repo' || st.sel.repo.toLowerCase() !== target.repo.toLowerCase();
          if (changed || st.view !== prevView || (target.view && !target.number)) {
            select({ kind: 'repo', repo: target.repo }, !!target.number);
          }
        } else if (!st.sel || (st.here && st.here.repo && st.here.repo !== st.openedHere)) {
          // A plain open follows the folder you came from, once per repo change, so
          // browsing elsewhere isn't yanked back on every Ctrl+Shift+G.
          select(st.here && st.here.repo ? { kind: 'repo', repo: st.here.repo } : { kind: 'inbox', key: 'prsReview' });
        }
        st.openedHere = st.here && st.here.repo;
        if (target.number && target.repo) openDetail(target.repo, Number(target.number));
      },
      setHere(here) {
        const prev = st.here && st.here.repo;
        st.here = here && here.repo ? here : null;
        if ((st.here && st.here.repo) !== prev) renderSide();
      },
      setActive(on) {
        const was = st.active;
        st.active = !!on;
        if (!on) cancelUnknownRetry();
        if (on && !was) fillTabsPicker();
        schedulePoll();
        if (on && !was && booted && st.sel && Date.now() - st.loadedAt > 30000) refresh(false);
      },
      focus() { root.focus(); },
      getState() {
        return {
          repo: st.sel && st.sel.kind === 'repo' ? st.sel.repo : null,
          inbox: st.sel && st.sel.kind === 'inbox' ? st.sel.key : null,
          view: st.view,
          number: st.detail ? st.detail.number : null,
          detailRepo: st.detail ? st.detail.repo : null
        };
      },
      title() {
        if (!st.sel) return 'GitHub';
        if (st.sel.kind === 'inbox') return 'GitHub';
        return st.sel.repo.split('/')[1];
      },
      dispose() {
        st.disposed = true;
        if (offSettings) offSettings();
        clearInterval(pollTimer);
        clearInterval(ageTimer);
        clearTimeout(searchTimer);
        cancelUnknownRetry();
      }
    };
  }

  window.createGitHubView = createGitHubView;
  window.githubLinksInApp = linksInApp;
})();
