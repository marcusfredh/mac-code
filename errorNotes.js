// Mac Code's own errors become notes in the Mac-Code repo's notepad.
//
// Pure (no requires, no DOM, no Electron, no I/O) so it loads first in the main process
// (`require`) and in the renderer (<script> -> window.errorNotes), and is unit-testable.
// main.js does the file I/O, notesView.js owns the notes store; this module only
// formats an error and applies it to the notes data object.
(function (root) {
  'use strict';

  const REPO_KEY = 'gh:marcusfredh/mac-code';
  const REPO_NAME = 'marcusfredh/Mac-Code';
  const TEXT_CAP = 1500;
  const MESSAGE_CAP = 600;
  const STACK_LINES = 5;
  const STACK_CAP = 64 * 1024;
  const MAX_OPEN = 30;          // open auto error items per repo
  const MAX_TOTAL = 50;         // auto error items in total (open + done)
  const MAX_NEW_PER_SESSION = 20;
  const BUMP_MIN_MS = 60 * 1000;          // same fingerprint is written at most once per minute
  const REOPEN_MIN_MS = 10 * 60 * 1000;   // a bump reopens a done item only after this quiet time

  const str = (v) => (v == null ? '' : String(v));
  const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // User home -> ~ (both slash styles, any case); any C:\Users\<name> is also folded so a
  // record built without a known home still doesn't carry the user name.
  function shortenPaths(s, home) {
    let out = str(s);
    if (home) {
      const h = str(home).replace(/[\\/]+$/, '');
      if (h) {
        const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\|\//g, '[\\\\/]');
        out = out.replace(new RegExp(esc, 'gi'), '~');
      }
    }
    return out.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s)'":]+/gi, '~');
  }

  function stackFrames(stack, home) {
    const lines = str(stack).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    const frames = lines.filter((l) => /^at\s/.test(l) || /@\S/.test(l));
    const picked = frames.length ? frames : lines.slice(1);
    return picked.map((l) => shortenPaths(l, home));
  }

  // Small stable string hash (djb2) — fingerprints stay short and storable.
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Same bug -> same fingerprint: digits are normalised (ports, ids, line numbers, times).
  function fingerprint(rec) {
    const r = rec || {};
    const frames = Array.isArray(r.frames) ? r.frames : stackFrames(r.stack, null);
    const first = str(frames[0]).replace(/:\d+(:\d+)?\)?$/, '').replace(/\d+/g, '#');
    const msg = str(r.message).replace(/\d+/g, '#').slice(0, 300);
    return hash([str(r.source), str(r.name), msg, first].join('|'));
  }

  // -> { source, name, message, stack, text, fingerprint, at }
  function formatError(input) {
    const o = input || {};
    const err = o.error != null ? o.error : o.reason;
    let name = str(o.name), message = str(o.message), stack = str(o.stack);
    if (err && typeof err === 'object') {
      name = name || str(err.name);
      message = message || str(err.message);
      stack = stack || str(err.stack);
    } else if (err != null) {
      message = message || str(err);
    }
    if (!name) name = 'Error';
    if (!message && !stack && err == null && o.extra) message = str(o.extra);
    const home = o.home || null;
    const source = str(o.source) || 'main';
    const at = Number.isFinite(o.now) ? o.now : Date.now();
    message = shortenPaths(message, home);
    stack = cap(shortenPaths(stack, home), STACK_CAP);
    const frames = stackFrames(stack, home);

    const head = '⚠ Mac Code-fel (' + source + '): ' + name + ': ' + cap(message, MESSAGE_CAP);
    const tail = (o.version ? 'v' + o.version + ' · ' : '') + new Date(at).toISOString();
    let keep = frames.slice(0, STACK_LINES);
    const build = () => [head].concat(keep, [tail]).join('\n');
    let text = build();
    while (text.length > TEXT_CAP && keep.length) { keep = keep.slice(0, -1); text = build(); }
    if (text.length > TEXT_CAP) text = cap(head, TEXT_CAP - tail.length - 1) + '\n' + tail;

    const rec = { source, name, message, stack, text, at };
    rec.fingerprint = fingerprint({ source, name, message, frames });
    return rec;
  }

  // Noise that is not a Mac Code bug. Works on raw (renderer) and formatted records;
  // renderer records carry `filename` and `hasError` (false for a bare ErrorEvent).
  function shouldIgnore(rec) {
    const r = rec || {};
    const msg = str(r.message);
    if (/^ResizeObserver loop/.test(msg)) return true;
    if (r.hasError === false && !r.filename && !str(r.stack)) return true;
    if (/^Script error\.?$/.test(msg) && !str(r.stack)) return true;
    if (r.filename && !/^file:/i.test(str(r.filename))) return true;
    const stack = str(r.stack);
    if (/(chrome-extension|devtools|chrome|extensions):\/\//i.test(stack) && !/file:\/\//i.test(stack)) return true;
    return false;
  }

  const isAuto = (it) => it && it.auto === 'error';
  const isRec = (v) => v && typeof v === 'object';

  // Applies one formatted record to the notes data (mutates and returns it).
  // -> { data, added, changed }. `added`: a new item was created. `changed`: something
  // that has to be saved changed (a throttled bump only accumulates in `pending`).
  // opts.session = { added: 0 } carries the per-session new-item counter (storm guard).
  function addErrorToNotes(data, record, opts) {
    const o = opts || {};
    const key = o.repoKey || REPO_KEY;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const newId = typeof o.newId === 'function' ? o.newId
      : () => now.toString(36) + Math.random().toString(36).slice(2, 7);
    const d = isRec(data) ? data : { version: 1, repos: {} };
    if (!isRec(d.repos)) d.repos = {};
    if (!isRec(record) || !record.text || !record.fingerprint) return { data: d, added: false, changed: false };

    let repo = d.repos[key];
    if (!isRec(repo)) {
      repo = d.repos[key] = { name: o.repoName || REPO_NAME, scratch: '', stages: ['dev', 'prod'], items: [] };
    }
    if (!Array.isArray(repo.items)) repo.items = [];
    if (!Array.isArray(repo.stages) || !repo.stages.length) repo.stages = ['dev', 'prod'];
    const items = repo.items;

    const hit = items.find((it) => isAuto(it) && it.fingerprint === record.fingerprint);
    if (hit) {
      const lastBump = Number.isFinite(hit.lastBump) ? hit.lastBump : (hit.lastSeen || hit.updated || hit.created || 0);
      if (now - lastBump < BUMP_MIN_MS) {
        hit.pending = (hit.pending || 0) + 1;
        return { data: d, added: false, changed: false };
      }
      hit.count = (Number.isFinite(hit.count) ? hit.count : 1) + 1 + (hit.pending || 0);
      hit.pending = 0;
      if (hit.done && now - lastBump >= REOPEN_MIN_MS) hit.done = false;
      hit.lastSeen = now;
      hit.updated = now;
      hit.lastBump = now;
      return { data: d, added: false, changed: true };
    }

    const session = o.session;
    if (session && session.added >= MAX_NEW_PER_SESSION) return { data: d, added: false, changed: false };
    if (session) session.added++;

    items.unshift({
      id: newId(), text: record.text, branch: null, done: false, stages: {}, created: now, updated: now,
      auto: 'error', fingerprint: record.fingerprint, count: 1, lastSeen: now, lastBump: now, pending: 0
    });

    // Newest first, so the oldest of a kind is the last one in the array.
    const dropLast = (pred) => {
      for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) { items.splice(i, 1); return true; }
      return false;
    };
    const count = (pred) => items.filter(pred).length;
    while (count((it) => isAuto(it) && !it.done) > MAX_OPEN) {
      if (!dropLast((it) => isAuto(it) && !it.done)) break;
    }
    while (count(isAuto) > MAX_TOTAL) {
      if (!dropLast((it) => isAuto(it) && it.done) && !dropLast(isAuto)) break;
    }
    return { data: d, added: true, changed: true };
  }

  const api = {
    REPO_KEY, REPO_NAME, TEXT_CAP, MAX_OPEN, MAX_TOTAL, MAX_NEW_PER_SESSION, BUMP_MIN_MS, REOPEN_MIN_MS,
    shortenPaths, fingerprint, formatError, shouldIgnore, addErrorToNotes
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.errorNotes = api;
})(typeof window !== 'undefined' ? window : this);
