// Frequently used repos: a use counter per git repo, kept in localStorage by renderer.js.
// Pure (no DOM, no storage) so it can be unit-tested; every function takes the state
// and returns a new one. Counts are keyed by the repo's main clone, so worktrees add
// to the clone they belong to.
//
// State: { v: 1, items: { <lowercased path>: { path, repo (owner/name | null), count, last } } }
(() => {
  'use strict';

  const MAX_ITEMS = 60;
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

  const keyOf = (p) => String(p).toLowerCase();
  const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

  // Most used first, ties by most recent.
  const byScore = (a, b) => b.count - a.count || b.last - a.last;

  // Past the cap the lowest count (then the oldest use) is dropped.
  function capItems(state) {
    const keys = Object.keys(state.items);
    if (keys.length <= MAX_ITEMS) return state;
    const keep = keys.map((k) => state.items[k]).sort(byScore).slice(0, MAX_ITEMS);
    const items = Object.create(null);
    for (const it of keep) items[keyOf(it.path)] = it;
    return { v: 1, items };
  }

  // Garbage in, empty state out; entries that don't look right are dropped, the rest kept.
  function normalize(state) {
    const items = Object.create(null);
    const src = state && typeof state === 'object' && state.items && typeof state.items === 'object' ? state.items : {};
    for (const k of Object.keys(src)) {
      const it = src[k];
      if (!it || typeof it !== 'object' || typeof it.path !== 'string' || !it.path.trim()) continue;
      const count = Number.isFinite(it.count) ? Math.floor(it.count) : 0;
      if (count < 1) continue;
      const entry = {
        path: it.path,
        repo: typeof it.repo === 'string' && REPO_RE.test(it.repo) ? it.repo : null,
        count,
        last: Number.isFinite(it.last) ? it.last : 0
      };
      const key = keyOf(entry.path);
      const prev = items[key];
      if (!prev || entry.count > prev.count) items[key] = entry;
    }
    return capItems({ v: 1, items });
  }

  // +1 for `path` (the main clone's folder). `repo` is the GitHub owner/name when known.
  function recordUse(state, use, now = Date.now()) {
    const { path, repo } = use && typeof use === 'object' ? use : {};
    const cur = normalize(state);
    if (typeof path !== 'string' || !path.trim()) return cur;
    const key = keyOf(path);
    const prev = cur.items[key];
    const repoOk = typeof repo === 'string' && REPO_RE.test(repo) ? repo : null;
    cur.items[key] = {
      path: prev ? prev.path : path,
      repo: repoOk || (prev ? prev.repo : null),
      count: (prev ? prev.count : 0) + 1,
      last: now
    };
    return capItems(cur);
  }

  function removeUse(state, path) {
    const cur = normalize(state);
    if (typeof path === 'string') delete cur.items[keyOf(path)];
    return cur;
  }

  // Entries sorted by use. A filter matches the folder name, the repo and the path.
  function topUses(state, { filter = '', limit = 15 } = {}) {
    const f = String(filter || '').trim().toLowerCase();
    const cur = normalize(state);
    let list = Object.keys(cur.items).map((k) => cur.items[k]);
    if (f) {
      list = list.filter((it) =>
        baseName(it.path).toLowerCase().includes(f) ||
        (it.repo && it.repo.toLowerCase().includes(f)) ||
        it.path.toLowerCase().includes(f));
    }
    list.sort(byScore);
    return Number.isFinite(limit) && limit >= 0 ? list.slice(0, limit) : list;
  }

  const api = { MAX_ITEMS, normalize, recordUse, removeUse, topUses, baseName };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.repoUsage = api;
})();
