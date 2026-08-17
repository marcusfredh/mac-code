// Claude chat surface.
//
// Drives one `claude -p --input-format stream-json --output-format stream-json`
// process per pane (spawned in the main process) and renders its event stream as
// message bubbles, tool cards, inline diffs and permission prompts.
//
// Two streams describe the same turn: `stream_event` carries token deltas so text
// appears as it is generated, and the buffered `assistant` event carries the
// finished blocks plus usage. Text is rendered from the deltas and reconciled
// against the buffered copy by (message id, block index); tool calls only come
// from the buffered copy, because the delta stream has no complete tool input.

(() => {
  'use strict';

  // CLI aliases rather than pinned ids — `claude --model opus` always resolves to
  // the current Opus, so this list doesn't rot when a new model ships.
  const MODELS = [
    { id: 'opus',   label: 'Opus 5',    dot: '#4ec994' },
    { id: 'sonnet', label: 'Sonnet 5',  dot: '#61d6d6' },
    { id: 'haiku',  label: 'Haiku 4.5', dot: '#d7ba7d' },
    { id: 'fable',  label: 'Fable 5',   dot: '#b393ff' }
  ];

  // Named after the CLI's permission modes, but the decisions are Mac Code's own —
  // the CLI's `auto` classifier does not grant approvals in print mode, so `auto`
  // here means Mac Code's local safe-command list, not that classifier.
  const PERM_MODES = [
    { id: 'default',           label: 'Ask',          pill: 'Ask',          dot: '#d7ba7d', hint: '' },
    { id: 'auto',              label: 'Auto (local rules)', pill: 'Auto',   dot: '#4ec994', hint: 'safe commands + edits' },
    { id: 'acceptEdits',       label: 'Accept edits', pill: 'Accept edits', dot: '#61d6d6', hint: 'edits only' },
    { id: 'bypassPermissions', label: 'Bypass',       pill: 'Bypass',       dot: '#e74856', hint: 'no prompts' }
  ];

  const TOOL_COLOR = {
    Read: '', Glob: '', Grep: '', NotebookRead: '', WebFetch: '', WebSearch: '',
    Write: 'write', NotebookEdit: 'write',
    Edit: 'edit', MultiEdit: 'edit',
    Bash: 'bash', PowerShell: 'bash', Task: 'bash'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function baseName(p) {
    if (!p) return '';
    const s = String(p).replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) || s : s;
  }

  // Just enough markdown for agent replies: fenced blocks, inline code, bold.
  // Everything is escaped first, so no markup can come out of model output.
  function renderMarkdown(target, text) {
    target.innerHTML = '';
    const parts = String(text).split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const body = nl >= 0 ? part.slice(nl + 1) : part;
        const pre = el('pre');
        pre.appendChild(el('code', null, body.replace(/\n$/, '')));
        target.appendChild(pre);
      } else if (part) {
        const span = document.createElement('span');
        span.innerHTML = esc(part)
          .replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`)
          .replace(/\*\*([^*\n]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
        target.appendChild(span);
      }
    });
  }

  function lineCount(s) {
    if (!s) return 0;
    const n = String(s).split('\n').length;
    return String(s).endsWith('\n') ? n - 1 : n;
  }

  function lines(n) { return n + (n === 1 ? ' line' : ' lines'); }

  // Common-prefix / common-suffix diff. Enough for an Edit's single replaced span,
  // which is what the CLI's Edit tool always produces.
  function lineDiff(oldStr, newStr) {
    const a = String(oldStr == null ? '' : oldStr).split('\n');
    const b = String(newStr == null ? '' : newStr).split('\n');
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head &&
           a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return {
      head: a.slice(0, head),
      removed: a.slice(head, a.length - tail),
      added: b.slice(head, b.length - tail),
      tail: a.slice(a.length - tail)
    };
  }

  function createChatView(opts) {
    const helpers = opts.helpers || {};
    const fmtTokens = helpers.formatTokens || ((n) => String(n));
    const ctxWindowFor = helpers.contextWindowFor || (() => 200000);
    const modelLabel = helpers.shortModelLabel || ((m) => m || '');

    // ---------- state ----------
    const state = {
      chatId: opts.chatId,
      cwd: opts.cwd,
      name: opts.name || baseName(opts.cwd) || 'claude',
      sessionId: null,
      model: opts.model || 'opus',
      apiModel: null,
      permissionMode: opts.permissionMode || 'default',
      sessionMcp: null,
      working: false,
      exited: false,
      interrupting: false,
      contextTokens: null,
      contextWindow: 200000,
      cost: 0,
      slashCommands: []
    };

    // message id -> [{ type, node, reconciled }] in stream order. The buffered
    // `assistant` events are incremental snapshots, so their content array index is
    // NOT the stream's block index — matching must go by type in order, not index.
    const streamNodes = new Map();
    // message id -> { block index -> element }, for routing deltas
    const blockEls = new Map();
    let currentMessageId = null;
    // tool_use_id -> { row, card, body, timeEl, startedAt, name, input }
    const toolCards = new Map();
    // permId -> card element, so a resolved card can be greyed out
    const permCards = new Map();

    // ---------- DOM ----------
    const root = el('div', 'chat-root');

    const card = el('div', 'chat-card');
    const hdr = el('div', 'chat-hdr');
    hdr.appendChild(el('span', 'chat-hdr-badge', 'CLAUDE'));
    const nameEl = el('span', 'chat-hdr-name', state.name);
    const cwdEl = el('span', 'chat-hdr-cwd', prettyCwd(state.cwd));
    cwdEl.title = state.cwd;
    hdr.appendChild(nameEl);
    hdr.appendChild(cwdEl);
    hdr.appendChild(el('div', 'chat-hdr-spacer'));

    const permPill = el('span', 'chat-perm-pill');
    permPill.title = 'Change how tool calls are approved';
    const permDot = el('span', 'dot');
    const permLabel = el('span', null, 'Permissions: Ask');
    permPill.appendChild(permDot);
    permPill.appendChild(permLabel);
    hdr.appendChild(permPill);

    const tokEl = el('span', 'chat-stat', '— tok');
    const costEl = el('span', 'chat-stat', '$0.00');
    const sessEl = el('span', 'chat-stat faint', 'no session');
    sessEl.title = 'session_id';
    hdr.appendChild(tokEl);
    hdr.appendChild(el('span', 'chat-sep', '·'));
    hdr.appendChild(costEl);
    hdr.appendChild(el('span', 'chat-sep', '·'));
    hdr.appendChild(sessEl);
    card.appendChild(hdr);

    const stream = el('div', 'chat-stream scroll');
    const emptyHint = el('div', 'chat-empty', 'Ask Claude anything about ' + state.name + '.');
    stream.appendChild(emptyHint);
    card.appendChild(stream);

    // MCP panel lives inside the card so it covers the transcript, not the composer.
    const mcp = buildMcpPanel();
    card.appendChild(mcp.el);
    root.appendChild(card);

    // ---------- terminal drawer ----------
    // A real shell in the same folder as the pane, for the things a chat can't do:
    // interactive prompts, `claude mcp login`, watching a build.
    const DRAWER_KEY = 'chatTerminalHeight';
    const drawer = el('div', 'chat-term');
    const grip = el('div', 'chat-term-grip');
    drawer.appendChild(grip);
    const drawerHdr = el('div', 'chat-term-hdr');
    const termIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    termIcon.setAttribute('viewBox', '0 0 16 16');
    termIcon.setAttribute('fill', 'none');
    termIcon.innerHTML = '<rect x="1" y="2" width="14" height="12" rx="2.5" stroke="currentColor" stroke-width="1"/>' +
      '<path d="M3.8 6l2.4 2-2.4 2M8 10h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>';
    drawerHdr.appendChild(termIcon);
    drawerHdr.appendChild(el('span', 'chat-term-title', 'Terminal'));
    const drawerCwd = el('span', 'chat-term-cwd', '');
    drawerHdr.appendChild(drawerCwd);
    const drawerRestart = el('span', 'chat-term-btn', '↻');
    drawerRestart.title = 'Restart the shell';
    const drawerClose = el('span', 'chat-term-btn', '✕');
    drawerClose.title = 'Hide terminal — Ctrl+`';
    drawerHdr.appendChild(drawerRestart);
    drawerHdr.appendChild(drawerClose);
    drawer.appendChild(drawerHdr);
    const drawerBody = el('div', 'chat-term-body');
    drawer.appendChild(drawerBody);
    root.appendChild(drawer);

    const storedHeight = parseInt(localStorage.getItem(DRAWER_KEY) || '', 10);
    if (Number.isFinite(storedHeight) && storedHeight >= 80) drawer.style.height = storedHeight + 'px';

    let drawerOpen = false;
    let drawerStarted = false;

    function setDrawer(open, opts2 = {}) {
      if (open === drawerOpen && !opts2.force) return;
      drawerOpen = open;
      drawer.classList.toggle('open', open);
      if (open) {
        drawerCwd.textContent = prettyCwd(state.cwd);
        if (!drawerStarted) {
          drawerStarted = true;
          if (optsFn('onTerminalOpen')) opts.onTerminalOpen(drawerBody);
        } else if (optsFn('onTerminalFit')) {
          opts.onTerminalFit(true);
        }
      } else if (optsFn('onTerminalFit')) {
        opts.onTerminalFit(false);
      }
      termBtn.classList.toggle('active', open);
    }
    function optsFn(name) { return typeof opts[name] === 'function'; }

    drawerClose.addEventListener('click', () => { setDrawer(false); input.focus(); });
    drawerRestart.addEventListener('click', () => {
      if (optsFn('onTerminalRestart')) opts.onTerminalRestart(drawerBody);
    });

    // Drag the top edge to resize; the height is shared by every chat pane.
    let dragFrom = null;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      dragFrom = { y: e.clientY, h: drawer.getBoundingClientRect().height };
      grip.classList.add('dragging');
      document.body.classList.add('resizing-drawer');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragFrom) return;
      const max = Math.max(120, root.getBoundingClientRect().height - 200);
      const h = Math.min(max, Math.max(80, dragFrom.h - (e.clientY - dragFrom.y)));
      drawer.style.height = h + 'px';
    });
    const endDrag = (e) => {
      if (!dragFrom) return;
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      dragFrom = null;
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing-drawer');
      const h = Math.round(drawer.getBoundingClientRect().height);
      if (h >= 80) localStorage.setItem(DRAWER_KEY, String(h));
      if (optsFn('onTerminalFit')) opts.onTerminalFit(true);
    };
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);

    // ---------- composer ----------
    const composerWrap = el('div', 'composer-wrap');
    const palette = el('div', 'palette');
    composerWrap.appendChild(palette);

    const composer = el('div', 'composer');
    const attachRow = el('div', 'attach-row');
    composer.appendChild(attachRow);

    const input = document.createElement('textarea');
    input.className = 'composer-input';
    input.rows = 2;
    input.placeholder = 'Ask Claude — / for commands, Ctrl+V to paste a screenshot';
    input.spellcheck = false;
    composer.appendChild(input);

    const foot = el('div', 'composer-foot');

    const modelBtn = el('button', 'cf-btn');
    modelBtn.type = 'button';
    const modelDot = el('span', 'dot');
    const modelText = el('span', null, '');
    modelBtn.appendChild(modelDot);
    modelBtn.appendChild(modelText);
    modelBtn.appendChild(el('span', 'caret', '▼'));
    modelBtn.title = 'Model — switching restarts the CLI and resumes this session';
    foot.appendChild(modelBtn);

    const ctxMeter = el('div', 'ctx-meter');
    const ctxBar = el('div', 'ctx-bar');
    const ctxFill = document.createElement('i');
    ctxBar.appendChild(ctxFill);
    const ctxLabel = el('span', 'ctx-label', '— ctx');
    ctxMeter.appendChild(ctxBar);
    ctxMeter.appendChild(ctxLabel);
    foot.appendChild(ctxMeter);

    foot.appendChild(el('div', 'cf-divider'));

    const imageBtn = el('button', 'cf-btn');
    imageBtn.type = 'button';
    imageBtn.appendChild(el('span', null, '🖼'));
    imageBtn.appendChild(el('span', null, 'Image'));
    imageBtn.title = 'Attach an image (or just paste one)';
    foot.appendChild(imageBtn);

    const cmdBtn = el('button', 'cf-btn');
    cmdBtn.type = 'button';
    const slashGlyph = el('span', null, '/');
    slashGlyph.style.fontFamily = 'var(--mono)';
    cmdBtn.appendChild(slashGlyph);
    cmdBtn.appendChild(el('span', null, 'Commands'));
    foot.appendChild(cmdBtn);

    const termBtn = el('button', 'cf-btn');
    termBtn.type = 'button';
    const termGlyph = el('span', null, '▤');
    termGlyph.style.fontFamily = 'var(--mono)';
    termBtn.appendChild(termGlyph);
    termBtn.appendChild(el('span', null, 'Terminal'));
    termBtn.title = 'Shell in this folder — Ctrl+`';
    foot.appendChild(termBtn);

    const undoBtn = el('button', 'cf-btn icon', '↶');
    undoBtn.type = 'button';
    undoBtn.title = 'Undo last input — Ctrl+Z';
    foot.appendChild(undoBtn);

    foot.appendChild(el('div', 'cf-divider'));
    const spacer = el('div');
    spacer.style.flex = '1';
    foot.appendChild(spacer);

    const hint = el('span', 'composer-hint', 'Shift+Enter for a new line');
    foot.appendChild(hint);

    const sendBtn = el('button', 'send-btn');
    sendBtn.type = 'button';
    const sendLabel = el('span', null, 'Send');
    const sendKbd = el('span', 'kbd', '↵');
    sendBtn.appendChild(sendLabel);
    sendBtn.appendChild(sendKbd);
    foot.appendChild(sendBtn);

    composer.appendChild(foot);
    composerWrap.appendChild(composer);
    root.appendChild(composerWrap);

    const filePicker = document.createElement('input');
    filePicker.type = 'file';
    filePicker.accept = 'image/*';
    filePicker.multiple = true;
    filePicker.style.display = 'none';
    root.appendChild(filePicker);

    // ---------- MCP panel ----------
    // A view over `claude mcp list` with the non-interactive actions wired to the
    // CLI. Login is interactive OAuth, so it runs in the terminal drawer instead.
    function buildMcpPanel() {
      const panel = el('div', 'mcp-panel');

      const hdr = el('div', 'mcp-hdr');
      hdr.appendChild(el('span', 'chat-hdr-badge', 'MCP'));
      hdr.appendChild(el('span', 'chat-hdr-name', 'MCP servers'));
      const scopeNote = el('span', 'chat-hdr-cwd', '');
      hdr.appendChild(scopeNote);
      hdr.appendChild(el('div', 'chat-hdr-spacer'));
      const addBtn = el('button', 'btn', 'Add server');
      const refreshBtn = el('button', 'btn', 'Refresh');
      const closeBtn = el('button', 'btn', 'Close');
      hdr.appendChild(addBtn);
      hdr.appendChild(refreshBtn);
      hdr.appendChild(closeBtn);
      panel.appendChild(hdr);

      const body = el('div', 'mcp-body scroll');
      panel.appendChild(body);

      // --- add form ---
      const form = el('div', 'mcp-form');
      function field(label, node) {
        const row = el('div', 'mcp-field');
        const l = document.createElement('label');
        l.textContent = label;
        row.appendChild(l);
        row.appendChild(node);
        return row;
      }
      const fName = document.createElement('input');
      fName.placeholder = 'my-server';
      const fTransport = document.createElement('select');
      for (const [v, t] of [['http', 'HTTP'], ['sse', 'SSE'], ['stdio', 'stdio (command)']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        fTransport.appendChild(o);
      }
      const fTarget = document.createElement('input');
      fTarget.placeholder = 'https://example.com/mcp';
      const fExtra = document.createElement('input');
      fExtra.placeholder = 'Authorization: Bearer … (optional, one header)';
      const fScope = document.createElement('select');
      for (const [v, t] of [['local', 'local (this folder, just me)'], ['project', 'project (.mcp.json, shared)'], ['user', 'user (all my projects)']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        fScope.appendChild(o);
      }
      form.appendChild(field('Name', fName));
      form.appendChild(field('Transport', fTransport));
      form.appendChild(field('URL', fTarget));
      form.appendChild(field('Header', fExtra));
      form.appendChild(field('Scope', fScope));
      const formActions = el('div', 'perm-actions');
      const formAdd = el('button', 'btn primary', 'Add');
      const formCancel = el('button', 'btn', 'Cancel');
      const formMsg = el('span', 'perm-hint', '');
      formActions.appendChild(formAdd);
      formActions.appendChild(formCancel);
      formActions.appendChild(formMsg);
      form.appendChild(formActions);

      fTransport.addEventListener('change', () => {
        const stdio = fTransport.value === 'stdio';
        fTarget.placeholder = stdio ? 'npx -y my-mcp-server' : 'https://example.com/mcp';
        fExtra.placeholder = stdio ? 'KEY=value (optional, one env var)' : 'Authorization: Bearer … (optional, one header)';
        form.querySelectorAll('.mcp-field label')[2].textContent = stdio ? 'Command' : 'URL';
        form.querySelectorAll('.mcp-field label')[3].textContent = stdio ? 'Env' : 'Header';
      });

      let servers = [];
      let elsewhere = [];   // [{ name, config, from, scope }] configured for other folders
      let loading = false;

      function sessionStatusOf(name) {
        const list = state.sessionMcp;
        if (!Array.isArray(list)) return null;
        const hit = list.find((s) => s && s.name === name);
        return hit ? (hit.status || 'unknown') : 'absent';
      }

      function sectionTitle(text) {
        const h = el('div', 'mcp-section', text);
        return h;
      }

      // A row for a server that exists but is scoped to a different folder. Copying
      // goes through `claude mcp add-json`, so the CLI writes its own config.
      function elsewhereRow(entry) {
        const row = el('div', 'mcp-row mcp-row-muted');
        row.appendChild(el('span', 'mcp-dot'));
        const main = el('div', 'mcp-main');
        main.appendChild(el('span', 'mcp-name', entry.name));
        const from = el('span', 'mcp-target', entry.from);
        from.title = entry.from;
        main.appendChild(from);
        row.appendChild(main);
        row.appendChild(el('span', 'mcp-status', entry.scope === 'user' ? 'all projects' : 'other folder'));

        const acts = el('div', 'mcp-acts');
        const mk = (label, scope, title) => {
          const b = el('span', 'mcp-act', label);
          b.title = title;
          b.addEventListener('click', async () => {
            b.textContent = '…';
            const r = await window.mcpApi.addJson({
              name: entry.name, config: entry.config, scope, cwd: state.cwd
            });
            if (r && (r.error || r.ok === false)) {
              b.textContent = 'Failed';
              b.title = (r.error || r.text || '').slice(0, 300);
              return;
            }
            refresh();
          });
          return b;
        };
        acts.appendChild(mk('Copy here', 'local', 'Adds it to this folder only (claude mcp add-json --scope local)'));
        acts.appendChild(mk('Copy to all projects', 'user', 'Adds it at user scope, so every folder gets it'));
        row.appendChild(acts);
        return row;
      }

      function render() {
        body.innerHTML = '';
        body.appendChild(form);

        // A health check takes seconds, so keep the previous rows on screen (dimmed)
        // rather than blanking the panel every refresh.
        if (loading) {
          body.appendChild(el('div', 'mcp-note',
            'Running claude mcp list — health-checking each server…'));
        } else if (!servers.length) {
          body.appendChild(el('div', 'mcp-note',
            'No MCP servers reachable from this folder. Add one above, or copy one across from below.'));
        } else {
          body.appendChild(el('div', 'mcp-note',
            'Servers are attached when the CLI launches, so adding or removing one takes effect ' +
            'after you restart this pane (switch model, or close and reopen the tab).'));
        }
        body.classList.toggle('mcp-stale', loading);
        if (servers.length) body.appendChild(sectionTitle('Reachable from this folder'));

        for (const s of servers) {
          const row = el('div', 'mcp-row');
          row.appendChild(el('span', 'mcp-dot ' + s.state));
          const main = el('div', 'mcp-main');
          main.appendChild(el('span', 'mcp-name', s.name));
          const target = el('span', 'mcp-target', s.target);
          target.title = s.target;
          main.appendChild(target);
          row.appendChild(main);

          const status = el('span', 'mcp-status ' + s.state, s.statusText || s.state);
          status.title = s.statusText || '';
          row.appendChild(status);

          // The health check above and this pane's own session can disagree — a
          // server can be reachable but switched off for the session, or added since
          // the pane started. Say which, rather than leaving it ambiguous.
          const inSession = sessionStatusOf(s.name);
          if (inSession && inSession !== 'connected') {
            const badge = el('span', 'mcp-session ' + inSession,
              inSession === 'absent' ? 'not in this pane'
              : inSession === 'disabled' ? 'disabled here'
              : inSession);
            badge.title = inSession === 'absent'
              ? 'Added since this pane started — restart the pane to attach it'
              : 'Status reported by this pane\'s CLI session';
            row.appendChild(badge);
          }

          const acts = el('div', 'mcp-acts');
          if (s.state === 'needs-auth' || s.state === 'failed') {
            const login = el('span', 'mcp-act', 'Login');
            login.title = 'Runs `claude mcp login` in the terminal drawer, where the OAuth prompt works';
            login.addEventListener('click', () => runInDrawer(`claude mcp login "${s.name}"`));
            acts.appendChild(login);
          }
          if (s.state === 'connected') {
            const logout = el('span', 'mcp-act', 'Logout');
            logout.addEventListener('click', async () => {
              logout.textContent = '…';
              await window.mcpApi.logout({ name: s.name, cwd: state.cwd });
              refresh();
            });
            acts.appendChild(logout);
          }
          const details = el('span', 'mcp-act', 'Details');
          details.addEventListener('click', async () => {
            const existing = row.nextElementSibling;
            if (existing && existing.classList.contains('mcp-detail')) { existing.remove(); return; }
            const box = el('div', 'mcp-detail', 'Loading…');
            row.after(box);
            const r = await window.mcpApi.get({ name: s.name, cwd: state.cwd });
            box.textContent = r && r.text ? r.text.trim() : (r && r.error) || 'No details.';
          });
          acts.appendChild(details);

          const rm = el('span', 'mcp-act danger', 'Remove');
          rm.addEventListener('click', async () => {
            if (rm.dataset.confirm !== '1') {
              rm.dataset.confirm = '1';
              rm.textContent = 'Confirm?';
              setTimeout(() => {
                if (rm.dataset.confirm === '1') { rm.dataset.confirm = ''; rm.textContent = 'Remove'; }
              }, 4000);
              return;
            }
            rm.textContent = '…';
            const r = await window.mcpApi.remove({ name: s.name, cwd: state.cwd });
            if (r && r.error) { rm.textContent = 'Failed'; return; }
            refresh();
          });
          acts.appendChild(rm);
          row.appendChild(acts);
          body.appendChild(row);
        }

        if (elsewhere.length) {
          body.appendChild(sectionTitle('Configured for other folders'));
          body.appendChild(el('div', 'mcp-note',
            '`claude mcp add` defaults to local scope, which is tied to the exact folder it ' +
            'was run in — so these are not available here. Copy one across, or open a chat ' +
            'pane in its folder to use it there.'));
          for (const entry of elsewhere) body.appendChild(elsewhereRow(entry));
        }
      }

      async function refresh() {
        loading = true;
        render();
        const [r, cfg] = await Promise.all([
          window.mcpApi.list({ cwd: state.cwd }),
          window.mcpApi.configured({ cwd: state.cwd })
        ]);
        loading = false;

        // Anything configured for a folder other than this one, minus what the health
        // check already reported (user-scope servers show up in both).
        const here = new Set(((r && r.servers) || []).map((s) => s.name));
        elsewhere = [];
        if (cfg && Array.isArray(cfg.projects)) {
          for (const project of cfg.projects) {
            if (project.isCurrent) continue;
            for (const s of project.servers) {
              if (here.has(s.name)) continue;
              if (elsewhere.some((e) => e.name === s.name)) continue;
              elsewhere.push({ name: s.name, config: s.config, from: project.path, scope: 'local' });
            }
          }
        }

        if (r && r.error) {
          servers = [];
          render();
          body.appendChild(el('div', 'msg-error', 'claude mcp list failed: ' + r.error));
          return;
        }
        servers = (r && r.servers) || [];
        scopeNote.textContent = prettyCwd(state.cwd);
        render();
      }

      addBtn.addEventListener('click', () => {
        form.classList.toggle('open');
        if (form.classList.contains('open')) fName.focus();
      });
      formCancel.addEventListener('click', () => form.classList.remove('open'));
      formAdd.addEventListener('click', async () => {
        const name = fName.value.trim();
        const target = fTarget.value.trim();
        if (!name || !target) { formMsg.textContent = 'Name and URL/command are required.'; return; }
        formAdd.disabled = true;
        formMsg.textContent = 'Adding…';
        const extra = fExtra.value.trim();
        const r = await window.mcpApi.add({
          name, target,
          transport: fTransport.value,
          scope: fScope.value,
          headers: fTransport.value === 'stdio' ? [] : (extra ? [extra] : []),
          env: fTransport.value === 'stdio' ? (extra ? [extra] : []) : [],
          cwd: state.cwd
        });
        formAdd.disabled = false;
        if (r && (r.error || r.ok === false)) {
          formMsg.textContent = (r.error || r.text || 'Failed').split('\n')[0].slice(0, 120);
          return;
        }
        formMsg.textContent = '';
        fName.value = ''; fTarget.value = ''; fExtra.value = '';
        form.classList.remove('open');
        refresh();
      });
      refreshBtn.addEventListener('click', refresh);
      closeBtn.addEventListener('click', () => setMcpOpen(false));

      return { el: panel, refresh, isOpen: () => panel.classList.contains('open'),
               setOpen: (v) => panel.classList.toggle('open', v) };
    }

    function setMcpOpen(open) {
      mcp.setOpen(open);
      if (open) mcp.refresh();
      else input.focus();
    }

    // Interactive CLI flows need a real pty — send them to the drawer.
    function runInDrawer(command) {
      setDrawer(true);
      const send = () => {
        if (typeof opts.onTerminalInput === 'function') opts.onTerminalInput(command + '\r');
      };
      // Give a freshly-created shell a moment to come up before typing into it.
      setTimeout(send, drawerStarted ? 120 : 1200);
    }

    function prettyCwd(p) {
      // Resolved lazily: the home directory arrives over IPC and may not be known
      // yet when the first pane is built at boot.
      const home = String((opts.getHomeDir && opts.getHomeDir()) || '').replace(/[\\/]+$/, '');
      if (home && p && p.toLowerCase().startsWith(home.toLowerCase())) {
        return '~' + p.slice(home.length);
      }
      return p || '';
    }

    // ---------- scroll pinning ----------
    let pinned = true;
    stream.addEventListener('scroll', () => {
      pinned = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40;
    });
    function pin() { if (pinned) stream.scrollTop = stream.scrollHeight; }

    function addBlock(node) {
      if (emptyHint.parentNode) emptyHint.remove();
      stream.appendChild(node);
      pin();
      return node;
    }

    // ---------- header / footer refresh ----------
    function refreshStats() {
      const pct = state.contextTokens != null && state.contextWindow
        ? Math.min(100, Math.round((state.contextTokens / state.contextWindow) * 100))
        : null;

      tokEl.textContent = state.contextTokens != null
        ? fmtTokens(state.contextTokens) + ' tok'
        : '— tok';
      costEl.textContent = '$' + state.cost.toFixed(2);
      sessEl.textContent = state.sessionId
        ? state.sessionId.slice(0, 8) + '…'
        : 'no session';
      sessEl.title = state.sessionId || 'session_id';

      const mode = PERM_MODES.find((m) => m.id === state.permissionMode) || PERM_MODES[0];
      permLabel.textContent = 'Permissions: ' + mode.pill;
      permDot.style.background = mode.dot;
      permPill.title = mode.id === 'auto'
        ? "Auto: Mac Code's own safe-command list, not the CLI's auto-mode classifier"
        : 'Change how tool calls are approved';

      const model = MODELS.find((m) => m.id === state.model);
      modelText.textContent = model ? model.label : modelLabel(state.apiModel) || state.model;
      modelDot.style.background = model ? model.dot : '#4ec994';

      const maxLabel = state.contextWindow >= 1e6
        ? '1M'
        : Math.round(state.contextWindow / 1000) + 'k';
      ctxFill.style.width = (pct == null ? 0 : pct) + '%';
      ctxLabel.textContent = pct == null ? '— ctx' : pct + '% ctx';
      ctxMeter.title = state.contextTokens == null
        ? 'Context use — waiting for the first reply'
        : `${fmtTokens(state.contextTokens)} of ${maxLabel} context`;
      ctxMeter.className = 'ctx-meter' +
        (pct == null ? '' : pct >= 85 ? ' danger' : pct >= 70 ? ' warn' : '');
      ctxFill.className = pct == null ? '' : pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : '';

      sendLabel.textContent = state.working ? 'Stop' : 'Send';
      sendKbd.textContent = state.working ? '⎋' : '↵';
      sendBtn.className = 'send-btn' + (state.working ? ' stop' : '');
      sendBtn.disabled = state.exited;

      if (opts.onStateChange) opts.onStateChange(getState());
    }

    function getState() {
      const picked = MODELS.find((m) => m.id === state.model);
      return {
        chatId: state.chatId,
        cwd: state.cwd,
        name: state.name,
        sessionId: state.sessionId,
        model: state.model,
        modelLabel: picked ? picked.label : state.model,
        apiModel: state.apiModel,
        permissionMode: state.permissionMode,
        working: state.working,
        exited: state.exited,
        contextTokens: state.contextTokens,
        contextWindow: state.contextWindow,
        cost: state.cost
      };
    }

    function setWorking(v) {
      if (state.working === v) return;
      state.working = v;
      refreshStats();
    }

    // ---------- tool rendering ----------
    function toolTarget(name, input) {
      if (!input) return '';
      if (name === 'Bash' || name === 'PowerShell') return input.command || '';
      if (input.file_path) return baseName(input.file_path);
      if (input.path) return baseName(input.path);
      if (input.pattern) return input.pattern;
      if (input.url) return input.url;
      if (input.query) return input.query;
      if (input.description) return input.description;
      return '';
    }

    function renderToolUse(block) {
      const name = block.name || 'tool';
      const input = block.input || {};
      const isCard = name === 'Edit' || name === 'MultiEdit' ||
                     name === 'Bash' || name === 'PowerShell' || name === 'Write';

      const entry = { name, input, startedAt: Date.now() };

      if (isCard) {
        const cardEl = el('div', 'tool-card');
        const cardHdr = el('div', 'tool-hdr');
        cardHdr.appendChild(el('span', 'tool-caret', '▶'));
        cardHdr.appendChild(el('span', 'tool-name ' + (TOOL_COLOR[name] || ''), name));
        const target = el('span', 'tool-target', toolTarget(name, input));
        target.title = input.file_path || input.command || '';
        cardHdr.appendChild(target);
        const metaSlot = el('span', 'tool-meta');
        const timeEl = el('span', 'tool-time pending', '…');
        cardHdr.appendChild(metaSlot);
        cardHdr.appendChild(timeEl);
        cardEl.appendChild(cardHdr);

        const body = el('div', 'tool-body');
        cardEl.appendChild(body);
        cardHdr.addEventListener('click', () => cardEl.classList.toggle('open'));

        entry.el = cardEl;
        entry.body = body;
        entry.metaEl = metaSlot;
        entry.timeEl = timeEl;
        addBlock(cardEl);

        if (name === 'Edit' || name === 'MultiEdit') {
          renderEditDiff(entry);
          cardEl.classList.add('open');
        } else if (name === 'Write') {
          body.classList.add('plain');
          body.textContent = String(input.content || '');
          metaSlot.textContent = lines(lineCount(input.content));
        } else {
          body.classList.add('plain');
          body.textContent = '(waiting for output)';
        }
      } else {
        const row = el('div', 'tool-row');
        row.appendChild(el('span', 'tool-caret', '▶'));
        row.appendChild(el('span', 'tool-name ' + (TOOL_COLOR[name] || ''), name));
        const target = el('span', 'tool-target', toolTarget(name, input));
        target.title = input.file_path || '';
        row.appendChild(target);
        const metaSlot = el('span', 'tool-meta');
        const timeEl = el('span', 'tool-time pending', '…');
        row.appendChild(metaSlot);
        row.appendChild(timeEl);

        const body = el('div', 'tool-body plain');
        const wrap = el('div', 'tool-group');
        wrap.appendChild(row);
        const detail = el('div', 'tool-card');
        detail.appendChild(body);
        wrap.appendChild(detail);
        row.addEventListener('click', () => {
          const open = detail.classList.toggle('open');
          row.classList.toggle('open', open);
        });

        entry.el = wrap;
        entry.body = body;
        entry.metaEl = metaSlot;
        entry.timeEl = timeEl;
        addBlock(wrap);
      }

      if (block.id) toolCards.set(block.id, entry);
      return entry;
    }

    function diffRow(cls, num, sign, text) {
      const row = el('div', 'dl ' + cls);
      row.appendChild(el('span', 'dl-num', num == null ? '' : String(num)));
      row.appendChild(el('span', 'dl-sign', sign));
      row.appendChild(el('span', 'dl-text', text));
      return row;
    }

    // Renders the -/+ hunk for an Edit. Line numbers come from locating the new
    // text in the file on disk, so they only appear once the edit has landed —
    // which means this runs twice per edit, and the second run must win.
    async function renderEditDiff(entry) {
      const token = (entry.diffToken = (entry.diffToken || 0) + 1);
      const input = entry.input || {};
      const edits = Array.isArray(input.edits) && input.edits.length
        ? input.edits
        : [{ old_string: input.old_string, new_string: input.new_string }];

      let added = 0, removed = 0;

      let fileText = null;
      if (input.file_path && window.fileApi) {
        try {
          const r = await window.fileApi.read(input.file_path);
          if (r && !r.error) fileText = r.content;
        } catch (_) {}
      }
      // A newer render started while we were reading the file — let it own the body.
      if (entry.diffToken !== token) return;

      entry.body.innerHTML = '';
      entry.body.classList.remove('plain');

      for (const edit of edits) {
        const d = lineDiff(edit.old_string, edit.new_string);
        added += d.added.length;
        removed += d.removed.length;

        // Locate the replacement to number the hunk. Falls back to blank numbers.
        let startLine = null;
        if (fileText && edit.new_string) {
          const at = fileText.indexOf(edit.new_string);
          if (at >= 0) startLine = fileText.slice(0, at).split('\n').length;
        }

        const ctxBefore = d.head.slice(-1);
        const ctxAfter = d.tail.slice(0, 1);
        let oldNum = startLine == null ? null : startLine + d.head.length - ctxBefore.length;
        let newNum = oldNum;

        for (const line of ctxBefore) {
          entry.body.appendChild(diffRow('ctx', oldNum, '', line));
          if (oldNum != null) { oldNum++; newNum++; }
        }
        for (const line of d.removed) {
          entry.body.appendChild(diffRow('del', oldNum, '−', line));
          if (oldNum != null) oldNum++;
        }
        for (const line of d.added) {
          entry.body.appendChild(diffRow('add', newNum, '+', line));
          if (newNum != null) newNum++;
        }
        for (const line of ctxAfter) {
          entry.body.appendChild(diffRow('ctx', newNum, '', line));
          if (newNum != null) newNum++;
        }
      }

      entry.metaEl.innerHTML = '';
      entry.metaEl.appendChild(el('span', 'diff-add', '+' + added));
      entry.metaEl.appendChild(document.createTextNode(' '));
      entry.metaEl.appendChild(el('span', 'diff-del', '−' + removed));
      pin();
    }

    // Read returns a tab-separated line gutter ("3\tcharlie") and adds one empty
    // trailing entry for a file's final newline — count real content lines only.
    function resultLineCount(name, text) {
      if (name === 'Read') {
        const rows = String(text).split('\n').filter((l) => /^\s*\d+\t/.test(l));
        if (rows.length) {
          const lastEmpty = /^\s*\d+\t\s*$/.test(rows[rows.length - 1]);
          return rows.length - (lastEmpty ? 1 : 0);
        }
      }
      return lineCount(text);
    }

    function showToolError(entry, text) {
      entry.el.classList.add('open');
      const hasDiff = entry.body.querySelector('.dl');
      if (!hasDiff) {
        entry.body.classList.add('plain');
        entry.body.textContent = text;
        return;
      }
      // Keep the attempted diff visible and say plainly that it didn't land.
      const banner = el('div', 'dl del');
      banner.appendChild(el('span', 'dl-num', ''));
      banner.appendChild(el('span', 'dl-sign', '!'));
      banner.appendChild(el('span', 'dl-text', 'not applied — ' + text.replace(/\s+/g, ' ').trim()));
      entry.body.insertBefore(banner, entry.body.firstChild);
    }

    function finishTool(toolUseId, meta) {
      const entry = toolCards.get(toolUseId);
      if (!entry) return;
      const secs = ((Date.now() - entry.startedAt) / 1000).toFixed(1) + 's';
      entry.timeEl.textContent = secs;
      entry.timeEl.className = 'tool-time' + (meta.isError ? ' err' : '');

      const text = meta.text == null ? '' : String(meta.text);
      const isEdit = entry.name === 'Edit' || entry.name === 'MultiEdit';

      if (meta.isError) {
        showToolError(entry, text);
      } else if (isEdit) {
        // Line numbers come from the post-edit file, so redraw now that it landed.
        renderEditDiff(entry);
      } else if (entry.body.classList.contains('plain')) {
        entry.body.textContent = text || '(no output)';
      }

      if (!entry.metaEl.textContent && !entry.metaEl.children.length && text) {
        const n = resultLineCount(entry.name, text);
        entry.metaEl.textContent = n ? lines(n) : '';
      }
      pin();
    }

    // ---------- permission cards ----------
    function renderPermission(req) {
      const cardEl = el('div', 'perm-card');
      const top = el('div', 'perm-top');
      const dot = el('span', 'perm-dot');
      top.appendChild(dot);
      top.appendChild(el('span', 'perm-title', 'Permission needed'));

      const isShell = req.toolName === 'Bash' || req.toolName === 'PowerShell';
      const sub = el('span', 'perm-sub');
      sub.innerHTML = isShell
        ? `Claude wants to run a command in <span class="mono">${esc(prettyCwd(req.cwd))}</span>`
        : `Claude wants to use <span class="mono">${esc(req.toolName)}</span> in <span class="mono">${esc(prettyCwd(req.cwd))}</span>`;
      top.appendChild(sub);
      cardEl.appendChild(top);

      const cmd = el('div', 'perm-cmd');
      if (isShell) {
        cmd.appendChild(el('span', 'sigil', '$ '));
        cmd.appendChild(document.createTextNode(String(req.input.command || '')));
      } else {
        const target = req.input.file_path || req.input.path || req.input.url || '';
        cmd.textContent = target
          ? `${req.toolName}  ${target}`
          : `${req.toolName}  ${JSON.stringify(req.input).slice(0, 400)}`;
      }
      cardEl.appendChild(cmd);

      const actions = el('div', 'perm-actions');
      const allowOnce = el('button', 'btn primary', 'Allow once');
      actions.appendChild(allowOnce);

      let alwaysBtn = null;
      const ruleLabel = req.ruleKey || req.toolName;
      if (ruleLabel) {
        alwaysBtn = el('button', 'btn', 'Always allow ' + ruleLabel);
        alwaysBtn.title = 'For the rest of this chat pane';
        actions.appendChild(alwaysBtn);
      }
      const denyBtn = el('button', 'btn danger', 'Deny');
      actions.appendChild(denyBtn);
      actions.appendChild(el('span', 'perm-hint', 'Ctrl+Enter allows once'));
      cardEl.appendChild(actions);

      addBlock(cardEl);
      permCards.set(req.permId, cardEl);

      const resolve = (decision, alwaysRule) => {
        if (!permCards.has(req.permId)) return;
        permCards.delete(req.permId);
        window.chatApi.respondPermission({
          permId: req.permId,
          decision,
          alwaysRule: alwaysRule || null
        });
        // The tool's clock should show how long it ran, not how long the card sat
        // waiting for an answer.
        const waiting = req.toolUseId && toolCards.get(req.toolUseId);
        if (waiting) waiting.startedAt = Date.now();
        cardEl.classList.add('resolved');
        dot.classList.add('resolved');
        dot.style.background = decision === 'allow' ? 'var(--green)' : 'var(--red)';
        const verdict = el('span', 'perm-sub', decision === 'allow' ? '· allowed' : '· denied');
        top.appendChild(verdict);
      };

      allowOnce.addEventListener('click', () => resolve('allow'));
      denyBtn.addEventListener('click', () => resolve('deny'));
      if (alwaysBtn) {
        alwaysBtn.addEventListener('click', () => resolve('allow', {
          tool: req.toolName,
          prefix: req.ruleKey || null
        }));
      }

      // Ctrl+Enter allows the newest outstanding card, as the hint says.
      cardEl._macResolve = resolve;
      pin();
    }

    function newestPermCard() {
      let last = null;
      for (const [, node] of permCards) last = node;
      return last;
    }

    // ---------- event handling ----------
    function handleEvent(ev) {
      if (!ev || !ev.type) return;

      if (ev.session_id && ev.session_id !== state.sessionId) {
        state.sessionId = ev.session_id;
        if (opts.onSessionId) opts.onSessionId(ev.session_id);
        refreshStats();
      }

      switch (ev.type) {
        case 'system':      return handleSystem(ev);
        case 'stream_event':return handleStreamEvent(ev);
        case 'assistant':   return handleAssistant(ev);
        case 'user':        return handleUserEvent(ev);
        case 'result':      return handleResult(ev);
        case 'rate_limit_event': return handleRateLimit(ev);
        default: return;
      }
    }

    function handleSystem(ev) {
      if (ev.subtype === 'init') {
        if (Array.isArray(ev.slash_commands)) state.slashCommands = ev.slash_commands;
        // What this pane's CLI actually attached — the authoritative answer to
        // "can the agent use this server here?".
        if (Array.isArray(ev.mcp_servers)) state.sessionMcp = ev.mcp_servers;
        if (ev.model) {
          state.apiModel = ev.model;
          state.contextWindow = ctxWindowFor(ev.model);
        }
        if (ev.cwd) { state.cwd = ev.cwd; cwdEl.textContent = prettyCwd(ev.cwd); cwdEl.title = ev.cwd; }
        refreshStats();
      } else if (ev.subtype === 'permission_denied') {
        // The CLI denied on its own (e.g. the hook timed out or the gate was down).
        const node = el('div', 'msg-error');
        node.textContent = `${ev.tool_name || 'Tool'} was not run: ${ev.message || ev.decision_reason || 'permission denied'}`;
        addBlock(node);
      } else if (ev.subtype === 'error') {
        const node = el('div', 'msg-error', String(ev.message || 'error'));
        addBlock(node);
      }
    }

    function handleRateLimit(ev) {
      const info = ev.rate_limit_info || {};
      if (info.status && info.status !== 'allowed') {
        const node = el('div', 'msg-error');
        const resets = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : 'later';
        node.textContent = `Rate limit ${info.status} (${info.rateLimitType || 'limit'}) — resets ${resets}.`;
        addBlock(node);
      }
    }

    function handleStreamEvent(ev) {
      const inner = ev.event || {};
      if (inner.type === 'message_start') {
        currentMessageId = inner.message && inner.message.id;
        if (currentMessageId) {
          // The previous message has been reconciled by now, so drop its
          // bookkeeping rather than let it accumulate across the session.
          streamNodes.clear();
          blockEls.clear();
          streamNodes.set(currentMessageId, []);
          blockEls.set(currentMessageId, new Map());
        }
        setWorking(true);
        return;
      }
      if (!currentMessageId) return;
      const list = streamNodes.get(currentMessageId);
      const els = blockEls.get(currentMessageId);
      if (!list || !els) return;

      if (inner.type === 'content_block_start') {
        const type = inner.content_block && inner.content_block.type;
        if (type === 'text' || type === 'thinking') {
          const node = el('div', type === 'text' ? 'msg-assistant' : 'msg-thinking');
          node._raw = '';
          els.set(inner.index, node);
          list.push({ type, node, reconciled: false });
          addBlock(node);
        }
        return;
      }
      if (inner.type === 'content_block_delta') {
        const node = els.get(inner.index);
        if (!node) return;
        const d = inner.delta || {};
        const chunk = d.type === 'text_delta' ? d.text
          : d.type === 'thinking_delta' ? d.thinking
          : '';
        if (!chunk) return;
        setBlockText(node, (node._raw || '') + chunk);
        pin();
        return;
      }
    }

    function setBlockText(node, text) {
      node._raw = text;
      if (node.classList.contains('msg-assistant')) renderMarkdown(node, text);
      else node.textContent = text;
    }

    function handleAssistant(ev) {
      const msg = ev.message || {};
      const id = msg.id;
      const list = (id && streamNodes.get(id)) || null;

      if (msg.model) {
        state.apiModel = msg.model;
        state.contextWindow = ctxWindowFor(msg.model);
      }
      if (msg.usage) {
        const u = msg.usage;
        state.contextTokens = (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
      }

      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (block.type === 'text' || block.type === 'thinking') {
          const text = block.type === 'text' ? block.text : block.thinking;
          // Claim the next streamed node of the same type; snapshots arrive in
          // stream order, so the Nth text block matches the Nth streamed text node.
          const slot = list && list.find((s) => s.type === block.type && !s.reconciled);
          if (slot) {
            slot.reconciled = true;
            if (text != null) setBlockText(slot.node, text);
            continue;
          }
          if (!text) continue;
          // Nothing streamed for this block (deltas were shed, or it arrived
          // buffered only) — render it fresh.
          const node = el('div', block.type === 'text' ? 'msg-assistant' : 'msg-thinking');
          setBlockText(node, text);
          addBlock(node);
          if (list) list.push({ type: block.type, node, reconciled: true });
        } else if (block.type === 'tool_use') {
          if (block.id && toolCards.has(block.id)) continue;
          renderToolUse(block);
        }
      }

      setWorking(true);
      refreshStats();
    }

    function handleUserEvent(ev) {
      const msg = ev.message || {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const metaById = new Map();
      for (const m of (ev.tool_result_meta || [])) metaById.set(m.id, m);

      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        let text = block.content;
        if (Array.isArray(text)) {
          text = text.map((c) => (c && c.type === 'text' ? c.text : '')).join('');
        }
        if (text == null) text = ev.tool_use_result || '';
        finishTool(block.tool_use_id, {
          isError: !!block.is_error,
          text,
          meta: metaById.get(block.tool_use_id) || null
        });
      }
    }

    function handleResult(ev) {
      if (typeof ev.total_cost_usd === 'number') state.cost += ev.total_cost_usd;
      // An interrupted turn ends as an error by design — report it as a stop, not
      // as something that went wrong.
      const stopped = state.interrupting;
      if (stopped) {
        state.interrupting = false;
        addBlock(el('div', 'msg-thinking', 'Turn stopped.'));
      }
      if (ev.usage) {
        const u = ev.usage;
        const ctx = (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
        if (ctx) state.contextTokens = ctx;
      }
      if (ev.is_error && !stopped) {
        const node = el('div', 'msg-error', String(ev.result || 'The turn ended with an error.'));
        addBlock(node);
      }
      // Any tool still marked pending will never resolve now.
      for (const [, entry] of toolCards) {
        if (entry.timeEl.classList.contains('pending')) {
          entry.timeEl.className = 'tool-time err';
          entry.timeEl.textContent = '—';
        }
      }
      currentMessageId = null;
      setWorking(false);
      refreshStats();
    }

    function handleStderr(text) {
      const t = String(text || '').trim();
      if (!t) return;
      const node = el('div', 'msg-error', t);
      addBlock(node);
    }

    function handleExit(code) {
      state.working = false;
      state.interrupting = false;
      currentMessageId = null;
      for (const [permId] of permCards) {
        const node = permCards.get(permId);
        if (node && node._macResolve) node._macResolve('deny');
      }
      permCards.clear();
      state.exited = true;
      addBlock(el('div', 'msg-error',
        code === 0 ? 'Claude session ended. Send a message to start a new one.'
                   : `Claude exited (code ${code}). Send a message to restart.`));
      refreshStats();
    }

    // ---------- attachments ----------
    const attachments = []; // { kind:'image'|'range', label, base64, mediaType, path, text }

    function renderAttachments() {
      attachRow.innerHTML = '';
      attachRow.classList.toggle('show', attachments.length > 0);
      attachments.forEach((att, i) => {
        const chip = el('div', 'chip' + (att.kind === 'image' ? ' file' : ''));
        if (att.kind === 'image') {
          const thumb = document.createElement('img');
          thumb.className = 'chip-thumb';
          thumb.src = `data:${att.mediaType};base64,${att.base64}`;
          chip.appendChild(thumb);
          chip.appendChild(el('span', 'chip-label', att.label));
        } else {
          chip.appendChild(el('span', null, '🟨'));
          chip.appendChild(el('span', 'chip-label mono', att.label));
        }
        const x = el('span', 'chip-x', '✕');
        x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
        chip.appendChild(x);
        attachRow.appendChild(chip);
      });
    }

    async function addImageFile(file) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const base64 = btoa(bin);
      const mediaType = file.type || 'image/png';
      const ext = (mediaType.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const saved = await window.chatApi.saveAttachment({ base64, ext });
      attachments.push({
        kind: 'image',
        label: file.name || (saved && saved.name) || 'screenshot.png',
        base64, mediaType,
        path: saved && saved.path ? saved.path : null
      });
      renderAttachments();
    }

    function addRangeAttachment(label, text) {
      attachments.push({ kind: 'range', label, text });
      renderAttachments();
    }

    input.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { e.preventDefault(); addImageFile(file); }
        }
      }
    });
    imageBtn.addEventListener('click', () => filePicker.click());
    filePicker.addEventListener('change', async () => {
      for (const file of filePicker.files) await addImageFile(file);
      filePicker.value = '';
    });
    root.addEventListener('dragover', (e) => { e.preventDefault(); });
    root.addEventListener('drop', async (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith('image/')) await addImageFile(file);
      }
    });

    // ---------- composer input, undo, palette ----------
    // Chunk-level undo, matching the terminal's Ctrl+Z: a burst of typing collapses
    // into one chunk, so one undo removes a word or a paste rather than a keystroke.
    const undoStack = [];
    let undoPending = '';
    let undoTimer = null;

    function flushUndo() {
      if (undoPending) { undoStack.push(undoPending); undoPending = ''; }
      if (undoStack.length > 200) undoStack.shift();
    }
    function trackUndo(prev) {
      if (undoPending === '') undoPending = prev;
      clearTimeout(undoTimer);
      undoTimer = setTimeout(flushUndo, 400);
    }
    function undo() {
      flushUndo();
      const prev = undoStack.pop();
      if (prev == null) return;
      input.value = prev;
      autoGrow();
    }
    undoBtn.addEventListener('click', () => { undo(); input.focus(); });

    let lastValue = '';
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(260, Math.max(44, input.scrollHeight)) + 'px';
    }
    input.addEventListener('input', () => {
      trackUndo(lastValue);
      lastValue = input.value;
      autoGrow();
      syncPalette();
    });
    input.addEventListener('focus', () => composer.classList.add('focused'));
    input.addEventListener('blur', () => composer.classList.remove('focused'));

    // Palette: app commands first (they act on the pane), then the CLI's own.
    const appCommands = Array.isArray(opts.commands) ? opts.commands : [];
    let paletteItems = [];
    let paletteIndex = 0;

    function paletteRows(filter) {
      // Pane-local commands first, then whatever the app registered, then the CLI's
      // own slash commands (which only arrive with the first `init` event).
      const rows = [
        {
          cmd: '/terminal', desc: 'Toggle a shell in this folder', key: 'Ctrl+`',
          run: () => { setDrawer(!drawerOpen); if (drawerOpen && optsFn('onTerminalFocus')) opts.onTerminalFocus(); }
        },
        {
          cmd: '/mcp', desc: 'Manage MCP servers for this folder', key: '',
          run: () => setMcpOpen(true)
        }
      ];
      for (const c of appCommands) {
        rows.push({ cmd: c.cmd, desc: c.desc, key: c.key || '', run: c.run });
      }
      for (const name of state.slashCommands) {
        rows.push({ cmd: '/' + name, desc: 'Claude command', key: '', run: null });
      }
      const f = (filter || '').toLowerCase();
      return f ? rows.filter((r) => r.cmd.toLowerCase().startsWith(f)) : rows;
    }

    function showPalette(filter) {
      paletteItems = paletteRows(filter);
      if (!paletteItems.length) { hidePalette(); return; }
      paletteIndex = 0;
      palette.innerHTML = '';
      palette.appendChild(el('div', 'palette-hdr', 'Commands'));
      paletteItems.forEach((row, i) => {
        const item = el('div', 'palette-item' + (i === 0 ? ' sel' : ''));
        item.appendChild(el('span', 'palette-cmd', row.cmd));
        item.appendChild(el('span', 'palette-desc', row.desc));
        if (row.key) item.appendChild(el('span', 'palette-key', row.key));
        item.addEventListener('mouseenter', () => setPaletteIndex(i));
        item.addEventListener('click', () => runPalette(i));
        palette.appendChild(item);
      });
      palette.classList.add('show');
    }
    function hidePalette() { palette.classList.remove('show'); paletteItems = []; }
    function setPaletteIndex(i) {
      paletteIndex = i;
      Array.from(palette.querySelectorAll('.palette-item'))
        .forEach((node, n) => node.classList.toggle('sel', n === i));
    }
    function syncPalette() {
      const v = input.value;
      if (v.startsWith('/') && !v.includes('\n')) showPalette(v.trim());
      else hidePalette();
    }
    function runPalette(i) {
      const row = paletteItems[i];
      if (!row) return;
      hidePalette();
      if (row.run) {
        input.value = '';
        lastValue = '';
        autoGrow();
        row.run();
      } else {
        // A CLI slash command is just message text.
        input.value = row.cmd + ' ';
        lastValue = input.value;
        autoGrow();
        input.focus();
      }
    }
    cmdBtn.addEventListener('click', () => {
      if (palette.classList.contains('show')) { hidePalette(); return; }
      if (!input.value.startsWith('/')) {
        input.value = '/';
        lastValue = '/';
        autoGrow();
      }
      input.focus();
      showPalette(input.value.trim());
    });

    input.addEventListener('keydown', (e) => {
      if (palette.classList.contains('show')) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIndex((paletteIndex + 1) % paletteItems.length); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); setPaletteIndex((paletteIndex - 1 + paletteItems.length) % paletteItems.length); return; }
        if (e.key === 'Tab')       { e.preventDefault(); runPalette(paletteIndex); return; }
        if (e.key === 'Escape')    { e.preventDefault(); hidePalette(); return; }
        if (e.key === 'Enter' && !e.shiftKey && paletteItems[paletteIndex] && paletteItems[paletteIndex].run) {
          e.preventDefault(); runPalette(paletteIndex); return;
        }
      }
      if (e.key === 'Enter' && e.ctrlKey) {
        const card = newestPermCard();
        if (card && card._macResolve) { e.preventDefault(); card._macResolve('allow'); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === 'Escape' && mcp.isOpen()) { e.preventDefault(); setMcpOpen(false); return; }
      if (e.key === 'Escape' && state.working) { e.preventDefault(); interrupt(); }
      // Ctrl+Z arrives from the main process via window.shortcuts; renderer.js
      // routes it here when this pane is active.
      e.stopPropagation();
    });

    // ---------- picker menus ----------
    function openMenu(anchor, items) {
      if (!opts.showMenu) return;
      const r = anchor.getBoundingClientRect();
      opts.showMenu(r.left, r.top, items);
    }

    permPill.addEventListener('click', () => {
      const defaultMode = opts.getDefaultPermissionMode ? opts.getDefaultPermissionMode() : 'default';
      const items = PERM_MODES.map((m) => ({
        label: 'Permissions: ' + m.label,
        hint: m.id === state.permissionMode ? 'current'
            : m.id === defaultMode ? 'default'
            : m.hint,
        action: async () => {
          state.permissionMode = m.id;
          await window.chatApi.setPermissionMode({ chatId: state.chatId, mode: m.id });
          refreshStats();
        }
      }));
      if (opts.onDefaultPermissionMode) {
        const current = PERM_MODES.find((m) => m.id === state.permissionMode) || PERM_MODES[0];
        items.push({ separator: true });
        items.push({
          label: state.permissionMode === defaultMode
            ? `${current.pill} is the default for new panes`
            : `Use ${current.pill} for new panes`,
          disabled: state.permissionMode === defaultMode,
          action: () => opts.onDefaultPermissionMode(state.permissionMode)
        });
      }
      openMenu(permPill, items);
    });

    modelBtn.addEventListener('click', () => {
      openMenu(modelBtn, MODELS.map((m) => ({
        label: m.label,
        hint: m.id === state.model ? 'current' : '',
        action: () => {
          if (m.id === state.model) return;
          state.model = m.id;
          refreshStats();
          if (opts.onModelChange) opts.onModelChange(m.id);
        }
      })));
    });

    // ---------- send ----------
    async function submit() {
      if (state.working) { interrupt(); return; }
      if (state.exited) {
        if (opts.onRestart) opts.onRestart();
        return;
      }
      const text = input.value.trim();
      if (!text && !attachments.length) return;

      const content = [];
      for (const att of attachments) {
        if (att.kind === 'image') {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: att.mediaType, data: att.base64 }
          });
        } else if (att.text) {
          content.push({ type: 'text', text: att.text });
        }
      }
      if (text) content.push({ type: 'text', text });

      // Echo the user's turn immediately; --replay-user-messages would echo it back
      // too, but only after the CLI has picked it up.
      const bubble = el('div', 'msg-user');
      const label = attachments.length
        ? attachments.map((a) => a.label).join(', ') + (text ? '\n' : '')
        : '';
      renderMarkdown(bubble, label + text);
      addBlock(bubble);

      const res = await window.chatApi.send({ chatId: state.chatId, content });
      if (res && res.error) {
        handleStderr('Could not send: ' + res.error);
        return;
      }
      flushUndo();
      input.value = '';
      lastValue = '';
      autoGrow();
      attachments.length = 0;
      renderAttachments();
      hidePalette();
      setWorking(true);
    }

    async function interrupt() {
      if (state.interrupting) return;
      state.interrupting = true;
      const res = await window.chatApi.interrupt({ chatId: state.chatId });
      if (res && res.error) {
        state.interrupting = false;
        handleStderr('Could not interrupt: ' + res.error);
        return;
      }
      setWorking(false);
    }

    sendBtn.addEventListener('click', submit);
    termBtn.addEventListener('click', () => {
      setDrawer(!drawerOpen);
      if (drawerOpen && optsFn('onTerminalFocus')) opts.onTerminalFocus();
      else input.focus();
    });

    // ---------- controller ----------
    refreshStats();
    autoGrow();

    return {
      el: root,
      chatId: state.chatId,
      focus() { input.focus(); },
      setName(name) { state.name = name; nameEl.textContent = name; },
      setActive(on) { root.classList.toggle('active', !!on); },
      handleEvent,
      handleStderr,
      handleExit,
      handlePermission: renderPermission,
      addRangeAttachment,
      undo,
      getState,
      // terminal drawer
      toggleTerminal() {
        setDrawer(!drawerOpen);
        if (drawerOpen && optsFn('onTerminalFocus')) opts.onTerminalFocus();
        else input.focus();
      },
      isTerminalOpen: () => drawerOpen,
      // Used when the shell exits on its own: hide the drawer and let the next open
      // start a fresh one.
      terminalEnded() {
        drawerStarted = false;
        setDrawer(false);
      },
      terminalHasFocus: () => drawer.contains(document.activeElement),
      terminalMount: () => drawerBody,
      setTerminalCwd(p) { drawerCwd.textContent = prettyCwd(p); },
      // MCP panel
      openMcp: () => setMcpOpen(true),
      closeMcp: () => setMcpOpen(false),
      isMcpOpen: () => mcp.isOpen(),
      get sessionId() { return state.sessionId; },
      get model() { return state.model; },
      dispose() {
        for (const [permId] of permCards) {
          window.chatApi.respondPermission({ permId, decision: 'deny' });
        }
        permCards.clear();
      }
    };
  }

  window.createChatView = createChatView;
  window.CHAT_MODELS = MODELS;
})();
